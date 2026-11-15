import fs from 'node:fs';
import path from 'node:path';
import { NmsvsError } from '../../core/errors';
import { backupFile, ensureDir, readJson, writeJsonAtomic } from '../../core/fsx';
import { hashFileSync } from '../../core/hash';
import { slugify, toPosixRel } from '../../core/paths';
import { ffprobeJson } from '../../core/tools';
import type { RunContext } from '../../core/context';
import { FILES } from '../../model/project';
import type { AssetsFile, ImageAsset, ProjectFile } from '../../model/types';
import { parseLyricsText } from '../lyrics/parse';
import { addDecision } from './init';

const AUDIO_EXT = ['.wav', '.flac', '.mp3', '.aif', '.aiff', '.m4a', '.ogg'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'];

/**
 * Copie un fichier source dans media/<sub>/ sans jamais modifier l'original.
 * Si le fichier est déjà dans le dossier du projet, il est simplement référencé.
 */
function bringIn(projectDir: string, src: string, sub: string): string {
  const abs = path.resolve(src);
  if (!fs.existsSync(abs)) throw new NmsvsError('E_ASSET_MISSING', `Fichier introuvable : ${src}`);
  if (abs.toLowerCase().startsWith(path.resolve(projectDir).toLowerCase() + path.sep)) return abs;
  const destDir = path.join(projectDir, 'media', sub);
  ensureDir(destDir);
  let dest = path.join(destDir, path.basename(abs));
  if (fs.existsSync(dest)) {
    if (hashFileSync(dest) === hashFileSync(abs)) return dest; // déjà importé
    const ext = path.extname(abs);
    let n = 2;
    while (fs.existsSync(dest)) dest = path.join(destDir, `${path.basename(abs, ext)}-${n++}${ext}`);
  }
  fs.copyFileSync(abs, dest, fs.constants.COPYFILE_EXCL);
  return dest;
}

export async function importAudio(ctx: RunContext, projectDir: string, src: string) {
  if (!AUDIO_EXT.includes(path.extname(src).toLowerCase())) throw new NmsvsError('E_ARGS', `Extension audio non prise en charge : ${src}`);
  const dest = bringIn(projectDir, src, 'audio');
  const probe = await ffprobeJson(dest);
  const a = probe.streams.find((s: any) => s.codec_type === 'audio');
  if (!a) throw new NmsvsError('E_ASSET_MISSING', `Aucune piste audio dans ${src}`);
  const duration = Number(probe.format.duration);
  if (duration < 5) throw new NmsvsError('E_ARGS', `Audio trop court (${duration.toFixed(1)} s).`);
  const lossy = ['mp3', 'aac', 'vorbis', 'opus'].includes(a.codec_name);
  if (lossy) ctx.warn('W_AUDIO_LOSSY', `Master avec perte (${a.codec_name}) : un WAV/FLAC est préférable pour l’export.`);
  if (![44100, 48000].includes(Number(a.sample_rate))) ctx.warn('W_AUDIO_RATE', `Fréquence inhabituelle : ${a.sample_rate} Hz.`);
  const pFile = path.join(projectDir, FILES.project);
  const project = readJson<ProjectFile>(pFile);
  backupFile(pFile);
  project.audio.master = toPosixRel(projectDir, dest);
  writeJsonAtomic(pFile, project);
  addDecision(projectDir, { by: 'user', via: 'nmsvs import audio', decision: `Audio maître : ${project.audio.master}` });
  return { path: project.audio.master, sha256: hashFileSync(dest), durationSec: duration, sampleRate: Number(a.sample_rate), channels: a.channels, codec: a.codec_name };
}

export function importLyrics(ctx: RunContext, projectDir: string, src: string, opts: { force?: boolean; language?: string }) {
  const abs = path.resolve(src);
  if (!fs.existsSync(abs)) throw new NmsvsError('E_ASSET_MISSING', `Fichier introuvable : ${src}`);
  const text = fs.readFileSync(abs, 'utf8');
  const { lyrics, warnings } = parseLyricsText(text, opts.language ?? 'fr');
  const project = readJson<ProjectFile>(path.join(projectDir, FILES.project));
  const out = path.join(projectDir, ...project.lyrics.split('/'));
  if (fs.existsSync(out) && !opts.force) {
    throw new NmsvsError('E_LOCKED_FILE', `${project.lyrics} existe déjà (fichier humain, peut contenir des modifications).`, 'Relancer avec --force (une sauvegarde .bak sera créée).');
  }
  backupFile(out);
  const sourceCopy = path.join(projectDir, 'lyrics', 'source.txt');
  if (path.resolve(sourceCopy) !== abs) {
    ensureDir(path.dirname(sourceCopy));
    backupFile(sourceCopy);
    fs.copyFileSync(abs, sourceCopy);
  }
  lyrics.$schema = 'https://nmsvs.local/schemas/lyrics/v1.json';
  writeJsonAtomic(out, lyrics);
  for (const w of warnings) ctx.warn('W_LYRICS', `ligne ${w.line} : ${w.message}`);
  addDecision(projectDir, { by: 'user', via: 'nmsvs import lyrics', decision: `Paroles importées (${lyrics.sections.length} sections)` });
  return { sections: lyrics.sections.map((s) => ({ id: s.id, kind: s.kind, lines: s.lines.length, repeatOf: s.repeatOf })), warnings };
}

export async function probeImage(file: string): Promise<{ w: number; h: number }> {
  const p = await ffprobeJson(file);
  const v = p.streams.find((s: any) => s.codec_type === 'video');
  if (!v) throw new NmsvsError('E_ASSET_MISSING', `Image illisible : ${file}`);
  return { w: v.width, h: v.height };
}

/** Facteur d'agrandissement nécessaire pour couvrir un cadre (sans marge de mouvement). */
export function coverUpscale(img: { w: number; h: number }, frame: { width: number; height: number }) {
  return Math.max(frame.width / img.w, frame.height / img.h);
}

export async function importImages(ctx: RunContext, projectDir: string, srcs: string[], kind: 'images' | 'textures' = 'images') {
  const files: string[] = [];
  for (const s of srcs) {
    const abs = path.resolve(s);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      for (const f of fs.readdirSync(abs).sort()) if (IMAGE_EXT.includes(path.extname(f).toLowerCase())) files.push(path.join(abs, f));
    } else files.push(abs);
  }
  if (!files.length) throw new NmsvsError('E_ARGS', 'Aucune image à importer.');
  const aFile = path.join(projectDir, FILES.assets);
  const assets = readJson<AssetsFile>(aFile);
  const project = readJson<ProjectFile>(path.join(projectDir, FILES.project));
  const maxUp = project.art.maxUpscale ?? 1.5;
  const added: { id: string; path: string; size: { w: number; h: number }; warnings: string[] }[] = [];
  const list = kind === 'images' ? assets.images : (assets.textures ??= []);
  for (const f of files) {
    if (!IMAGE_EXT.includes(path.extname(f).toLowerCase())) throw new NmsvsError('E_ARGS', `Extension image non prise en charge : ${f}`);
    const dest = bringIn(projectDir, f, kind);
    const rel = toPosixRel(projectDir, dest);
    const sha = hashFileSync(dest);
    const size = await probeImage(dest);
    const existing = list.find((i) => i.path === rel);
    const warnings: string[] = [];
    if (kind === 'images') {
      for (const [fmt, spec] of Object.entries(project.formats)) {
        const up = coverUpscale(size, spec) * 1.1; // marge de mouvement typique
        if (up > maxUp) warnings.push(`${fmt} : agrandissement ${up.toFixed(2)}× > ${maxUp}× (résolution insuffisante)`);
        else if (up > 1.2) warnings.push(`${fmt} : agrandissement ${up.toFixed(2)}× (acceptable, netteté réduite)`);
      }
    }
    if (existing) {
      existing.sha256 = sha;
      if ('size' in existing || kind === 'images') (existing as ImageAsset).size = size;
      added.push({ id: existing.id, path: rel, size, warnings });
    } else {
      let id = slugify(path.basename(dest, path.extname(dest)));
      if (kind === 'images' && !/^img-/.test(id)) id = `img-${id}`;
      const taken = new Set([...assets.images.map((i) => i.id), ...(assets.textures ?? []).map((t) => t.id)]);
      let uid = id;
      for (let n = 2; taken.has(uid); n++) uid = `${id}-${n}`;
      if (kind === 'images') assets.images.push({ id: uid, path: rel, sha256: sha, size, focal: { x: 0.5, y: 0.5 } });
      else (assets.textures ??= []).push({ id: uid, path: rel, sha256: sha });
      added.push({ id: uid, path: rel, size, warnings });
    }
    for (const w of warnings) ctx.warn('W_ASSET_LOWRES', `${path.basename(dest)} — ${w}`);
  }
  backupFile(aFile);
  writeJsonAtomic(aFile, assets);
  return added;
}

/** Rafraîchit sha256/size des images (seuls champs machine tolérés dans assets.json). */
export async function refreshAssets(projectDir: string) {
  const aFile = path.join(projectDir, FILES.assets);
  const assets = readJson<AssetsFile>(aFile);
  let changed = false;
  for (const img of assets.images) {
    const p = path.join(projectDir, ...img.path.split('/'));
    if (!fs.existsSync(p)) continue;
    const sha = hashFileSync(p);
    if (sha !== img.sha256 || !img.size) {
      img.sha256 = sha;
      img.size = await probeImage(p);
      changed = true;
    }
  }
  for (const t of assets.textures ?? []) {
    const p = path.join(projectDir, ...t.path.split('/'));
    if (fs.existsSync(p)) {
      const sha = hashFileSync(p);
      if (sha !== t.sha256) { t.sha256 = sha; changed = true; }
    }
  }
  if (changed) writeJsonAtomic(aFile, assets);
  return assets;
}

import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ID_RE } from '../../core/paths';
import { NmsvsError } from '../../core/errors';
import { ensureDir, writeJsonAtomic, appendLine } from '../../core/fsx';
import { FILES } from '../../model/project';
import type { AssetsFile, Decision, ProjectFile, ReelsFile, SyncOverridesFile } from '../../model/types';

export function defaultProject(id: string, title: string, formats: string[]): ProjectFile {
  const known: Record<string, { width: number; height: number; safeZone: string }> = {
    '16x9': { width: 3840, height: 2160, safeZone: 'preset:safe-16x9-default' },
    '9x16': { width: 1080, height: 1920, safeZone: 'preset:safe-9x16-social' },
  };
  const f: ProjectFile['formats'] = {};
  for (const fmt of formats) {
    if (!known[fmt]) throw new NmsvsError('E_ARGS', `Format inconnu « ${fmt} » (16x9 ou 9x16 ; formats personnalisés à éditer dans project.json).`);
    f[fmt] = known[fmt];
  }
  return {
    $schema: 'https://nmsvs.local/schemas/project/v1.json',
    schemaVersion: 1,
    id,
    title,
    audio: { master: 'media/audio/master.wav', offsetSec: 0 },
    lyrics: 'lyrics.json',
    fps: 30,
    formats: f,
    art: {
      lyricStyle: 'preset:lyrics-cartouche-default',
      transitionDefault: 'preset:crossfade-beat',
      motionCycle: ['preset:slow-push-in', 'preset:drift', 'preset:slow-pull-out', 'preset:pan-left-right'],
      harmonize: { mode: 'auto', strength: 0.5 },
      palette: { text: '#F5EBDD', accent: '#F0B429', shadow: '#000000B0' },
      shotLength: { min: 6, max: 10 },
      vignette: 0.15,
      grain: 0,
      lyricLeadSec: 0.25,
      lyricTailSec: 0.2,
      maxUpscale: 1.5,
    },
    sync: { engine: 'whisperx', preprocess: 'vocal-focus', asrModel: 'large-v3', alignModel: 'jonatasgrosman/wav2vec2-large-xlsr-53-french' },
    exportProfiles: ['youtube-4k-master', 'reel-1080-h264'],
    reels: { format: '9x16', lyricStyle: 'preset:lyrics-reel-cartouche', titleCard: false, fadeInSec: 0.1, fadeOutSec: 0.8 },
  };
}

export function initProject(slug: string, opts: { title?: string; formats?: string[]; root?: string }): string {
  if (!ID_RE.test(slug)) throw new NmsvsError('E_ARGS', `Identifiant de projet invalide « ${slug} » (minuscules, chiffres, tirets).`);
  const dir = path.join(opts.root ?? PATHS.projects, slug);
  if (fs.existsSync(path.join(dir, FILES.project))) {
    throw new NmsvsError('E_PROJECT_EXISTS', `Le projet « ${slug} » existe déjà.`, 'Choisir un autre identifiant ; aucun fichier n’a été modifié.');
  }
  for (const d of ['media/audio', 'media/images', 'media/textures', 'media/fonts', 'lyrics', 'analysis', 'build', 'exports', 'reports']) ensureDir(path.join(dir, d));
  writeJsonAtomic(path.join(dir, FILES.project), defaultProject(slug, opts.title ?? slug, opts.formats ?? ['16x9', '9x16']));
  const assets: AssetsFile = { $schema: 'https://nmsvs.local/schemas/assets/v1.json', schemaVersion: 1, images: [], textures: [] };
  writeJsonAtomic(path.join(dir, FILES.assets), assets);
  const overrides: SyncOverridesFile = { $schema: 'https://nmsvs.local/schemas/sync-overrides/v1.json', schemaVersion: 1, globalOffsetSec: 0, lines: {}, words: {} };
  writeJsonAtomic(path.join(dir, FILES.overrides), overrides);
  const reels: ReelsFile = { $schema: 'https://nmsvs.local/schemas/reels/v1.json', schemaVersion: 1, params: { durations: [20, 30, 45], count: 5, maxOverlap: 0.35, weights: 'preset:reels-balanced', lambda: 0.7 }, selection: [] };
  writeJsonAtomic(path.join(dir, FILES.reels), reels);
  fs.writeFileSync(path.join(dir, 'lyrics', 'source.txt'), '# Coller ici les paroles, puis : nmsvs import lyrics lyrics/source.txt\n# [Couplet 1]\n# ...\n# [Refrain]\n# ...\n');
  addDecision(dir, { by: 'engine', via: 'nmsvs init', decision: `Création du projet « ${slug} »` });
  return dir;
}

export function addDecision(projectDir: string, d: Omit<Decision, 'ts'>) {
  const entry: Decision = { ts: new Date().toISOString(), ...d };
  appendLine(path.join(projectDir, FILES.decisions), JSON.stringify(entry));
  return entry;
}

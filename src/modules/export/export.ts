import fs from 'node:fs';
import path from 'node:path';
import { NmsvsError } from '../../core/errors';
import { ensureDir, readJson, writeFileAtomic, writeJsonAtomic } from '../../core/fsx';
import { hashFileSync, hashObject, shortKey } from '../../core/hash';
import { ffmpeg, toolVersions } from '../../core/tools';
import type { RunContext } from '../../core/context';
import { loadPreset } from '../../model/presets';
import { assertValid } from '../../model/schemas';
import { projectPath, type ProjectBundle } from '../../model/project';
import type { AudioAnalysis } from '../../model/types';
import type { RTimeline } from '../../remotion/types';
import { loadManifest, updateManifest } from '../../pipeline/manifest';
import { analysisFile } from '../analysis/analyze';
import { buildTimeline } from '../timeline/build';
import type { CompileWarning } from '../timeline/compile';
import { concatSegments, renderSegments, renderSettings, type RenderSettings } from '../render/render';
import { qcMarkdown, runQc, type QcReport } from '../qc/qc';
import { loadResolvedSync } from '../sync/sync';
import { toSrt, toVtt } from '../sync/subtitles';

export interface ExportProfile {
  format: string; scale?: number; container: 'mp4' | 'mkv' | 'mov';
  video: { encoder: string; crf?: number; qp?: number; preset?: string; profile?: string; level?: string; pixFmt?: string; gopSec?: number; bframes?: number };
  audio: { codec: 'aac' | 'flac' | 'pcm_s24le' | 'copy'; bitrateK?: number; sampleRate?: 44100 | 48000 };
  subtitles?: boolean;
}

export function loadProfile(id: string): ExportProfile {
  const p = loadPreset<ExportProfile>('export', id);
  assertValid('export-profile', p, `presets/export/${id}.json`);
  return p;
}

const CODEC_NAME: Record<string, string> = { libx264: 'h264', h264_amf: 'h264', libx265: 'hevc', hevc_amf: 'hevc', libsvtav1: 'av1' };

/** Arguments FFmpeg de l'encodage final selon le profil (balises BT.709, GOP fermé, faststart). */
export function videoArgs(p: ExportProfile, fps: number): string[] {
  const v = p.video;
  const a: string[] = ['-c:v', v.encoder];
  if (v.encoder === 'libx264' || v.encoder === 'libx265') {
    if (v.crf !== undefined) a.push('-crf', String(v.crf));
    if (v.preset) a.push('-preset', v.preset);
    if (v.profile && v.encoder === 'libx264') a.push('-profile:v', v.profile);
    if (v.level && v.encoder === 'libx264') a.push('-level:v', v.level);
    if (v.bframes !== undefined) a.push('-bf', String(v.bframes));
    if (v.encoder === 'libx264') a.push('-flags', '+cgop');
    if (v.encoder === 'libx265') a.push('-tag:v', 'hvc1', '-x265-params', 'log-level=error:colorprim=bt709:transfer=bt709:colormatrix=bt709');
  } else if (v.encoder.endsWith('_amf')) {
    a.push('-quality', v.preset ?? 'quality', '-rc', 'cqp', '-qp_i', String(v.qp ?? 20), '-qp_p', String(v.qp ?? 20));
    if (v.encoder === 'hevc_amf') a.push('-tag:v', 'hvc1');
  } else if (v.encoder === 'libsvtav1') {
    a.push('-crf', String(v.crf ?? 28), '-preset', v.preset ?? '6');
  }
  if (v.gopSec) a.push('-g', String(Math.round(v.gopSec * fps)));
  // FFmpeg 9 : les propriétés couleur des images priment sur les options de l'encodeur → on les fixe sur les images.
  a.push('-vf', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv');
  a.push('-pix_fmt', v.pixFmt ?? 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv');
  return a;
}

export function audioArgs(p: ExportProfile): string[] {
  const au = p.audio;
  if (au.codec === 'copy') return ['-c:a', 'copy'];
  const a = ['-c:a', au.codec];
  if (au.codec === 'aac') a.push('-b:a', `${au.bitrateK ?? 320}k`);
  a.push('-ar', String(au.sampleRate ?? 48000), '-ac', '2');
  return a;
}

/** audioDurSec : durée de musique (défaut durSec) ; au-delà, silence (fermeture d'un Short). replace : autorisation explicite d'écraser. */
export interface EncodeInput { video: string; master: string; offsetSec?: number; startSec?: number; delaySec?: number; durSec: number; audioDurSec?: number; fadeInSec?: number; fadeOutSec?: number; title?: string; buildId: string; replace?: boolean }

/** Encodage final : vidéo (segments concaténés) + audio maître, durée exacte de la vidéo. */
export async function encodeFinal(ctx: RunContext, inp: EncodeInput, p: ExportProfile, fps: number, out: string) {
  ensureDir(path.dirname(out));
  // Plus d'archivage automatique : un export existant n'est jamais déplacé ni écrasé sans autorisation explicite.
  if (fs.existsSync(out) && !inp.replace) {
    throw new NmsvsError('E_EXPORT_EXISTS', `L'export existe déjà : ${path.basename(out)}`, 'Choisir un autre nom (ex. --label) ou autoriser explicitement le remplacement (--replace).');
  }
  const tmp = out.replace(/(\.\w+)$/, '.tmp$1');
  const musicSec = Math.min(inp.audioDurSec ?? inp.durSec, inp.durSec);
  const af: string[] = ['aresample=resampler=soxr'];
  // Préambule : silence numérique inséré avant le premier échantillon du master (le WAV n'est pas modifié).
  if (inp.delaySec) af.push(`adelay=delays=${(inp.delaySec * 1000).toFixed(3)}:all=1`);
  if (inp.fadeInSec) af.push(`afade=t=in:st=0:d=${inp.fadeInSec}`);
  if (inp.fadeOutSec) af.push(`afade=t=out:st=${Math.max(0, musicSec - inp.fadeOutSec).toFixed(3)}:d=${inp.fadeOutSec}`);
  if (musicSec < inp.durSec) af.push(`atrim=end=${musicSec.toFixed(6)}`); // silence après la musique (complété par apad)
  af.push('apad');
  const audioIn: string[] = [];
  if (inp.offsetSec) audioIn.push('-itsoffset', String(inp.offsetSec));
  if (inp.startSec) audioIn.push('-ss', inp.startSec.toFixed(3));
  audioIn.push('-i', inp.master);
  const args = [
    '-i', inp.video, ...audioIn, '-map', '0:v:0', '-map', '1:a:0',
    ...videoArgs(p, fps), ...(p.audio.codec === 'copy' ? audioArgs(p) : [...audioArgs(p), '-af', af.join(',')]),
    '-t', inp.durSec.toFixed(6), '-map_metadata', '-1', '-metadata', `title=${inp.title ?? ''}`, '-metadata', `comment=nmsvs build ${inp.buildId}`,
  ];
  if (p.container === 'mp4') args.push('-movflags', '+faststart');
  args.push(tmp);
  try {
    await ctx.log.time('encode', `Encodage final (${p.video.encoder})`, () => ffmpeg(args));
  } catch (e) {
    if (!p.video.encoder.endsWith('_amf')) throw e;
    // Repli logiciel si l'encodeur GPU AMD refuse (ex. résolution inférieure à son minimum, pilote indisponible).
    const sw = p.video.encoder === 'hevc_amf' ? 'libx265' : 'libx264';
    ctx.warn('W_AMF_FALLBACK', `Encodeur ${p.video.encoder} indisponible pour cet export : repli sur ${sw}.`);
    const swProfile: ExportProfile = { ...p, video: { ...p.video, encoder: sw, crf: (p.video.qp ?? 20) - 2, preset: 'veryfast' } };
    const i = args.indexOf('-c:v');
    const end = args.indexOf('-pix_fmt') + 2;
    const swArgs = [...args.slice(0, i), ...videoArgs(swProfile, fps), ...args.slice(end)];
    await ctx.log.time('encode', `Encodage final (${sw}, repli)`, () => ffmpeg(swArgs));
  }
  // Remplacement autorisé explicitement (replace) : l'ancien fichier est remplacé, sans archive automatique.
  if (fs.existsSync(out)) fs.rmSync(out);
  fs.renameSync(tmp, out);
}

export interface ExportResult { file: string; profile: string; cached: boolean; qc: QcReport; renderSec: number; encodeSec: number; segments: { total: number; rendered: number }; framesRendered: number }

/** Règle de production V1.1 : tout export YouTube est un MP4 16:9 en 3840 × 2160, rendu directement (pas de mise à l'échelle). */
export function assertYoutubeDeliverable(b: ProjectBundle, profileId: string, p: ExportProfile) {
  if (!profileId.startsWith('youtube-')) return;
  const f = b.project.formats[p.format];
  const issues: string[] = [];
  if (p.format !== '16x9') issues.push(`format ${p.format} (attendu 16x9)`);
  if (!f || f.width !== 3840 || f.height !== 2160) issues.push(`résolution ${f?.width}×${f?.height} (attendu 3840×2160)`);
  if ((p.scale ?? 1) !== 1) issues.push(`mise à l'échelle ${p.scale} (attendu 1)`);
  if (p.container !== 'mp4') issues.push(`conteneur ${p.container} (attendu mp4)`);
  if (issues.length) throw new NmsvsError('E_PROFILE', `Export YouTube non conforme : ${issues.join(', ')}.`, 'project.json → formats.16x9 = 3840×2160 ; profil youtube-4k-master (MP4, sans mise à l’échelle).');
}

/** `versionLabel` : suffixe de version du nom de fichier (nouvelle version sans écraser l'export existant). */
export async function exportProfile(ctx: RunContext, b: ProjectBundle, profileId: string, opts: { render?: Partial<RenderSettings>; vmaf?: boolean; replace?: boolean; versionLabel?: string } = {}): Promise<ExportResult> {
  const p = loadProfile(profileId);
  if (!b.project.formats[p.format]) throw new NmsvsError('E_ARGS', `Le profil ${profileId} vise le format ${p.format}, absent du projet.`);
  assertYoutubeDeliverable(b, profileId, p);
  const built = await buildTimeline(ctx, b, p.format);
  const settings = renderSettings({ ...opts.render, mezz: { ...renderSettings(opts.render).mezz, scale: p.scale ?? 1 } });
  const label = (p.scale ?? 1) === 1 ? p.format : `${p.format}@${p.scale}`;
  return exportTimeline(ctx, b, built.timeline, built.warnings, p, profileId, label, `${b.project.id}-${p.format}-${profileId}${opts.versionLabel ? `-${opts.versionLabel}` : ''}`, { settings, vmaf: opts.vmaf, replace: opts.replace });
}

/** Rendu + encodage + QC d'une timeline résolue (clip complet ou Reel). */
export async function exportTimeline(
  ctx: RunContext, b: ProjectBundle, t: RTimeline, warnings: CompileWarning[], p: ExportProfile, profileId: string, label: string, baseName: string,
  o: { settings: RenderSettings; startSec?: number; audioDurSec?: number; fadeInSec?: number; fadeOutSec?: number; vmaf?: boolean; title?: string; replace?: boolean },
): Promise<ExportResult> {
  const master = projectPath(b, b.project.audio.master);
  const audioSha = hashFileSync(master);
  const r = await renderSegments(ctx, b, t, o.settings, label);
  const scale = o.settings.mezz.scale;
  const W = Math.round(t.width * scale);
  const H = Math.round(t.height * scale);
  const durSec = t.durationInFrames / t.fps;
  const ffv = (await toolVersions()).ffmpeg;
  const delaySec = (t.prerollFrames ?? 0) / t.fps;
  const key = hashObject({ v: 1, segs: r.segments.map((s) => s.key), audioSha, offset: b.project.audio.offsetSec ?? 0, delay: delaySec, start: o.startSec, ad: o.audioDurSec, fi: o.fadeInSec, fo: o.fadeOutSec, p, ffv });
  const buildId = shortKey(key);
  const out = path.join(b.dir, 'exports', `${baseName}.${p.container}`);
  const mezz = path.join(b.dir, 'build', label, `mezzanine-${shortKey(hashObject(r.segments.map((s) => s.key)))}.${o.settings.mezz.codec === 'prores' ? 'mov' : 'mp4'}`);
  if (!fs.existsSync(mezz)) await concatSegments(r.segments.map((s) => s.file), mezz);
  const prev = loadManifest(b.dir).exports.find((e) => e.file === out);
  let cached = false;
  let encodeSec = 0;
  if (prev && prev.key === key && fs.existsSync(out)) {
    cached = true;
    ctx.log.info(`Export inchangé (clé ${buildId}) : ${path.basename(out)}`);
  } else {
    const t0 = performance.now();
    await encodeFinal(ctx, { video: mezz, master, offsetSec: b.project.audio.offsetSec, startSec: o.startSec, delaySec, durSec, audioDurSec: o.audioDurSec, fadeInSec: o.fadeInSec, fadeOutSec: o.fadeOutSec, title: o.title ?? b.project.title, buildId, replace: o.replace }, p, t.fps, out);
    encodeSec = (performance.now() - t0) / 1000;
  }
  const sync = (() => { try { return loadResolvedSync(ctx, b); } catch { return undefined; } })();
  const qc = await ctx.log.time('qc', 'Contrôle qualité', () => runQc({
    file: out, timeline: t, warnings, sync, mezzanine: mezz, vmaf: o.vmaf,
    expected: { width: W, height: H, fps: t.fps, videoCodec: CODEC_NAME[p.video.encoder] ?? p.video.encoder, pixFmt: p.video.pixFmt === 'p010le' ? 'p010le' : p.video.pixFmt ?? 'yuv420p', audioCodec: p.audio.codec === 'copy' ? 'aac' : p.audio.codec, sampleRate: p.audio.sampleRate ?? 48000, durationSec: durSec },
    master: { file: master, startSec: o.startSec, durSec: o.audioDurSec ?? durSec },
  }));
  let finalFile = out;
  if (qc.blocking) {
    finalFile = out.replace(/(\.\w+)$/, '.REJECTED$1');
    fs.renameSync(out, finalFile);
  }
  if (p.subtitles && o.startSec === undefined) {
    if (delaySec > 0 && sync) {
      // Préambule : sous-titres décalés d'autant (ceux de exports/<id>.srt restent en temps chanson).
      writeFileAtomic(out.replace(/\.\w+$/, '.srt'), toSrt(sync, b.lyrics, -delaySec));
      writeFileAtomic(out.replace(/\.\w+$/, '.vtt'), toVtt(sync, b.lyrics, -delaySec));
    } else {
      for (const ext of ['srt', 'vtt']) {
        const src = path.join(b.dir, 'exports', `${b.project.id}.${ext}`);
        if (fs.existsSync(src)) fs.copyFileSync(src, out.replace(/\.\w+$/, `.${ext}`));
      }
    }
  }
  updateManifest(b.dir, (m) => {
    m.exports = m.exports.filter((e) => e.file !== out);
    m.exports.push({ file: out, profile: profileId, key, at: new Date().toISOString(), qc: qc.blocking ? 'bloquant' : qc.major ? 'majeur' : 'ok' });
  });
  ctx.persist();
  writeJsonAtomic(path.join(ctx.dir, `qc-${path.basename(out, path.extname(out))}.json`), qc);
  writeFileAtomic(path.join(ctx.dir, `qc-${path.basename(out, path.extname(out))}.md`), `# QC — ${path.basename(out)}\n\n${qcMarkdown(qc)}`);
  ctx.artifacts.push(finalFile);
  if (qc.blocking) throw new NmsvsError('E_QC_BLOCKING', `Export rejeté par le contrôle qualité : ${path.basename(finalFile)}`, `Voir ${path.join(ctx.dir, 'qc-*.md')}`, qc);
  return { file: finalFile, profile: profileId, cached, qc, renderSec: r.renderSec, encodeSec, segments: { total: r.segments.length, rendered: r.rendered }, framesRendered: r.framesRendered };
}

export function audioDuration(b: ProjectBundle): number {
  return readJson<AudioAnalysis>(analysisFile(b.dir)).durationSec;
}

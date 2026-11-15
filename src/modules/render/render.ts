import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderMedia, renderStill, selectComposition, type ChromiumOptions } from '@remotion/renderer';
import { NmsvsError } from '../../core/errors';
import { ensureDir, writeFileAtomic } from '../../core/fsx';
import { hashDirSync } from '../../core/hash';
import { PATHS, ROOT } from '../../core/paths';
import { ffmpeg } from '../../core/tools';
import type { RunContext } from '../../core/context';
import type { ProjectBundle } from '../../model/project';
import type { RTimeline } from '../../remotion/types';
import { recordSegmentPlan } from '../../pipeline/manifest';
import { assetsDir } from '../assets/prepare';
import { DEFAULT_MEZZANINE, planSegments, type MezzanineSettings, type SegmentPlan } from './segments';
import { startAssetServer } from './server';

export interface RenderSettings { concurrency: number; gl: ChromiumOptions['gl']; mezz: MezzanineSettings }

/** Réglages par défaut (ajustés par les benchmarks B1/B5 : voir presets/render.json). */
export function renderSettings(overrides: Partial<RenderSettings> = {}): RenderSettings {
  let fromFile: Partial<RenderSettings> = {};
  const f = path.join(PATHS.presets, 'render.json');
  if (fs.existsSync(f)) fromFile = JSON.parse(fs.readFileSync(f, 'utf8'));
  return {
    concurrency: overrides.concurrency ?? fromFile.concurrency ?? Math.max(1, Math.floor(os.cpus().length / 2)),
    gl: overrides.gl ?? fromFile.gl ?? 'angle',
    mezz: { ...DEFAULT_MEZZANINE, ...(fromFile.mezz ?? {}), ...(overrides.mezz ?? {}) },
  };
}

let componentsHashCache: string | null = null;
/** Empreinte du code des compositions + version de Remotion (entre dans les clés de segment). */
export function componentsHash(): string {
  if (!componentsHashCache) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    componentsHashCache = `${pkg.dependencies.remotion}:${hashDirSync(PATHS.remotionSrc, ['.ts', '.tsx']).slice(0, 24)}`;
  }
  return componentsHashCache;
}

/** Bundle webpack des compositions, mis en cache par empreinte du code. */
export async function getBundle(ctx: RunContext): Promise<string> {
  const dir = path.join(PATHS.bundles, componentsHash().replace(/[^a-z0-9]/gi, '-'));
  if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  await ctx.log.time('bundle', 'Construction du bundle Remotion', async () => {
    const tmp = `${dir}.tmp${process.pid}`;
    await bundle({ entryPoint: PATHS.remotionEntry, outDir: tmp, enableCaching: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  });
  return dir;
}

export async function prepareBrowser(ctx: RunContext) {
  await ensureBrowser({ logLevel: 'error', onBrowserDownload: () => {
    ctx.log.info('Téléchargement de Chrome Headless Shell (une seule fois)…');
    return { version: null, onProgress: () => undefined };
  } });
}

export const segmentsDir = (b: { dir: string }, format: string) => path.join(b.dir, 'build', format, 'segments');

export interface RenderResult { segments: (SegmentPlan & { file: string; cached: boolean })[]; rendered: number; cachedCount: number; renderSec: number; framesRendered: number }

/** Rend les segments manquants d'une timeline résolue (vidéo muette, format mezzanine). */
export async function renderSegments(ctx: RunContext, b: ProjectBundle, t: RTimeline, settings: RenderSettings, label = t.format): Promise<RenderResult> {
  const plan = planSegments(t, componentsHash(), settings.mezz);
  const dir = segmentsDir(b, label);
  ensureDir(dir);
  const ext = settings.mezz.codec === 'prores' ? 'mov' : 'mp4';
  const segs = plan.map((p) => ({ ...p, file: path.join(dir, `${p.key}.${ext}`), cached: fs.existsSync(path.join(dir, `${p.key}.${ext}`)) }));
  recordSegmentPlan(b.dir, label, plan.map((p) => p.key));
  const todo = segs.filter((s) => !s.cached);
  ctx.log.info(`${segs.length} segment(s) : ${segs.length - todo.length} en cache, ${todo.length} à rendre`, undefined, `render:${label}`);
  const t0 = performance.now();
  let frames = 0;
  if (todo.length) {
    await prepareBrowser(ctx);
    const serveUrl = await getBundle(ctx);
    const server = await startAssetServer(assetsDir(b));
    try {
      const props = { ...t, assetBaseUrl: server.url } as unknown as Record<string, unknown>;
      const composition = await selectComposition({ serveUrl, id: 'Main', inputProps: props, logLevel: 'error', chromiumOptions: { gl: settings.gl } });
      for (const [i, s] of todo.entries()) {
        const tmp = s.file.replace(/\.(mp4|mov)$/, `.tmp.$1`);
        let attempt = 0;
        let conc = settings.concurrency;
        for (;;) {
          try {
            const ts = performance.now();
            await renderMedia({
              composition, serveUrl, inputProps: props, outputLocation: tmp, frameRange: [s.from, s.to - 1], muted: true,
              codec: settings.mezz.codec, crf: settings.mezz.codec === 'h264' ? settings.mezz.crf : null, x264Preset: settings.mezz.codec === 'h264' ? (settings.mezz.preset as any) : undefined,
              proResProfile: settings.mezz.codec === 'prores' ? 'hq' : undefined,
              imageFormat: settings.mezz.imageFormat, jpegQuality: settings.mezz.imageFormat === 'jpeg' ? settings.mezz.jpegQuality : undefined,
              pixelFormat: settings.mezz.codec === 'prores' ? 'yuv422p10le' : 'yuv420p', colorSpace: 'bt709', scale: settings.mezz.scale,
              concurrency: conc, chromiumOptions: { gl: settings.gl }, timeoutInMilliseconds: 120_000, logLevel: 'error', overwrite: true,
            });
            fs.renameSync(tmp, s.file);
            frames += s.to - s.from;
            const fps = (s.to - s.from) / ((performance.now() - ts) / 1000);
            ctx.log.info(`segment ${i + 1}/${todo.length} [${s.from}–${s.to}) rendu à ${fps.toFixed(2)} i/s`, { key: s.key, fps }, `render:${label}`);
            break;
          } catch (e) {
            fs.rmSync(tmp, { force: true });
            // Reprise : une seconde tentative avec une concurrence divisée par deux, puis échec explicite.
            if (attempt++ >= 1) throw new NmsvsError('E_RENDER_FAILED', `Échec du rendu du segment [${s.from}–${s.to}) : ${(e as Error).message}`, 'Relancer `nmsvs resume` ; les segments déjà rendus sont conservés.');
            conc = Math.max(1, Math.floor(conc / 2));
            ctx.warn('W_RENDER_RETRY', `Nouvelle tentative du segment [${s.from}–${s.to}) avec concurrence ${conc}`);
          }
        }
      }
    } finally {
      await server.close();
    }
  }
  const renderSec = (performance.now() - t0) / 1000;
  return { segments: segs, rendered: todo.length, cachedCount: segs.length - todo.length, renderSec, framesRendered: frames };
}

/** Concaténation sans ré-encodage (paramètres d'encodage identiques garantis par la clé). */
export async function concatSegments(files: string[], out: string) {
  ensureDir(path.dirname(out));
  const list = `${out}.txt`;
  writeFileAtomic(list, files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const tmp = out.replace(/\.(mp4|mov)$/, '.tmp.$1');
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', tmp]);
  fs.renameSync(tmp, out);
  fs.rmSync(list, { force: true });
}

/** Images fixes (aperçus, planche-contact, golden tests). */
export async function renderStills(ctx: RunContext, b: ProjectBundle, t: RTimeline, frames: number[], outDir: string, opts: { scale?: number; showSafe?: boolean; gl?: ChromiumOptions['gl'] } = {}): Promise<string[]> {
  await prepareBrowser(ctx);
  const serveUrl = await getBundle(ctx);
  const server = await startAssetServer(assetsDir(b));
  ensureDir(outDir);
  const out: string[] = [];
  try {
    const props = { ...t, assetBaseUrl: server.url, showSafe: !!opts.showSafe } as unknown as Record<string, unknown>;
    const composition = await selectComposition({ serveUrl, id: 'Main', inputProps: props, logLevel: 'error' });
    for (const f of frames) {
      const file = path.join(outDir, `${t.format}-f${String(f).padStart(6, '0')}.png`);
      await renderStill({ composition, serveUrl, inputProps: props, frame: Math.max(0, Math.min(t.durationInFrames - 1, f)), output: file, imageFormat: 'png', scale: opts.scale ?? 1, chromiumOptions: { gl: opts.gl ?? 'angle' }, logLevel: 'error', overwrite: true });
      out.push(file);
    }
  } finally {
    await server.close();
  }
  return out;
}

/** Planche-contact : une vignette par image fournie, assemblées par FFmpeg (tile). */
export async function contactSheet(pngs: string[], out: string, cols = 4) {
  if (!pngs.length) return;
  const rows = Math.ceil(pngs.length / cols);
  const dir = path.dirname(pngs[0]);
  const listDir = path.join(dir, '_seq');
  ensureDir(listDir);
  pngs.forEach((p, i) => fs.copyFileSync(p, path.join(listDir, `${String(i).padStart(5, '0')}.png`)));
  ensureDir(path.dirname(out));
  await ffmpeg(['-framerate', '1', '-i', path.join(listDir, '%05d.png'), '-vf', `scale=480:-2,pad=iw+8:ih+8:4:4:color=0x111111,tile=${cols}x${rows}:color=0x111111`, '-frames:v', '1', '-q:v', '3', out]);
  fs.rmSync(listDir, { recursive: true, force: true });
}

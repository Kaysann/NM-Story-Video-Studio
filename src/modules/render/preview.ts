import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { NmsvsError } from '../../core/errors';
import { ensureDir, writeJsonAtomic } from '../../core/fsx';
import { ROOT } from '../../core/paths';
import type { RunContext } from '../../core/context';
import type { ProjectBundle } from '../../model/project';
import { assetsDir } from '../assets/prepare';
import { buildTimeline } from '../timeline/build';
import { exportTimeline, loadProfile, type ExportResult } from '../export/export';
import { sliceTimeline } from '../reels/reels';
import { contactSheet, renderSettings, renderStills } from './render';
import { startAssetServer } from './server';
import { loadResolvedSync } from '../sync/sync';

export async function previewStill(ctx: RunContext, b: ProjectBundle, format: string, timeSec: number, safe: boolean): Promise<string> {
  const { timeline } = await buildTimeline(ctx, b, format);
  ctx.persist();
  const [file] = await renderStills(ctx, b, timeline, [Math.round(timeSec * timeline.fps)], path.join(ctx.dir, 'stills'), { showSafe: safe });
  ctx.artifacts.push(file);
  return file;
}

/** Planche-contact : milieu de chaque plan + début de chaque bloc de paroles (zones sûres superposées). */
export async function previewContact(ctx: RunContext, b: ProjectBundle, format: string): Promise<string> {
  const { timeline: t } = await buildTimeline(ctx, b, format);
  const frames = new Set<number>();
  for (const s of t.shots) frames.add(Math.round((Math.max(0, s.from) + Math.min(t.durationInFrames, s.to)) / 2));
  for (const l of t.lyrics) frames.add(Math.min(t.durationInFrames - 1, l.from + 10));
  const list = [...frames].filter((f) => f >= 0 && f < t.durationInFrames).sort((a, c) => a - c).slice(0, 80);
  ctx.persist();
  const dir = path.join(ctx.dir, `contact-${format}`);
  const scale = Math.min(1, 640 / t.width);
  const pngs = await renderStills(ctx, b, t, list, dir, { scale, showSafe: true });
  const out = path.join(ctx.dir, `contact-sheet-${format}.jpg`);
  await contactSheet(pngs, out, t.width > t.height ? 4 : 6);
  ctx.artifacts.push(out);
  return out;
}

/** Brouillon basse résolution avec audio (encodage GPU AMF), éventuellement limité à un intervalle. */
export async function previewDraft(ctx: RunContext, b: ProjectBundle, format: string, range?: { from?: string; to?: string }): Promise<ExportResult> {
  const profileId = format === '16x9' ? 'draft-16x9' : 'draft-9x16';
  const p = loadProfile(profileId);
  // Brouillon d'un intervalle : repères en temps chanson, donc sans préambule.
  const { timeline, warnings } = await buildTimeline(ctx, b, format, { preroll: !(range?.from || range?.to) });
  let t = timeline;
  let startSec: number | undefined;
  let label = `draft-${format}`;
  if (range?.from || range?.to) {
    const sync = loadResolvedSync(ctx, b);
    const at = (id: string | undefined, edge: 'start' | 'end', dflt: number) => {
      if (!id) return dflt;
      if (/^\d+(\.\d+)?$/.test(id)) return Number(id);
      const s = sync.sections[id] ?? sync.lines.find((l) => l.id === id);
      if (!s) throw new NmsvsError('E_ARGS', `Repère inconnu : ${id}`);
      return edge === 'start' ? s.start : s.end;
    };
    const a = Math.max(0, at(range.from, 'start', 0) - 1);
    const z = Math.min(t.durationInFrames / t.fps, at(range.to, 'end', t.durationInFrames / t.fps) + 1);
    t = sliceTimeline(t, Math.round(a * t.fps), Math.round(z * t.fps));
    startSec = a;
    label = `draft-${format}-${Math.round(a * 1000)}-${Math.round(z * 1000)}`;
  }
  const settings = renderSettings({ mezz: { ...renderSettings().mezz, scale: p.scale ?? 0.25, crf: 18 } });
  return exportTimeline(ctx, b, t, warnings, p, profileId, label, `${b.project.id}-${label}`, { settings, startSec });
}

/** Remotion Studio sur la timeline résolue du format (bloquant jusqu'à fermeture). */
export async function previewStudio(ctx: RunContext, b: ProjectBundle, format: string, opts: { safe?: boolean; port?: number; open?: boolean }): Promise<void> {
  const { timeline } = await buildTimeline(ctx, b, format);
  const server = await startAssetServer(assetsDir(b));
  const propsFile = path.join(b.dir, 'build', format, 'studio-props.json');
  ensureDir(path.dirname(propsFile));
  writeJsonAtomic(propsFile, { ...timeline, assetBaseUrl: server.url, showSafe: !!opts.safe });
  ctx.log.info(`Remotion Studio — format ${format}. Serveur d’assets : ${server.url}. Fermer avec Ctrl+C.`);
  const cli = path.join(ROOT, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
  if (!fs.existsSync(cli)) throw new NmsvsError('E_DEP_MISSING', 'Remotion CLI introuvable.', 'npm install');
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [cli, 'studio', path.join(ROOT, 'src', 'remotion', 'index.ts'), `--props=${propsFile}`, ...(opts.port ? [`--port=${opts.port}`] : []), ...(opts.open === false ? ['--no-open'] : [])], { cwd: ROOT, stdio: 'inherit' });
    child.on('close', () => resolve());
  });
  await server.close();
}

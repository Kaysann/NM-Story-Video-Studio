import fs from 'node:fs';
import path from 'node:path';
import { NmsvsError } from '../../core/errors';
import { readJson, writeJsonAtomic } from '../../core/fsx';
import type { RunContext } from '../../core/context';
import { projectPath, type ProjectBundle } from '../../model/project';
import { assertValid } from '../../model/schemas';
import type { AudioAnalysis, SyncResolved } from '../../model/types';
import type { RTimeline } from '../../remotion/types';
import { analysisFile } from '../analysis/analyze';
import { imageStats, prepareImage, resolveLook, stageFile, type PreparedImage } from '../assets/prepare';
import { fitFor } from '../assets/crop';
import { loadResolvedSync } from '../sync/sync';
import { applyPreroll, compileTimeline, type CompileWarning, type ImageInfo } from './compile';

export { pngSize } from '../../core/png';
import { pngSize } from '../../core/png';

export const resolvedFile =(dir: string, format: string) => path.join(dir, 'build', format, 'timeline.resolved.json');

export interface BuiltTimeline { timeline: RTimeline; warnings: CompileWarning[]; prepared: PreparedImage[]; file: string }

/** Prépare les dérivés d'images nécessaires puis compile la timeline résolue d'un format. */
/** `preroll: false` : timeline en temps chanson, sans préambule (Reels, brouillon d'un intervalle). */
/** `sync` : synchronisation résolue imposée (Shorts : couche de corrections dédiée) ; défaut : celle du clip. */
export async function buildTimeline(ctx: RunContext, b: ProjectBundle, format: string, opts: { preroll?: boolean; sync?: SyncResolved } = {}): Promise<BuiltTimeline> {
  if (!b.timeline) throw new NmsvsError('E_ASSET_MISSING', 'timeline.json absent.', 'Lancer `nmsvs compose`.');
  const analysis = readJson<AudioAnalysis>(analysisFile(b.dir));
  const sync: SyncResolved = opts.sync ?? loadResolvedSync(ctx, b);
  const stats = await imageStats(ctx, b);
  const look = resolveLook(b);
  const fit = (id: string) => { const i = b.assets.images.find((x) => x.id === id); return i ? fitFor(i, format) : 'cover'; };
  const stage = (kind: 'font' | 'texture', idOrPath: string) => {
    if (kind === 'texture') {
      const t = b.assets.textures?.find((x) => x.id === idOrPath);
      if (!t) {
        ctx.warn('W_TEXTURE', `Texture inconnue « ${idOrPath} » : texture procédurale utilisée.`);
        return null;
      }
      const abs = projectPath(b, t.path);
      return { ...stageFile(b, abs, 'tex'), ...pngSize(abs) };
    }
    const candidates = [projectPath(b, idOrPath), path.resolve(idOrPath)];
    const f = candidates.find((c) => fs.existsSync(c));
    if (!f) {
      ctx.warn('W_FONT', `Police introuvable « ${idOrPath} » : Georgia utilisée.`);
      return null;
    }
    return stageFile(b, f, 'fonts');
  };

  // Passe 1 (à blanc) : recense les couples (image, marge) nécessaires.
  const frame = b.project.formats[format];
  const dry = compileTimeline(b, format, sync, analysis, (id, m) => ({ rel: '', sha: '', w: Math.round(frame.width * m), h: Math.round(frame.height * m), upscale: 1, subjectCut: 0, sourceId: id, fit: fit(id) }), () => null);
  const prepared = new Map<string, PreparedImage>();
  const uniq = [...new Map(dry.usage.map((u) => [`${u.assetId}@${u.margin}`, u])).values()];
  await ctx.log.time(`prepare-assets:${format}`, `Préparation de ${uniq.length} dérivé(s) d’illustration`, async () => {
    for (const u of uniq) prepared.set(`${u.assetId}@${u.margin}`, await prepareImage(b, stats, look, u.assetId, format, u.margin));
  });
  // Passe 2 : compilation réelle.
  const resolver = (id: string, m: number): ImageInfo => {
    const p = prepared.get(`${id}@${m}`)!;
    return { rel: p.rel, sha: p.sha, w: p.w, h: p.h, upscale: p.upscale, subjectCut: p.subjectCut, sourceId: p.sourceId, fit: fit(p.sourceId) };
  };
  const pre = opts.preroll === false ? 0 : Math.round((b.project.preroll?.sec ?? 0) * b.project.fps);
  const res = compileTimeline(b, format, sync, analysis, resolver, stage, { prerollFrames: pre });
  if (pre > 0) {
    res.timeline = applyPreroll(res.timeline, pre);
    ctx.log.info(`Préambule : ${pre} images (${(pre / b.project.fps).toFixed(3)} s) avant le début du master audio`);
  }
  const file = resolvedFile(b.dir, format);
  assertValid('timeline-resolved', res.timeline, file);
  writeJsonAtomic(file, res.timeline);
  for (const w of res.warnings) {
    if (w.code.endsWith('-info') || w.code.startsWith('I_')) ctx.log.info(w.message, { code: w.code, at: w.at });
    else ctx.warn(w.code, w.message, { at: w.at });
  }
  return { timeline: res.timeline, warnings: res.warnings, prepared: [...prepared.values()], file };
}

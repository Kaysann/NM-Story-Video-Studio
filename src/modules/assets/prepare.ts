import fs from 'node:fs';
import path from 'node:path';
import { NmsvsError } from '../../core/errors';
import { ensureDir, readJson, writeJsonAtomic } from '../../core/fsx';
import { hashFileSync, hashObject, shortKey } from '../../core/hash';
import { ffmpeg } from '../../core/tools';
import { run } from '../../core/exec';
import { TOOLS } from '../../core/tools';
import type { RunContext } from '../../core/context';
import { projectPath, type ProjectBundle } from '../../model/project';
import type { ImageAsset } from '../../model/types';
import { runStep } from '../../pipeline/step';
import { callPython } from '../python/bridge';
import { applyGrade, colorFilters, harmonizeOps, harmonizeTarget, NEUTRAL, type ColorOps, type ImageStats } from './color';
import { derivativeSize, fitFor, resolveImageForFormat, sourceRegion, subjectCutRatio, type PixelRect } from './crop';

export const assetsDir = (b: { dir: string }) => path.join(b.dir, 'build', 'assets');
const statsFile = (b: { dir: string }) => path.join(b.dir, 'analysis', 'assets.stats.json');

export interface StatsBundle { images: Record<string, ImageStats>; target: ReturnType<typeof harmonizeTarget> | null; proposed: Record<string, ColorOps> }

/** Statistiques couleur de toutes les images (cache par contenu) + corrections proposées. */
export async function imageStats(ctx: RunContext, b: ProjectBundle): Promise<StatsBundle> {
  const images = b.assets.images.map((i) => ({ id: i.id, path: projectPath(b, i.path), sha: hashFileSync(projectPath(b, i.path)) }));
  const harm = b.project.art.harmonize ?? { mode: 'auto', strength: 0.5 };
  const file = statsFile(b);
  const { value } = await runStep(ctx, b.dir, {
    id: 'image-stats',
    version: 1,
    inputs: { images: images.map((i) => [i.id, i.sha]), harm, excluded: b.assets.images.filter((i) => i.grade?.excludeFromHarmonize).map((i) => i.id) },
    outputs: [file],
    load: () => readJson<StatsBundle>(file),
    run: async () => {
      const res = await callPython<{ images: Record<string, ImageStats> }>(ctx, 'image-stats', { images: images.map((i) => ({ id: i.id, path: i.path })) },
        { convertDir: path.join(b.dir, 'build', 'srgb') }, path.join(b.dir, 'build'));
      const st = res.outputs.images;
      const pool = Object.fromEntries(Object.entries(st).filter(([id]) => !b.assets.images.find((i) => i.id === id)?.grade?.excludeFromHarmonize));
      const target = harm.mode === 'auto' && Object.keys(pool).length >= 2 ? harmonizeTarget(pool, harm.reference) : null;
      const proposed: Record<string, ColorOps> = {};
      for (const [id, s] of Object.entries(st)) {
        const excluded = !pool[id];
        proposed[id] = target && !excluded ? harmonizeOps(s, target, harm.strength ?? 0.5) : { ...NEUTRAL };
      }
      const out: StatsBundle = { images: st, target, proposed };
      writeJsonAtomic(file, out);
      return out;
    },
  });
  return value;
}

export interface Look { lutFile: string | null; lutSha: string | null; intensity: number }

export function resolveLook(b: ProjectBundle): Look {
  const cl = b.project.art.colorLook;
  if (!cl?.lut || !(cl.intensity ?? 1)) return { lutFile: null, lutSha: null, intensity: 0 };
  const candidates = [projectPath(b, cl.lut), path.resolve(cl.lut)];
  const f = candidates.find((c) => fs.existsSync(c));
  if (!f) throw new NmsvsError('E_ASSET_MISSING', `LUT introuvable : ${cl.lut}`, 'Vérifier art.colorLook.lut dans project.json.');
  return { lutFile: f, lutSha: hashFileSync(f), intensity: cl.intensity ?? 1 };
}

export interface PreparedImage {
  assetId: string;
  sourceId: string;
  rel: string; // relatif à build/assets, séparateur « / »
  sha: string; // clé de contenu du dérivé (entre dans les clés de segment)
  w: number;
  h: number;
  upscale: number;
  region: PixelRect;
  rule: string;
  subjectCut: number;
  ops: ColorOps;
}

/** Produit (ou réutilise) le dérivé d'une image pour un format : sRGB, recadré, redimensionné, étalonné, LUT. */
export async function prepareImage(b: ProjectBundle, stats: StatsBundle, look: Look, assetId: string, format: string, margin: number): Promise<PreparedImage> {
  const frame = b.project.formats[format];
  const img: ImageAsset = resolveImageForFormat(b.assets.images, assetId, format);
  const st = stats.images[img.id];
  const srcPath = st?.srgbPath && fs.existsSync(st.srgbPath) ? st.srgbPath : projectPath(b, img.path);
  const size = img.size ?? { w: 0, h: 0 };
  if (!size.w) throw new NmsvsError('E_ASSET_MISSING', `Dimensions inconnues pour ${img.id}`, 'Relancer `nmsvs import images` ou `nmsvs validate --refresh`.');
  const { region, rule } = sourceRegion({ ...img, size }, format, frame);
  const fit = fitFor(img, format);
  const d = derivativeSize(region, frame, margin, fit);
  const ops = applyGrade(stats.proposed[img.id] ?? { ...NEUTRAL }, img.grade);
  const key = hashObject({ v: 1, src: hashFileSync(projectPath(b, img.path)), region, w: d.w, h: d.h, ops, lut: look.lutSha, intensity: look.intensity });
  const rel = `img/${shortKey(key)}.png`;
  const out = path.join(assetsDir(b), 'img', `${shortKey(key)}.png`);
  if (!fs.existsSync(out)) {
    ensureDir(path.dirname(out));
    const chain = [`crop=${region.w}:${region.h}:${region.x}:${region.y}`, `scale=${d.w}:${d.h}:flags=lanczos`, ...colorFilters(ops), 'format=gbrp'];
    const tmp = out.replace(/\.png$/, '.tmp.png');
    if (look.lutFile && look.intensity > 0) {
      // LUT copiée sous un nom court : évite l'échappement des chemins Windows dans le graphe de filtres.
      const lutDir = path.join(assetsDir(b), 'lut');
      ensureDir(lutDir);
      const lutName = `${look.lutSha!.slice(0, 16)}.cube`;
      if (!fs.existsSync(path.join(lutDir, lutName))) fs.copyFileSync(look.lutFile, path.join(lutDir, lutName));
      const i = look.intensity;
      const graph = `[0:v]${chain.join(',')},split[a][b];[b]lut3d=file=${lutName}:interp=tetrahedral[l];[a][l]blend=all_expr='A*(1-${i})+B*${i}',format=rgb24[o]`;
      await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', srcPath, '-filter_complex', graph, '-map', '[o]', '-frames:v', '1', tmp], { cwd: lutDir, check: true, errorCode: 'E_FFMPEG' });
    } else {
      await ffmpeg(['-i', srcPath, '-vf', [...chain, 'format=rgb24'].join(','), '-frames:v', '1', tmp]);
    }
    fs.renameSync(tmp, out);
  }
  return { assetId, sourceId: img.id, rel, sha: key, w: d.w, h: d.h, upscale: d.upscale, region, rule, subjectCut: subjectCutRatio({ ...img, size }, region), ops };
}

/** Copie d'un fichier (texture, police) sous un nom de contenu dans build/assets. */
export function stageFile(b: ProjectBundle, absPath: string, sub: 'tex' | 'fonts'): { rel: string; sha: string } {
  if (!fs.existsSync(absPath)) throw new NmsvsError('E_ASSET_MISSING', `Fichier introuvable : ${absPath}`);
  const sha = hashFileSync(absPath);
  const name = `${sha.slice(0, 16)}${path.extname(absPath).toLowerCase()}`;
  const out = path.join(assetsDir(b), sub, name);
  if (!fs.existsSync(out)) {
    ensureDir(path.dirname(out));
    fs.copyFileSync(absPath, out);
  }
  return { rel: `${sub}/${name}`, sha };
}

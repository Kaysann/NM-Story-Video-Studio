import type { Grade } from '../../model/types';

export interface ImageStats { lumaMean: number; lumaMedian: number; lumaP1: number; lumaP99: number; aMean: number; bMean: number; satMean: number; icc: string | null; srgbPath: string | null }

export interface ColorOps {
  gamma: number; // eq gamma (>1 éclaircit)
  contrast: number; // eq contrast (1 = neutre)
  saturation: number; // eq saturation (1 = neutre)
  rm: number; gm: number; bm: number; // colorbalance tons moyens (-1..1)
  exposure: number; // EV (filtre exposure)
}

export const NEUTRAL: ColorOps = { gamma: 1, contrast: 1, saturation: 1, rm: 0, gm: 0, bm: 0, exposure: 0 };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r4 = (x: number) => Math.round(x * 10000) / 10000 + 0; // « + 0 » : pas de -0

/** Cible d'harmonisation : médiane du lot, ou image de référence. */
export function harmonizeTarget(all: Record<string, ImageStats>, reference?: string) {
  const vals = reference && all[reference] ? [all[reference]] : Object.values(all);
  return {
    luma: median(vals.map((v) => v.lumaMedian)),
    spread: median(vals.map((v) => v.lumaP99 - v.lumaP1)),
    a: median(vals.map((v) => v.aMean)),
    b: median(vals.map((v) => v.bMean)),
    sat: median(vals.map((v) => v.satMean)),
  };
}

/**
 * Correction proposée pour rapprocher une image de la cible, BORNÉE puis pondérée par `strength`.
 * Bornes : ±0,5 EV environ (via gamma), contraste ±15 %, saturation ±15 %, balance ±0,1.
 */
export function harmonizeOps(s: ImageStats, target: ReturnType<typeof harmonizeTarget>, strength: number): ColorOps {
  if (strength <= 0) return { ...NEUTRAL };
  const dL = target.luma - s.lumaMedian;
  const gamma = Math.pow(clamp(Math.pow(2, dL / 40), 0.7, 1.4), strength);
  const spread = Math.max(1, s.lumaP99 - s.lumaP1);
  const contrast = Math.pow(clamp(target.spread / spread, 0.85, 1.15), strength);
  const saturation = Math.pow(clamp(target.sat / Math.max(0.01, s.satMean), 0.85, 1.15), strength);
  const db = target.b - s.bMean; // + = plus chaud (jaune)
  const da = target.a - s.aMean; // + = plus magenta
  return {
    gamma: r4(gamma),
    contrast: r4(contrast),
    saturation: r4(saturation),
    rm: r4(clamp(db * 0.004 + da * 0.003, -0.1, 0.1) * strength),
    gm: r4(clamp(-da * 0.004, -0.1, 0.1) * strength),
    bm: r4(clamp(-db * 0.006, -0.1, 0.1) * strength),
    exposure: 0,
  };
}

/** Ajustements manuels (assets.json → grade), ADDITIFS à l'harmonisation. */
export function applyGrade(ops: ColorOps, g: Grade | undefined): ColorOps {
  if (!g) return ops;
  return {
    ...ops,
    exposure: r4(ops.exposure + (g.exposure ?? 0)),
    contrast: r4(ops.contrast * (1 + (g.contrast ?? 0) * 0.5)),
    saturation: r4(ops.saturation * (1 + (g.saturation ?? 0))),
    rm: r4(clamp(ops.rm + (g.temperature ?? 0) * 0.15, -1, 1)),
    bm: r4(clamp(ops.bm - (g.temperature ?? 0) * 0.15, -1, 1)),
  };
}

export function isNeutral(o: ColorOps) {
  return JSON.stringify(o) === JSON.stringify(NEUTRAL);
}

/** Chaîne de filtres FFmpeg correspondante. */
export function colorFilters(o: ColorOps): string[] {
  const f: string[] = [];
  if (o.exposure) f.push(`exposure=exposure=${o.exposure}`);
  if (o.gamma !== 1 || o.contrast !== 1 || o.saturation !== 1) f.push(`eq=gamma=${o.gamma}:contrast=${o.contrast}:saturation=${o.saturation}`);
  if (o.rm || o.gm || o.bm) f.push(`colorbalance=rm=${o.rm}:gm=${o.gm}:bm=${o.bm}`);
  return f;
}

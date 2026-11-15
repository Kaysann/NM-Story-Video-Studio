import { hashObject, shortKey } from '../../core/hash';
import type { RTimeline } from '../../remotion/types';

export interface SegmentPlan { from: number; to: number; key: string }
export interface MezzanineSettings { codec: 'h264' | 'prores'; crf: number; preset: string; imageFormat: 'jpeg' | 'png'; jpegQuality: number; scale: number }

export const DEFAULT_MEZZANINE: MezzanineSettings = { codec: 'h264', crf: 10, preset: 'veryfast', imageFormat: 'jpeg', jpegQuality: 95, scale: 1 };

/** Zones où l'on évite de couper : transitions à chevauchement et calques de fondu. */
export function forbiddenWindows(t: RTimeline): [number, number][] {
  const w: [number, number][] = [];
  for (const s of t.shots) {
    if (s.enter && s.enter.frames > 0) w.push([s.from, s.from + s.enter.frames]);
  }
  for (const f of t.fades) w.push([f.from, f.to]);
  return w;
}

/**
 * Découpe en segments de `target` images environ (bornes [min, max]),
 * en privilégiant les débuts de plan hors transitions.
 */
export function planCuts(t: RTimeline, target = 300, min = 120, max = 600): number[] {
  const D = t.durationInFrames;
  const forb = forbiddenWindows(t);
  const allowed = (f: number) => !forb.some(([a, b]) => f > a && f < b);
  const shotStarts = [...new Set(t.shots.map((s) => s.from))].filter((f) => f > 0 && f < D && allowed(f)).sort((a, b) => a - b);
  const cuts = [0];
  let start = 0;
  while (D - start > max) {
    const lo = start + min;
    const hi = start + max;
    const ideal = start + target;
    const pref = shotStarts.filter((f) => f >= lo && f <= hi);
    let cut: number | undefined = pref.sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0];
    if (cut === undefined) {
      for (let d = 0; d <= max - min; d++) {
        if (ideal + d <= hi && allowed(ideal + d)) { cut = ideal + d; break; }
        if (ideal - d >= lo && allowed(ideal - d)) { cut = ideal - d; break; }
      }
    }
    cut ??= ideal;
    cuts.push(cut);
    start = cut;
  }
  cuts.push(D);
  return cuts;
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

/**
 * Clé de cache d'un segment : TOUT ce qui peut influencer ses images (CHANGELOG C-03).
 * Les éléments touchant l'intervalle sont inclus en entier (transitions, styles résolus, dérivés
 * d'images identifiés par leur contenu, polices, textures), plus le code des composants et
 * les réglages d'encodage. L'URL du serveur d'assets (variable) est exclue.
 */
export function segmentKey(t: RTimeline, from: number, to: number, componentsHash: string, mezz: MezzanineSettings): string {
  const shots = t.shots.filter((s) => overlaps(s.from, s.to, from, to));
  const lyrics = t.lyrics.filter((l) => overlaps(l.groupFrom, l.groupTo, from, to));
  const titles = t.titles.filter((x) => overlaps(x.from, x.to, from, to));
  const fades = t.fades.filter((f) => overlaps(f.from, f.to, from, to));
  const ranges = (t.effectRanges ?? []).filter((r) => overlaps(r.from, r.to, from, to));
  const sprites = (t.sprites ?? []).filter((s) => overlaps(s.from, s.to, from, to));
  return hashObject({
    v: 1,
    format: t.format, width: t.width, height: t.height, fps: t.fps, durationInFrames: t.durationInFrames,
    from, to, componentsHash, mezz,
    shots, lyrics, titles, fades, effects: t.effects, ranges, fonts: t.fonts, showSafe: !!t.showSafe,
    // Ajouté seulement s'il y en a : les clés des segments sans sprite restent identiques (cache existant valide).
    ...(sprites.length ? { sprites } : {}),
  });
}

export function planSegments(t: RTimeline, componentsHash: string, mezz: MezzanineSettings = DEFAULT_MEZZANINE, target?: number): SegmentPlan[] {
  const cuts = planCuts(t, target ?? Math.round(t.fps * 10), Math.round(t.fps * 4), Math.round(t.fps * 20));
  const out: SegmentPlan[] = [];
  for (let i = 0; i < cuts.length - 1; i++) out.push({ from: cuts[i], to: cuts[i + 1], key: shortKey(segmentKey(t, cuts[i], cuts[i + 1], componentsHash, mezz)) });
  return out;
}

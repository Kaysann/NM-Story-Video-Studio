import { describe, expect, it } from 'vitest';
import { derivativeSize, fitFor, resolveImageForFormat, sourceRegion, subjectCutRatio } from '../../src/modules/assets/crop';
import { applyGrade, colorFilters, harmonizeOps, harmonizeTarget, NEUTRAL } from '../../src/modules/assets/color';
import { cameraAt, ease, fadeOpacity, layerOrder, pageTurnAt, placeImage, ramp, transitionStyle } from '../../src/remotion/anim';
import type { RShot } from '../../src/remotion/types';

const img = { size: { w: 4000, h: 3000 }, focal: { x: 0.9, y: 0.5 } } as any;
const V = { width: 1080, height: 1920 };
const Hz = { width: 3840, height: 2160 };

describe('recadrage', () => {
  it('priorité : cadrage explicite > point focal > centre ; contain/blurFill = image entière', () => {
    expect(sourceRegion({ ...img, crops: { '9x16': { x: 0.1, y: 0, w: 0.3, h: 1 } } }, '9x16', V)).toEqual({ region: { x: 400, y: 0, w: 1200, h: 3000 }, rule: 'crop' });
    const f = sourceRegion(img, '9x16', V);
    expect(f.rule).toBe('focal');
    expect(f.region.h).toBe(3000);
    expect(f.region.x + f.region.w).toBe(4000); // borné au bord droit (point focal à 0,9)
    expect(Math.abs(f.region.w / f.region.h - 1080 / 1920)).toBeLessThan(0.002);
    expect(sourceRegion({ size: img.size }, '16x9', Hz).rule).toBe('center');
    expect(sourceRegion({ ...img, fit: 'blurFill' }, '9x16', V).region).toEqual({ x: 0, y: 0, w: 4000, h: 3000 });
  });
  it('ajustement par format (fits) : blurFill en 9:16 seulement, 16:9 inchangé', () => {
    const im = { ...img, fits: { '9x16': 'blurFill' as const } };
    expect(fitFor(im, '9x16')).toBe('blurFill');
    expect(fitFor(im, '16x9')).toBe('cover');
    expect(fitFor({ fit: 'contain', fits: { '9x16': 'cover' } }, '9x16')).toBe('cover'); // fits prime sur fit
    expect(sourceRegion(im, '9x16', V)).toEqual({ region: { x: 0, y: 0, w: 4000, h: 3000 }, rule: 'full' });
    expect(sourceRegion(im, '16x9', Hz)).toEqual(sourceRegion(img, '16x9', Hz)); // aucune incidence sur le 16:9
  });
  it('remplacement par format', () => {
    const imgs = [{ id: 'a', path: 'a', replace: { '9x16': 'b' } }, { id: 'b', path: 'b' }] as any;
    expect(resolveImageForFormat(imgs, 'a', '9x16').id).toBe('b');
    expect(resolveImageForFormat(imgs, 'a', '16x9').id).toBe('a');
  });
  it('taille du dérivé et facteur d’agrandissement ; sujet coupé', () => {
    const d = derivativeSize({ x: 0, y: 0, w: 1920, h: 1080 }, Hz, 1.1, 'cover');
    expect(d).toEqual({ w: 4224, h: 2376, upscale: 2.2 });
    expect(subjectCutRatio({ size: { w: 100, h: 100 }, safeSubject: { x: 0, y: 0, w: 0.5, h: 1 } }, { x: 25, y: 0, w: 75, h: 100 })).toBeCloseTo(0.5);
  });
});

describe('harmonisation colorimétrique', () => {
  const s = (lumaMedian: number, bMean: number, satMean: number) => ({ lumaMean: lumaMedian, lumaMedian, lumaP1: 5, lumaP99: 95, aMean: 0, bMean, satMean, icc: null, srgbPath: null });
  it('corrections bornées, pondérées, neutres pour l’image médiane', () => {
    const all = { a: s(30, 5, 0.3), b: s(50, 10, 0.4), c: s(70, 15, 0.5) };
    const t = harmonizeTarget(all);
    expect(harmonizeOps(all.b, t, 1)).toEqual({ ...NEUTRAL });
    const dark = harmonizeOps(all.a, t, 1);
    expect(dark.gamma).toBeGreaterThan(1);
    expect(dark.gamma).toBeLessThanOrEqual(1.4);
    expect(harmonizeOps(s(0, 60, 0.01), t, 1).saturation).toBeLessThanOrEqual(1.15);
    expect(harmonizeOps(all.a, t, 0)).toEqual(NEUTRAL);
    expect(Math.abs(harmonizeOps(all.a, t, 0.5).gamma - 1)).toBeLessThan(Math.abs(dark.gamma - 1));
  });
  it('ajustements manuels additifs et filtres FFmpeg', () => {
    const o = applyGrade({ ...NEUTRAL }, { exposure: 0.5, temperature: 0.4 });
    expect(colorFilters(o)).toEqual(['exposure=exposure=0.5', 'colorbalance=rm=0.06:gm=0:bm=-0.06']);
    expect(colorFilters(NEUTRAL)).toEqual([]);
  });
});

describe('animations (fonctions pures des compositions)', () => {
  const shot: RShot = { id: 's', sceneId: 'x', from: 100, to: 200, src: '', srcW: 4224, srcH: 2376, fit: 'cover', z: 0, motion: { from: { scale: 1, x: 0, y: 0.5 }, to: { scale: 1.1, x: 1, y: 0.5 }, easing: 'linear', pulseFrames: [150], pulseIntensity: 0.02 } };
  it('courbes bornées et monotones', () => {
    for (const e of ['linear', 'inOutSine', 'inOutCubic', 'outExpo', 'inOutQuad'] as const) {
      expect(ease(e, 0)).toBeCloseTo(0);
      expect(ease(e, 1)).toBeCloseTo(1);
      expect(ease(e, 0.6)).toBeGreaterThan(ease(e, 0.4));
    }
  });
  it('caméra : interpolation et pulsation sur temps fort', () => {
    expect(cameraAt(shot, 100)).toEqual({ scale: 1, x: 0, y: 0.5 });
    expect(cameraAt(shot, 199).scale).toBeCloseTo(1.1);
    expect(cameraAt(shot, 150).scale).toBeGreaterThan(cameraAt(shot, 149).scale + 0.015);
  });
  it('placement : l’image couvre toujours le cadre', () => {
    for (const cam of [{ scale: 1, x: 0, y: 0 }, { scale: 1.2, x: 1, y: 1 }, { scale: 1.05, x: 0.5, y: 0.3 }]) {
      const p = placeImage(4224, 2376, 3840, 2160, cam, 'cover');
      expect(p.left).toBeLessThanOrEqual(0);
      expect(p.top).toBeLessThanOrEqual(0);
      expect(p.left + p.width).toBeGreaterThanOrEqual(3840 - 1e-6);
      expect(p.top + p.height).toBeGreaterThanOrEqual(2160 - 1e-6);
    }
  });
  it('transitions : bornes de progression', () => {
    expect(transitionStyle({ type: 'crossfade', frames: 10 }, 'in', 0).opacity).toBeCloseTo(0);
    expect(transitionStyle({ type: 'crossfade', frames: 10 }, 'in', 1).opacity).toBeCloseTo(1);
    expect(transitionStyle({ type: 'slide', frames: 10, direction: 'left' }, 'in', 0).translateX).toBeCloseTo(1);
    expect(transitionStyle({ type: 'slide', frames: 10, direction: 'left' }, 'out', 1).translateX).toBeCloseTo(-1);
    expect(transitionStyle({ type: 'wipe', frames: 10, shape: 'radial' }, 'in', 1).clipPath).toBe('circle(75.000% at 50% 50%)');
    expect(transitionStyle({ type: 'zoom-through', frames: 10 }, 'out', 1).opacity).toBeCloseTo(0);
  });
  it('page tournée : pivot 0° → 90° sur la reliure, ombres bornées, page sortante au-dessus', () => {
    // Géométrie : à plat au départ, de chant à la fin ; bord libre projeté décroissant de 1 à 0.
    const g0 = pageTurnAt(0);
    const g1 = pageTurnAt(1);
    expect(g0.angle).toBeCloseTo(0);
    expect(g0.edge).toBeCloseTo(1);
    expect(g1.angle).toBeCloseTo(-90);
    expect(g1.edge).toBeCloseTo(0);
    expect(pageTurnAt(1, 'right').angle).toBeCloseTo(90);
    let prev = Infinity;
    for (let q = 0; q <= 1.0001; q += 0.05) {
      const g = pageTurnAt(q);
      // Perspective : le bord libre, soulevé vers le spectateur, déborde du cadre au début (maximum pour
      // sin θ = 1/P : 4·cos θ/(4 − 1/4) ≈ 1,033, hors champ),
      // puis recule continûment vers la reliure.
      expect(g.edge).toBeLessThan(1.034);
      if (q > 0.3) expect(g.edge).toBeLessThanOrEqual(prev + 1e-9);
      prev = g.edge;
      for (const v of [g.shade, g.shadow, g.under]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(0.6 + 1e-9); }
    }
    expect(g0.shadow).toBeCloseTo(0);
    expect(g1.shadow).toBeCloseTo(0);
    expect(pageTurnAt(0.5).shadow).toBeCloseTo(0.6);
    // Rôles : la page sortante pivote, la page entrante reste fixe et ombrée.
    const tr = { type: 'page-turn' as const, frames: 60, direction: 'left' as const };
    const out = transitionStyle(tr, 'out', 0.5).page!;
    const inn = transitionStyle(tr, 'in', 0.5).page!;
    expect(out).toMatchObject({ part: 'page', spine: 'left' });
    expect(out.rotateY).toBeCloseTo(-45);
    expect(inn).toMatchObject({ part: 'under', rotateY: 0 });
    expect(transitionStyle(tr, 'in', 0.5).opacity).toBe(1); // aucune transparence : effet de livre, pas de fondu
    expect(transitionStyle(tr, 'out', 0.5).opacity).toBe(1);
    // Empilement : pendant sa sortie, la page tournée passe au-dessus de la suivante (z supérieur).
    const a = { z: 0, from: 0, to: 100, exit: tr } as unknown as RShot;
    const b = { z: 1, from: 40, to: 200, enter: tr } as unknown as RShot;
    expect(layerOrder(a, 50)).toBeGreaterThan(layerOrder(b, 50));
    expect(layerOrder(a, 30)).toBeLessThan(layerOrder(b, 30)); // hors transition : ordre normal
  });
  it('fondus et rampes', () => {
    const f = { from: 10, peak: 20, to: 30 };
    expect(fadeOpacity(f, 9)).toBe(0);
    expect(fadeOpacity(f, 20)).toBe(1);
    expect(fadeOpacity(f, 29)).toBeGreaterThan(0);
    expect(fadeOpacity(f, 30)).toBe(0);
    expect(fadeOpacity({ from: 0, peak: 0, to: 10 }, 0)).toBe(1);
    expect(ramp(5, 0, 100, 10, 10)).toBeCloseTo(0.6);
    expect(ramp(100, 0, 100, 10, 10)).toBe(0);
  });
});

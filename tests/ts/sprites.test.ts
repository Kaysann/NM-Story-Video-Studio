import { describe, expect, it } from 'vitest';
import { applyPreroll, compileTimeline } from '../../src/modules/timeline/compile';
import { segmentKey } from '../../src/modules/render/segments';
import { sliceTimeline } from '../../src/modules/reels/reels';
import { validate } from '../../src/model/schemas';
import { spriteAt } from '../../src/remotion/components/Sprite';
import type { SpriteSpec } from '../../src/model/types';
import { analysis, bundle, fakeImages, noStage, syncFor } from './helpers';

const A = analysis();
const S = syncFor();
const W = 3840, H = 2160;
const poses = (p: string) => Array.from({ length: 8 }, (_, i) => `${p}-0${i + 1}`);
const stage = (_k: 'font' | 'texture', id: string) => ({ rel: `tex/${id}.png`, sha: id });

function withSprites(sprites: SpriteSpec[]) {
  const b = bundle();
  b.assets.textures = [...poses('perso-a'), ...poses('perso-b')].map((id) => ({ id, path: `media/textures/${id}.png` }));
  b.timeline!.scenes[3].sprites = sprites;
  return b;
}
const PERSO_A: SpriteSpec = { id: 'perso-a', frames: poses('perso-a'), poseFps: 8, height: 0.2, path: { from: { x: 0.9, y: 0.86 }, to: { x: 0.1, y: 0.86 } }, startSec: 1, durationSec: 8 };
const PERSO_B: SpriteSpec = { id: 'perso-b', frames: poses('perso-b'), height: 0.2, path: { from: { x: 0.1, y: 0.9 }, to: { x: 0.9, y: 0.9 } }, startSec: 1, durationSec: 8 };

describe('première transition et préambule', () => {
  // Couverture très courte en temps chanson (0 → 0,5 s) suivie d'une page tournée de 1 s.
  const b = bundle();
  b.timeline!.scenes[0].span.to = { at: 0.5 };
  b.timeline!.scenes[1].span.from = { at: 0.5 };
  b.timeline!.scenes[1].transitionIn = { type: 'page-turn', duration: { sec: 1 } };
  it('sans préambule : transition bornée à 40 % du plan de couverture (comportement inchangé)', () => {
    const t = compileTimeline(b, '16x9', S, A, fakeImages(W, H), stage).timeline;
    expect(t.shots[1].enter?.frames ?? 0).toBeLessThan(30);
  });
  it('avec préambule : la couverture prolongée autorise la page tournée complète, finie à 1 s de chanson', () => {
    const t = applyPreroll(compileTimeline(b, '16x9', S, A, fakeImages(W, H), stage, { prerollFrames: 90 }).timeline, 90);
    expect(t.shots[1].enter?.frames).toBe(30);
    expect(t.shots[1].from).toBe(90); // début de la chanson
    expect(t.shots[0].to).toBe(120); // fin du retournement : 1,0 s de chanson
    expect(t.shots[0].from).toBe(0);
  });
});

describe('sprites (personnages animés)', () => {
  const b = withSprites([PERSO_A, PERSO_B]);
  const r = compileTimeline(b, '16x9', S, A, fakeImages(W, H), stage);
  const t = r.timeline;
  const scene = t.shots.find((s) => s.sceneId === 'sc-rest')!;
  const sceneFrom = Math.min(...t.shots.filter((s) => s.sceneId === 'sc-rest').map((s) => s.from));

  it('timeline humaine et résolue valides', () => {
    expect(validate('timeline', b.timeline)).toEqual([]);
    expect(validate('timeline-resolved', t)).toEqual([]);
    expect(scene).toBeDefined();
  });

  it('bornes relatives à la scène, pixels, poses préparées, ordre de profondeur', () => {
    const [m, n] = t.sprites!;
    expect(m.id).toBe('sc-rest-perso-a');
    expect(m.to - m.from).toBe(240);
    expect(m.height).toBe(432);
    expect(m.path.from).toEqual({ x: 3456, y: 1858 });
    expect(m.frames[0]).toBe('tex/perso-a-01.png');
    expect(n.poseFps).toBe(8); // défaut
    expect(n.z).toBeGreaterThan(m.z); // plus bas = devant
    expect(m.from).toBeGreaterThanOrEqual(sceneFrom - 30); // tolérance des jointures de transition
  });

  it('pose cyclique, vitesse constante, fondus aux extrémités', () => {
    const m = t.sprites![0];
    expect(spriteAt(m, m.from, 30).pose).toBe(0);
    expect(spriteAt(m, m.from + 4, 30).pose).toBe(1); // 8 poses/s à 30 i/s
    expect(spriteAt(m, m.from + 30, 30).pose).toBe(0); // un cycle par seconde
    const x = (k: number) => spriteAt(m, m.from + k, 30).x;
    expect(x(0)).toBe(m.path.from.x);
    expect(x(m.to - m.from - 1)).toBe(m.path.to.x);
    expect(x(11) - x(10)).toBeCloseTo(x(201) - x(200), 6); // vitesse constante
    expect(spriteAt(m, m.from, 30).opacity).toBeLessThan(0.2);
    expect(spriteAt(m, m.from + 60, 30).opacity).toBe(1);
    expect(spriteAt(m, m.to - 1, 30).opacity).toBeLessThan(0.2);
  });

  it('préambule et découpage Shorts décalent les sprites', () => {
    const p = applyPreroll(t, 90);
    expect(p.sprites![0].from).toBe(t.sprites![0].from + 90);
    const s = sliceTimeline(t, 100, 2700);
    expect(s.sprites![0].from).toBe(t.sprites![0].from - 100);
  });

  it('la clé de cache change avec un sprite, et reste identique sans sprite', () => {
    const plain = compileTimeline(bundle(), '16x9', S, A, fakeImages(W, H), stage).timeline;
    const sp = t.sprites![0];
    const keyWith = segmentKey(t, sp.from, sp.to, 'c', { crf: 1 } as never);
    const moved = { ...t, sprites: t.sprites!.map((x, i) => (i === 0 ? { ...x, height: x.height + 1 } : x)) };
    expect(segmentKey(moved, sp.from, sp.to, 'c', { crf: 1 } as never)).not.toBe(keyWith);
    expect(plain.sprites).toBeUndefined();
    expect(segmentKey(plain, 0, 300, 'c', { crf: 1 } as never)).toBe(segmentKey({ ...plain, sprites: [] }, 0, 300, 'c', { crf: 1 } as never));
  });

  it('pose inconnue : erreur explicite ; trajet trop long : avertissement', () => {
    const bad = withSprites([{ ...PERSO_A, frames: ['inconnue'] }]);
    expect(() => compileTimeline(bad, '16x9', S, A, fakeImages(W, H), stage)).toThrow(/pose\(s\) inconnue/);
    const long = compileTimeline(withSprites([{ ...PERSO_A, durationSec: 999 }]), '16x9', S, A, fakeImages(W, H), noStage);
    expect(long.warnings.some((w) => w.code === 'W_SPRITE_CUT')).toBe(true);
  });
});

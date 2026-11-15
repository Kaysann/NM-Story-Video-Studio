import { describe, expect, it } from 'vitest';
import { compileTimeline } from '../../src/modules/timeline/compile';
import { validate } from '../../src/model/schemas';
import { texturedParchmentState } from '../../src/remotion/anim';
import type { LyricsStyle } from '../../src/model/types';
import { analysis, bundle, fakeImages, syncFor } from './helpers';

const A = analysis();
const S = syncFor();
const W = 3840, H = 2160;
const PAPER = { x: 0.13, y: 0.385, w: 0.74, h: 0.215 };
const stage = (_k: 'font' | 'texture', id: string) => ({ rel: `tex/${id}.png`, sha: id, w: 2172, h: 724 });
const style = (paper?: typeof PAPER): LyricsStyle => ({
  type: 'parchment', flow: 'phrase', lines: 2, leadSec: 0, karaoke: 'none', maxWidth: 0.92,
  fontSize: { min: 0.024, max: 0.034 }, parchment: { texture: 'bandeau', ...(paper ? { paper } : {}) },
});

function compile(paper?: typeof PAPER) {
  const b = bundle();
  b.assets.textures = [{ id: 'bandeau', path: 'media/textures/bandeau.png' }];
  b.timeline!.scenes[1].lyrics = { style: style(paper) };
  expect(validate('timeline', b.timeline)).toEqual([]);
  return compileTimeline(b, '16x9', S, A, fakeImages(W, H), stage).timeline;
}

describe('parchemin texturé (bandeau fourni)', () => {
  const t = compile(PAPER);
  const ls = t.lyrics.filter((l) => l.sceneId === 'sc-v1');

  it('bandeau aux proportions de la texture, zone de papier = boîte du groupe', () => {
    expect(validate('timeline-resolved', t)).toEqual([]);
    const l = ls[0];
    const p = l.panelBox!;
    expect(p.w / p.h).toBeCloseTo(2172 / 724, 2);
    expect(l.groupBox.x).toBe(Math.round(p.x + PAPER.x * p.w));
    expect(l.groupBox.w).toBe(Math.round(PAPER.w * p.w));
    expect(l.groupBox.y).toBe(Math.round(p.y + PAPER.y * p.h));
  });

  it('chaque ligne de texte tient dans la zone de papier', () => {
    for (const l of ls) {
      expect(l.lines.length).toBe(1);
      expect(l.box.y).toBeGreaterThanOrEqual(l.groupBox.y);
      expect(l.box.y + l.box.h).toBeLessThanOrEqual(l.groupBox.y + l.groupBox.h + 1);
      expect(l.box.x).toBeGreaterThanOrEqual(l.groupBox.x);
      expect(l.box.x + l.box.w).toBeLessThanOrEqual(l.groupBox.x + l.groupBox.w);
    }
  });

  it('sans zone de papier : rendu procédural inchangé (pas de panelBox)', () => {
    const t2 = compile(undefined);
    expect(t2.lyrics.every((l) => l.panelBox === undefined)).toBe(true);
  });

  it('sceneBreak : un conteneur par scène même si le chant continue', () => {
    const b = bundle();
    b.assets.textures = [{ id: 'bandeau', path: 'media/textures/bandeau.png' }];
    for (const sc of b.timeline!.scenes) sc.lyrics = { style: { ...style(PAPER), sceneBreak: true } };
    expect(validate('timeline', b.timeline)).toEqual([]);
    const t2 = compileTimeline(b, '16x9', S, A, fakeImages(W, H), stage).timeline;
    for (const gid of new Set(t2.lyrics.map((l) => l.groupId))) {
      expect(new Set(t2.lyrics.filter((l) => l.groupId === gid).map((l) => l.sceneId)).size).toBe(1);
    }
  });

  it('centerX : bandeau et texte déplacés ensemble, hauteur et taille inchangées', () => {
    const b = bundle();
    b.assets.textures = [{ id: 'bandeau', path: 'media/textures/bandeau.png' }];
    b.timeline!.scenes[1].lyrics = { style: { ...style(PAPER), centerX: 0.5352 } };
    expect(validate('timeline', b.timeline)).toEqual([]);
    const t2 = compileTimeline(b, '16x9', S, A, fakeImages(W, H), stage).timeline;
    const [a, c] = [ls[0], t2.lyrics.find((l) => l.id === ls[0].id)!];
    expect(c.groupBox.x + c.groupBox.w / 2).toBeCloseTo(0.5352 * W, 0);
    expect(c.box.x + c.box.w / 2).toBeCloseTo(0.5352 * W, 0);
    expect(c.panelBox!.x - a.panelBox!.x).toBe(c.groupBox.x - a.groupBox.x);
    expect([c.box.y, c.fontSize, c.panelBox!.y]).toEqual([a.box.y, a.fontSize, a.panelBox!.y]);
  });

  it('sceneBreak : conteneur absent pendant les pages tournées, synchronisation des mots inchangée', () => {
    const b = bundle();
    b.assets.textures = [{ id: 'bandeau', path: 'media/textures/bandeau.png' }];
    const plain = style(PAPER);
    for (const sc of b.timeline!.scenes) {
      if (sc.id !== 'sc-intro') sc.transitionIn = { type: 'page-turn', duration: { sec: 1.5 } };
      sc.lyrics = { style: { ...plain, sceneBreak: true } };
    }
    const t2 = compileTimeline(b, '16x9', S, A, fakeImages(W, H), stage).timeline;
    const ref = (() => {
      for (const sc of b.timeline!.scenes) sc.lyrics = { style: plain };
      return compileTimeline(b, '16x9', S, A, fakeImages(W, H), stage).timeline;
    })();
    const turns = t2.shots.filter((s, i) => i > 0 && s.enter && t2.shots[i - 1].sceneId !== s.sceneId).map((s) => [s.from, s.from + s.enter!.frames]);
    expect(turns.length).toBeGreaterThan(0);
    for (const l of t2.lyrics) {
      for (const [f, e] of turns) expect(l.groupFrom >= e || l.groupTo <= f).toBe(true);
      const r = ref.lyrics.find((x) => x.id === l.id)!;
      expect(l.words).toEqual(r.words);
      expect(l.from).toBeGreaterThanOrEqual(r.from);
    }
  });

  it('texte visible seulement une fois le papier presque déroulé', () => {
    expect(texturedParchmentState(100, 100, 200, 10, 0, H, 30).text).toBe(0);
    const open = texturedParchmentState(150, 100, 200, 10, 0, H, 30);
    expect(open.k).toBe(1);
    expect(open.text).toBe(1);
    expect(texturedParchmentState(200, 100, 200, 10, 0, H, 30).k).toBe(0);
  });
});

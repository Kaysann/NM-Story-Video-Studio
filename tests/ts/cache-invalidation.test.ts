// CHANGELOG C-03 : invalidation du cache des segments (transitions, styles globaux, LUT, dépendances partagées).
import { describe, expect, it } from 'vitest';
import { compileTimeline } from '../../src/modules/timeline/compile';
import { planCuts, planSegments, forbiddenWindows, DEFAULT_MEZZANINE } from '../../src/modules/render/segments';
import { analysis, bundle, fakeImages, noStage, syncFor } from './helpers';
import type { ProjectBundle } from '../../src/model/project';

const A = analysis();
const S = syncFor();
const build = (b: ProjectBundle, images = fakeImages(3840, 2160), stage: any = noStage) => compileTimeline(b, '16x9', S, A, images, stage).timeline;
const keys = (b: ProjectBundle, images?: any, comp = 'c1', stage?: any) => planSegments(build(b, images, stage), comp);

describe('découpage en segments', () => {
  it('aucune coupe à l’intérieur d’une transition ou d’un fondu', () => {
    const t = build(bundle());
    const cuts = planCuts(t, 300, 120, 600);
    expect(cuts[0]).toBe(0);
    expect(cuts[cuts.length - 1]).toBe(t.durationInFrames);
    for (const c of cuts) for (const [a, z] of forbiddenWindows(t)) expect(c > a && c < z).toBe(false);
    for (let i = 1; i < cuts.length; i++) expect(cuts[i] - cuts[i - 1]).toBeLessThanOrEqual(600);
  });
  it('clés stables à entrées identiques', () => {
    expect(keys(bundle()).map((s) => s.key)).toEqual(keys(bundle()).map((s) => s.key));
  });
});

describe('invalidation (C-03)', () => {
  const base = keys(bundle());
  const changed = (other: { key: string; from: number; to: number }[]) => other.filter((s, i) => !base[i] || base[i].key !== s.key || base[i].from !== s.from);

  it('transition modifiée : seuls les segments qui la touchent changent', () => {
    const b = bundle();
    b.timeline!.scenes[2].transitionIn = 'preset:zoom-through';
    const c = changed(keys(b));
    expect(c.length).toBeGreaterThan(0);
    expect(c.length).toBeLessThan(base.length);
  });
  it('style global du projet modifié (couleur du texte) : segments avec paroles en style par défaut invalidés', () => {
    const b = bundle();
    b.project.art.palette = { ...b.project.art.palette, text: '#FFFFFF' };
    const t = build(b);
    const c = changed(planSegments(t, 'c1'));
    expect(c.length).toBeGreaterThan(0);
    // les segments sans paroles claires (intro titrée, parchemin à encre) ne bougent pas
    expect(c.length).toBeLessThan(base.length);
  });
  it('preset de style de paroles modifié en ligne : invalidation des segments concernés', () => {
    const b = bundle();
    b.timeline!.scenes[1].lyrics = { style: { type: 'parchment', extends: 'preset:lyrics-parchment-default', parchment: { ink: '#000000' } } as any };
    expect(changed(keys(b)).length).toBeGreaterThan(0);
  });
  it('LUT (contenu) modifiée : le dérivé d’image change donc tous les segments qui l’utilisent', () => {
    const imgs = (id: string, m: number) => ({ ...fakeImages(3840, 2160)(id, m), rel: `img/${id}-${m}-lutB.png`, sha: 'autre' });
    expect(changed(keys(bundle(), imgs)).length).toBe(base.length);
  });
  it('une seule image re-étalonnée : seuls ses segments changent', () => {
    const imgs = (id: string, m: number) => ({ ...fakeImages(3840, 2160)(id, m), rel: id === 'img-c' ? `img/${id}-${m}-v2.png` : `img/${id}-${m}.png` });
    const c = changed(keys(bundle(), imgs));
    expect(c.length).toBeGreaterThan(0);
    expect(c.length).toBeLessThan(base.length);
  });
  it('police (contenu) modifiée : invalidation', () => {
    const b = bundle();
    b.project.art.fonts = { lyrics: 'fonts/Ma.ttf' };
    const st1 = () => ({ rel: 'fonts/aaaa.ttf', sha: 'a'.repeat(64) });
    const st2 = () => ({ rel: 'fonts/bbbb.ttf', sha: 'b'.repeat(64) });
    const k1 = keys(b, undefined, 'c1', st1).map((s) => s.key);
    const k2 = keys(b, undefined, 'c1', st2).map((s) => s.key);
    expect(k1.filter((k, i) => k !== k2[i]).length).toBeGreaterThan(0);
  });
  it('code des composants modifié : tout est invalidé', () => {
    expect(keys(bundle(), undefined, 'c2').every((s, i) => s.key !== base[i].key)).toBe(true);
  });
  it('réglages d’encodage mezzanine modifiés : tout est invalidé', () => {
    const t = build(bundle());
    const k2 = planSegments(t, 'c1', { ...DEFAULT_MEZZANINE, crf: 12 });
    expect(k2.every((s, i) => s.key !== base[i].key)).toBe(true);
  });
  it('l’URL du serveur d’assets n’entre pas dans les clés', () => {
    const t = build(bundle());
    expect(planSegments({ ...t, assetBaseUrl: 'http://127.0.0.1:1234' }, 'c1').map((s) => s.key)).toEqual(base.map((s) => s.key));
  });
});

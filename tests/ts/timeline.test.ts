import { describe, expect, it } from 'vitest';
import { resolveAnchor, transitionSeconds } from '../../src/modules/timeline/anchors';
import { applyPreroll, compileTimeline, phrasesOf } from '../../src/modules/timeline/compile';
import { resolveSync } from '../../src/modules/sync/merge';
import type { TimedLine } from '../../src/model/types';
import { cameraAt, SCROLL_DIM, SCROLL_FRAMES, scrollState } from '../../src/remotion/anim';
import { composeTimeline } from '../../src/modules/timeline/compose';
import { fitLines, textWidth, wrap } from '../../src/modules/timeline/layout';
import { validate } from '../../src/model/schemas';
import { analysis, bundle, fakeImages, LYRICS, noStage, syncFor } from './helpers';

const A = analysis();
const S = syncFor();
const ctx = { sync: S, analysis: A };

describe('ancres musicales', () => {
  it('absolue, section, ligne, mot, battement, mesure, fin, décalage et recalage', () => {
    expect(resolveAnchor({ at: 3.2 }, ctx)).toBe(3.2);
    expect(resolveAnchor({ section: 'chorus-1' }, ctx)).toBe(24);
    expect(resolveAnchor({ section: 'chorus-1', edge: 'end' }, ctx)).toBe(S.sections['chorus-1'].end);
    expect(resolveAnchor({ line: 'verse-1.l2' }, ctx)).toBe(S.lines[1].start);
    expect(resolveAnchor({ word: 'verse-1.l1.w2' }, ctx)).toBeCloseTo(8.45);
    expect(resolveAnchor({ beat: 3 }, ctx)).toBe(2);
    expect(resolveAnchor({ bar: 2 }, ctx)).toBe(4.5);
    expect(resolveAnchor({ end: true }, ctx)).toBe(90);
    expect(resolveAnchor({ at: 10.1, snap: 'beat' }, ctx)).toBe(10);
    expect(resolveAnchor({ section: 'verse-1', offsetSec: -0.3, snap: 'beat' }, ctx)).toBe(7.7); // hors tolérance de 150 ms : pas de recalage
    expect(resolveAnchor({ at: 7.62, snap: 'beat' }, ctx)).toBe(7.5);
    expect(() => resolveAnchor({ beat: 9999 }, ctx)).toThrow(/inexistant/);
    expect(transitionSeconds({ beats: 2 }, 120)).toBe(1);
  });
});

describe('mise en page des paroles', () => {
  it('retour à la ligne et ajustement de taille', () => {
    const max = textWidth('un deux', 10) + 1;
    const w = wrap('un deux trois quatre', 10, max);
    expect(w[0]).toBe('un deux');
    expect(w.join(' ')).toBe('un deux trois quatre');
    expect(w.every((l) => textWidth(l, 10) <= max)).toBe(true);
    expect(wrap('ligne\nforcée', 10, 1000)).toEqual(['ligne', 'forcée']);
    const f = fitLines('Sous le phare des collines anciennes', 20, 80, 600, 2);
    expect(f.overflow).toBe(false);
    expect(f.lines.length).toBeLessThanOrEqual(2);
    expect(f.lines.every((l) => textWidth(l, f.fontSize) <= 600)).toBe(true);
    expect(fitLines('x'.repeat(400), 20, 30, 300, 2).overflow).toBe(true);
  });
});

describe('compilation de la timeline', () => {
  const b = bundle();
  const W = 3840, H = 2160;
  const r = compileTimeline(b, '16x9', S, A, fakeImages(W, H), noStage);
  const t = r.timeline;
  it('produit une timeline résolue valide couvrant toute la durée', () => {
    expect(validate('timeline-resolved', t)).toEqual([]);
    expect(t.durationInFrames).toBe(2700);
    expect(Math.min(...t.shots.map((s) => s.from))).toBe(0);
    expect(Math.max(...t.shots.map((s) => s.to))).toBe(2700);
  });
  it('plans contigus : chaque image est couverte par au moins un plan', () => {
    const cover = new Array(t.durationInFrames).fill(0);
    for (const s of t.shots) for (let f = s.from; f < s.to; f++) cover[f]++;
    expect(cover.every((c) => c >= 1)).toBe(true);
  });
  it('transitions : glissé = chevauchement symétrique ; dip et fondus = calques de couleur', () => {
    const c1 = t.shots.find((s) => s.sceneId === 'sc-c1')!;
    expect(c1.enter?.type).toBe('slide');
    const prev = t.shots.find((s) => s.exit?.type === 'slide')!;
    expect(prev.to - c1.from).toBe(c1.enter!.frames);
    expect(t.fades.some((f) => f.from === 0 && f.peak === 0)).toBe(true); // ouverture depuis le noir
    expect(t.fades.some((f) => f.to === 2700 && f.peak === 2699)).toBe(true); // fin au noir
    expect(t.fades.some((f) => f.color !== '#000000')).toBe(true); // dip couleur
  });
  it('préambule : tous les événements décalés de N images, premier plan prolongé caméra figée, mouvement inchangé', () => {
    const N = 90;
    const p = applyPreroll(t, N);
    expect(validate('timeline-resolved', p)).toEqual([]);
    expect(p.durationInFrames).toBe(t.durationInFrames + N);
    expect(p.prerollFrames).toBe(N);
    expect(applyPreroll(t, 0)).toBe(t); // sans préambule : timeline inchangée
    // Plans : bornes, transitions et pulsations décalées de N ; seul le début du premier plan est ramené à 0.
    t.shots.forEach((s, i) => {
      const q = p.shots[i];
      expect(q.from).toBe(s.from === 0 ? 0 : s.from + N);
      expect(q.to).toBe(s.to + N);
      expect(q.enter).toEqual(s.enter);
      expect(q.exit).toEqual(s.exit);
      expect(q.motion.pulseFrames).toEqual(s.motion.pulseFrames?.map((f) => f + N));
      // Caméra : identique image pour image après le préambule.
      for (const f of [s.from, Math.floor((s.from + s.to) / 2), s.to - 1]) expect(cameraAt(q, f + N)).toEqual(cameraAt(s, f));
    });
    // Préambule : caméra figée sur la position de départ du premier plan.
    const first = p.shots.find((s) => s.from === 0)!;
    for (const f of [0, 45, N]) expect(cameraAt(first, f)).toEqual(cameraAt(t.shots.find((s) => s.from === 0)!, 0));
    // Paroles, fondus : décalés de N ; le fondu d'ouverture reste ancré à l'image 0.
    t.lyrics.forEach((l, i) => {
      expect(p.lyrics[i].from).toBe(l.from + N);
      expect(p.lyrics[i].words.map((w) => w.from)).toEqual(l.words.map((w) => w.from + N));
    });
    const opening = t.fades.filter((f) => f.from === 0);
    expect(p.fades.filter((f) => f.from === 0)).toEqual(opening);
    t.fades.filter((f) => f.from > 0).forEach((f) => expect(p.fades).toContainEqual({ ...f, from: f.from + N, peak: f.peak + N, to: f.to + N }));
  });
  it('plusieurs illustrations par scène, calées sur des débuts de ligne (byLines)', () => {
    const v1 = t.shots.filter((s) => s.sceneId === 'sc-v1');
    expect(v1).toHaveLength(2);
    const lineStarts = S.lines.map((l) => Math.round((l.start - 0.25) * 30));
    expect(lineStarts).toContain(v1[1].from + Math.floor((v1[1].enter?.frames ?? 0) / 2));
  });
  it('pulsations sur temps forts pour beat-pulse', () => {
    const c1 = t.shots.find((s) => s.sceneId === 'sc-c1')!;
    expect(c1.motion.pulseFrames!.length).toBeGreaterThan(2);
  });
  it('paroles : styles résolus par scène, boîtes dans la zone sûre, karaoké mot', () => {
    const styles = new Set(t.lyrics.map((l) => l.style.type));
    expect(styles).toEqual(new Set(['parchment', 'text-on-image', 'cartouche']));
    const safe = t.safe.title;
    for (const l of t.lyrics) {
      expect(l.groupBox.y).toBeGreaterThanOrEqual(safe.y - 1);
      expect(l.groupBox.x).toBeGreaterThanOrEqual(safe.x - 1);
      expect(l.groupBox.x + l.groupBox.w).toBeLessThanOrEqual(safe.x + safe.w + 1);
      expect(l.groupBox.y + l.groupBox.h).toBeLessThanOrEqual(safe.y + safe.h + 1);
    }
    const kw = t.lyrics.find((l) => l.id === 'chorus-1.l1')!;
    expect(kw.style.karaoke).toBe('word');
    expect(kw.words.length).toBe(5);
    expect(r.warnings.filter((w) => w.code === 'QC-E1')).toEqual([]);
  });
  it('karaoké au mot : repli sur la ligne si les timings de mots sont dégénérés (mot < 80 ms)', () => {
    const bad = structuredClone(S);
    const l = bad.lines.find((x) => x.id === 'chorus-1.l1')!;
    l.words[2].end = l.words[2].start; // mot de durée nulle (alignement dégénéré)
    const r2 = compileTimeline(b, '16x9', bad, A, fakeImages(W, H), noStage);
    expect(r2.timeline.lyrics.find((x) => x.id === 'chorus-1.l1')!.style.karaoke).toBe('line');
    expect(r2.warnings.some((w) => w.code === 'I_KARAOKE_LINE' && w.message.startsWith('chorus-1.l1'))).toBe(true);
    // Les autres lignes gardent le karaoké au mot.
    expect(r2.timeline.lyrics.find((x) => x.id === 'chorus-1.l2')?.style.karaoke ?? 'word').toBe(t.lyrics.find((x) => x.id === 'chorus-1.l2')?.style.karaoke ?? 'word');
  });
  it('défilement (flow: scroll) : la ligne suivante attend dessous puis monte au départ du chant', () => {
    const tl = structuredClone(b.timeline!);
    for (const sc of tl.scenes) sc.lyrics = { style: { type: 'text-on-image', flow: 'scroll', karaoke: 'word', position: 'lower-third' } as any };
    const r3 = compileTimeline({ ...b, timeline: tl }, '9x16', S, A, fakeImages(1080, 1920), noStage);
    expect(validate('timeline-resolved', r3.timeline)).toEqual([]);
    const byGroup = new Map<string, typeof r3.timeline.lyrics>();
    for (const l of r3.timeline.lyrics) byGroup.set(l.groupId, [...(byGroup.get(l.groupId) ?? []), l]);
    const ls = [...byGroup.values()].sort((x, y) => y.length - x.length)[0];
    expect(ls.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < ls.length - 1; i++) {
      const a = ls[i].scroll!, n = ls[i + 1].scroll!;
      expect(ls[i + 1].from).toBe(a.focusFrom); // la suivante apparaît (en attente) quand la courante prend le premier plan
      expect(a.leaveFrom).toBe(n.focusFrom); // la courante s'efface quand la suivante monte
      expect(ls[i].box.y).toBeLessThanOrEqual(ls[i + 1].box.y + 1); // même emplacement de premier plan (± hauteur de ligne)
      expect(a.gap).toBeGreaterThan(0);
    }
    expect(ls[ls.length - 1].scroll!.last).toBe(true);
    // Position et opacité continues : attente → premier plan → sortie, sans saut.
    const s0 = ls[1].scroll!;
    let prev = scrollState(s0, s0.focusFrom - SCROLL_FRAMES - 1);
    expect(prev).toEqual({ dy: s0.gap, opacity: SCROLL_DIM });
    for (let f = s0.focusFrom - SCROLL_FRAMES; f <= s0.leaveFrom + SCROLL_FRAMES; f++) {
      const cur = scrollState(s0, f);
      expect(Math.abs(cur.dy - prev.dy)).toBeLessThanOrEqual(s0.gap * 0.35);
      prev = cur;
    }
    expect(scrollState(s0, s0.focusFrom)).toEqual({ dy: 0, opacity: 1 });
    // Jamais deux lignes nettes au même endroit : pendant la montée de la suivante, la courante s'efface vers le haut.
    for (let i = 0; i < ls.length - 1; i++) {
      const a = ls[i].scroll!, n = ls[i + 1].scroll!;
      for (let f = n.focusFrom - SCROLL_FRAMES; f <= n.focusFrom; f++) {
        const sa = scrollState(a, f), sn = scrollState(n, f);
        const clash = sa.opacity > 0.5 && sn.opacity > 0.5 && Math.abs(sa.dy - sn.dy) < a.gap * 0.5;
        expect({ i, f, clash }).toEqual({ i, f, clash: false });
      }
    }
    // Zone sûre verticale respectée par le conteneur (deux emplacements).
    for (const l of ls) expect(l.groupBox.y + l.groupBox.h).toBeLessThanOrEqual(r3.timeline.safe.title.y + r3.timeline.safe.title.h + 1);
  });
  it('parchemin à deux lignes : jamais deux lignes au même emplacement, ordre de lecture respecté', () => {
    const parch = t.lyrics.filter((l) => l.style.type === 'parchment');
    expect(parch.length).toBeGreaterThanOrEqual(3);
    const order = (id: string) => S.lines.findIndex((x) => x.id === id);
    for (let f = 0; f < t.durationInFrames; f += 3) {
      const vis = parch.filter((l) => f >= l.from && f < l.to).sort((a, c) => a.box.y - c.box.y);
      expect(new Set(vis.map((l) => l.box.y)).size).toBe(vis.length);
      for (let i = 1; i < vis.length; i++) expect(order(vis[i].id)).toBeGreaterThan(order(vis[i - 1].id));
    }
  });
  it('conteneurs de paroles sans chevauchement entre groupes', () => {
    const groups = [...new Map(t.lyrics.map((l) => [l.groupId, l])).values()].sort((a, c) => a.groupFrom - c.groupFrom);
    for (let i = 1; i < groups.length; i++) expect(groups[i - 1].groupTo).toBeLessThanOrEqual(groups[i].groupFrom);
  });
  it('9:16 : même timeline, autre mise en page, zones sûres sociales', () => {
    const v = compileTimeline(b, '9x16', S, A, fakeImages(1080, 1920), noStage).timeline;
    expect(v.width).toBe(1080);
    expect(v.safe.title.y).toBe(Math.round(0.12 * 1920));
    const st = v.safe.title;
    expect(st.x + st.w).toBeLessThan(1080 - st.x); // zone sociale asymétrique (marge droite plus large)
    for (const l of v.lyrics) {
      // Quatre bords : le conteneur et la boîte de texte restent dans la zone sûre (centrage sur la zone, pas sur le cadre).
      for (const r of [l.groupBox, l.box]) {
        expect(r.x).toBeGreaterThanOrEqual(st.x - 1);
        expect(r.x + r.w).toBeLessThanOrEqual(st.x + st.w + 1);
        expect(r.y + r.h).toBeLessThanOrEqual(st.y + st.h + 1);
      }
      expect(Math.abs(l.groupBox.x + l.groupBox.w / 2 - (st.x + st.w / 2))).toBeLessThanOrEqual(1);
    }
  });
  it('position « auto » : paroles du côté opposé au sujet déclaré', () => {
    const b2 = bundle();
    b2.timeline!.scenes[3].lyrics = { style: 'preset:lyrics-cartouche-default', position: 'auto' };
    b2.assets.images.find((i) => i.id === 'img-b')!.safeSubject = { x: 0.3, y: 0.6, w: 0.4, h: 0.35 }; // sujet en bas
    const t2 = compileTimeline(b2, '16x9', S, A, fakeImages(W, H), noStage).timeline;
    const sceneShots = t2.shots.filter((s) => s.sceneId === 'sc-rest');
    for (const l of t2.lyrics.filter((x) => x.sceneId === 'sc-rest')) {
      const shot = [...sceneShots].reverse().find((s) => l.groupFrom + 10 >= s.from && l.groupFrom + 10 < s.to)!;
      const top = l.groupBox.y < t2.height / 2;
      expect(top).toBe(shot.src.includes('img-b'));
    }
  });
  it('scène longue sur une seule illustration : relances de mouvement', () => {
    const b3 = bundle();
    b3.timeline!.scenes[3].illustrations = [{ asset: 'img-c', motion: 'preset:slow-push-in' }];
    const res = compileTimeline(b3, '16x9', S, A, fakeImages(W, H), noStage);
    const parts = res.timeline.shots.filter((s) => s.sceneId === 'sc-rest');
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts[1].motion.from.scale).toBeCloseTo(parts[0].motion.to.scale); // mouvement inversé
    expect(res.warnings.some((w) => w.code === 'I_MOTION_RELAUNCH')).toBe(true);
  });
  it('trou dans la timeline : erreur explicite avec positions', () => {
    const bad = bundle();
    bad.timeline!.scenes[1].span.to = { at: 20 };
    expect(() => compileTimeline(bad, '16x9', S, A, fakeImages(W, H), noStage)).toThrow(/trou entre sc-v1 et sc-c1/);
  });
  it('alertes : agrandissement excessif et sujet coupé', () => {
    const res = compileTimeline(b, '16x9', S, A, (id, m) => ({ ...fakeImages(W, H)(id, m), upscale: id === 'img-b' ? 2 : 1, subjectCut: id === 'img-c' ? 0.4 : 0 }), noStage);
    expect(res.warnings.some((w) => w.code === 'QC-E5' && w.message.includes('img-b'))).toBe(true);
    expect(res.warnings.some((w) => w.code === 'QC-E6' && w.message.includes('img-c'))).toBe(true);
  });
});

describe('composition automatique', () => {
  it('une scène par section, intro titrée, fondus, timeline valide et compilable', () => {
    const b = bundle({ timeline: undefined });
    const { timeline, rationale } = composeTimeline(b, S, A);
    expect(validate('timeline', timeline)).toEqual([]);
    expect(timeline.scenes[0].id).toBe('sc-intro');
    expect(timeline.scenes[0].title?.text).toBe('Le Phare Test');
    expect(timeline.scenes.filter((s) => s.id.startsWith('sc-') && !['sc-intro', 'sc-outro'].includes(s.id) && !s.id.startsWith('sc-inter')).length).toBe(6);
    expect(timeline.scenes[timeline.scenes.length - 1].transitionOut).toBe('preset:fade-black');
    expect(rationale.length).toBeGreaterThan(2);
    const c = compileTimeline({ ...b, timeline }, '16x9', S, A, fakeImages(3840, 2160), noStage);
    expect(c.timeline.shots.length).toBeGreaterThanOrEqual(timeline.scenes.length);
    // Pas deux fois la même illustration d'affilée
    for (let i = 1; i < c.timeline.shots.length; i++) expect(c.timeline.shots[i].src === c.timeline.shots[i - 1].src && c.timeline.shots[i].srcW === c.timeline.shots[i - 1].srcW).toBe(false);
  });
});

describe('paroles « une phrase à la fois » (flow: phrase) et avance propre au style', () => {
  // Couplet 1 réécrit avec une ponctuation de phrases (paroles inventées pour le test).
  const TEXTS = ['Trois pas.', 'La forêt', 'n’a pas dormi.', 'C’est toi', 'qui as choisi', 'de la traverser.'];
  const lyr = structuredClone(LYRICS);
  lyr.sections[0].lines = TEXTS.map((text, i) => ({ id: `verse-1.l${i + 1}`, text }));
  const base = syncFor(90);
  const v1: TimedLine[] = TEXTS.map((text, i) => {
    const start = 8 + i * 1.6;
    const toks = text.split(' ');
    return { id: `verse-1.l${i + 1}`, start, end: start + 1.3, confidence: 0.8, source: 'auto', words: toks.map((w, k) => ({ id: `verse-1.l${i + 1}.w${k + 1}`, text: w, start: start + k * 0.3, end: start + k * 0.3 + 0.28, confidence: 0.8, source: 'auto' as const })) };
  });
  const S2 = resolveSync({ version: 1, engine: 'test', audioSha256: '0'.repeat(64), lyricsHash: 'x', lines: [...v1, ...base.lines.filter((l) => !l.id.startsWith('verse-1.'))] }, { schemaVersion: 1 }, lyr, 90);
  const style = { type: 'parchment', flow: 'phrase', lines: 2, karaoke: 'none', enter: 'fade', leadSec: 0, parchment: { orientation: 'horizontal' } };
  const make = (st: object) => {
    const b = bundle({ lyrics: lyr });
    for (const sc of b.timeline!.scenes) if (sc.id === 'sc-v1') sc.lyrics = { style: st as any };
    return compileTimeline(b, '9x16', S2, A, fakeImages(1080, 1920), noStage).timeline;
  };
  const t = make(style);
  const v = t.lyrics.filter((l) => l.id.startsWith('verse-1.'));
  const fps = t.fps;

  it('découpage : fin de phrase sur la ponctuation, au plus `lines` lignes', () => {
    expect(phrasesOf(TEXTS, 2).map((p) => p.first)).toEqual([0, 1, 1, 3, 3, 5]);
    expect(phrasesOf(TEXTS, 3).map((p) => p.len)).toEqual([1, 2, 2, 3, 3, 3]);
    expect(phrasesOf(['— Tu viens ?', '— Oui.', '— Eh bien…', 'on y va.'], 2).map((p) => p.first)).toEqual([0, 1, 2, 2]);
    expect(phrasesOf(['Il attend…', 'Puis il part.'], 2).map((p) => p.first)).toEqual([0, 1]);
    expect(phrasesOf(['Et loin d’ici,', 'sans faire de bruit,', 'une rivière', 'chantait encore.'], 2).map((p) => p.first)).toEqual([0, 0, 2, 2]);
  });
  it('une phrase à la fois : jamais deux phrases visibles ensemble', () => {
    const ph = phrasesOf(TEXTS, 2);
    const phraseOf = (id: string) => ph[Number(id.split('.l')[1]) - 1].first;
    expect(v).toHaveLength(6);
    for (let f = v[0].groupFrom; f < v[0].groupTo; f++) {
      const vis = v.filter((l) => f >= l.from && f < l.to);
      expect(new Set(vis.map((l) => phraseOf(l.id))).size).toBeLessThanOrEqual(1);
    }
  });
  it('avance nulle : aucune ligne affichée avant son chant (révélation progressive dans la phrase)', () => {
    for (const l of v) {
      const tl = S2.lines.find((x) => x.id === l.id)!;
      expect(l.from).toBeGreaterThanOrEqual(Math.round(tl.start * fps));
    }
    // 2ᵉ ligne d'une phrase : sous la 1ʳᵉ, apparue plus tard, effacée en même temps.
    const [l2, l3] = [v[1], v[2]];
    expect(l3.box.y).toBeGreaterThan(l2.box.y);
    expect(l3.from).toBeGreaterThan(l2.from);
    expect(l3.to).toBe(l2.to);
  });
  it('phrase d’une ligne centrée verticalement dans le parchemin ; parchemin horizontal dans la zone sûre', () => {
    const l1 = v[0];
    const gc = l1.groupBox.y + l1.groupBox.h / 2;
    expect(Math.abs(l1.box.y + l1.box.h / 2 - gc)).toBeLessThanOrEqual(1);
    expect(l1.style.parchment.orientation).toBe('horizontal');
    const s = t.safe.title;
    expect(l1.groupBox.x).toBeGreaterThanOrEqual(s.x - 1);
    expect(l1.groupBox.x + l1.groupBox.w).toBeLessThanOrEqual(s.x + s.w + 1);
    expect(l1.groupBox.y + l1.groupBox.h).toBeLessThanOrEqual(s.y + s.h + 1);
  });
  it('le parchemin persiste à travers un changement de scène (pages tournées derrière) ; refermé après une pause > 3 s', () => {
    const b = bundle({ lyrics: lyr });
    const scs = b.timeline!.scenes;
    const i = scs.findIndex((sc) => sc.id === 'sc-v1');
    const second = { ...structuredClone(scs[i]), id: 'sc-v1b', span: { from: { at: 12.5 }, to: scs[i].span.to }, illustrations: [{ asset: 'img-b' }] };
    scs[i].span = { ...scs[i].span, to: { at: 12.5 } };
    scs.splice(i + 1, 0, second as any);
    for (const sc of scs) if (sc.id === 'sc-v1' || sc.id === 'sc-v1b' || sc.id === 'sc-c1') sc.lyrics = { style: style as any };
    const tt = compileTimeline(b, '9x16', S2, A, fakeImages(1080, 1920), noStage).timeline;
    const vv = tt.lyrics.filter((l) => l.id.startsWith('verse-1.'));
    expect(new Set(vv.map((l) => l.sceneId)).size).toBe(2);
    expect(new Set(vv.map((l) => l.groupId)).size).toBe(1);
    const c1 = tt.lyrics.find((l) => l.id === 'chorus-1.l1')!;
    expect(c1.groupId).not.toBe(vv[0].groupId); // 6,7 s de pause avant le refrain
  });
  it('sans leadSec : avance du projet (0,25 s) inchangée', () => {
    const { leadSec, ...rest } = style;
    void leadSec;
    const w = make(rest).lyrics.filter((l) => l.id.startsWith('verse-1.'));
    const tl = S2.lines.find((x) => x.id === 'verse-1.l3')!;
    expect(w[2].from).toBe(Math.round((tl.start - 0.25) * fps));
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateCandidates, selectDiverse, CRITERIA } from '../../src/modules/reels/candidates';
import { sliceTimeline } from '../../src/modules/reels/reels';
import { loadPreset } from '../../src/model/presets';
import { RunContext } from '../../src/core/context';
import { runStep } from '../../src/pipeline/step';
import { gcSegments, loadManifest, recordSegmentPlan } from '../../src/pipeline/manifest';
import { applyPreroll, compileTimeline } from '../../src/modules/timeline/compile';
import { scrollState } from '../../src/remotion/anim';
import { mergeOverrides, resolveShortsSync, syncApply } from '../../src/modules/sync/sync';
import { analysis, bundle, fakeImages, LYRICS, noStage, syncFor } from './helpers';

const A = analysis(90);
const S = syncFor(90);
const inp = (durations = [10, 15]) => ({ analysis: A, sync: S, lyrics: LYRICS, title: 'Le Phare Test', durations, weights: loadPreset('reels-weights', 'reels-balanced') });

describe('Reels : candidats, critères, diversité', () => {
  const all = generateCandidates(inp());
  const top = selectDiverse(all, 5, 0.35, 0.7, [10, 15]);
  it('cinq extraits classés, identifiants stables, critères complets', () => {
    expect(top).toHaveLength(5);
    expect(top.map((c) => c.id)).toEqual(['cand-1', 'cand-2', 'cand-3', 'cand-4', 'cand-5']);
    for (const c of top) expect(Object.keys(c.criteria).sort()).toEqual([...CRITERIA].sort());
  });
  it('contraintes : recouvrement ≤ 35 %, ≥ 2 sections, ≥ 2 durées cibles', () => {
    for (const a of top) for (const b of top) if (a !== b) {
      const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
      expect(inter / Math.min(a.duration, b.duration)).toBeLessThanOrEqual(0.35 + 1e-9);
    }
    expect(new Set(top.map((c) => c.sections[0])).size).toBeGreaterThanOrEqual(2);
    expect(new Set(top.map((c) => c.targetDuration)).size).toBe(2);
  });
  it('bornes jamais au milieu d’un mot chanté', () => {
    const words = S.lines.flatMap((l) => l.words);
    for (const c of top) {
      expect(words.some((w) => c.start > w.start + 0.02 && c.start < w.end - 0.05)).toBe(false);
      expect(words.some((w) => c.end > w.start + 0.05 && c.end < w.end - 0.02)).toBe(false);
    }
  });
  it('lignes enchaînées sans pause : aucune borne sur la ligne voisine (marge bornée par l’intervalle)', () => {
    // Variante de la synchro de test où chaque ligne commence 0,1 s après la fin de la précédente.
    const tight = structuredClone(S);
    for (let i = 1; i < tight.lines.length; i++) {
      const prev = tight.lines[i - 1];
      const l = tight.lines[i];
      const shift = prev.end + 0.1 - l.start;
      if (shift < 0) {
        l.start += shift; l.end += shift;
        for (const w of l.words) { w.start += shift; w.end += shift; }
      }
    }
    const cands = generateCandidates({ ...inp(), sync: tight });
    expect(cands.length).toBeGreaterThan(0);
    const words = tight.lines.flatMap((l) => l.words);
    for (const c of cands) {
      // Jamais au cœur d'un mot ; au plus 50 ms d'attaque du mot suivant (dans le fondu de fin).
      expect(words.some((w) => c.end > w.start + 0.05 && c.end < w.end - 0.02)).toBe(false);
      expect(words.some((w) => c.start > w.start + 0.02 && c.start < w.end - 0.05)).toBe(false);
    }
    // Ancienne règle (+0,3 s fixe après la fin de ligne) : ces bornes tomberaient sur la ligne suivante, 0,1 s plus tard.
    const lineEnds = tight.lines.slice(0, -1).map((l) => l.end + 0.3);
    expect(lineEnds.some((e) => words.some((w) => e > w.start + 0.05 && e < w.end - 0.02))).toBe(true);
    for (const c of cands.filter((x) => x.boundaries.end.startsWith('fin de ligne'))) {
      const id = c.boundaries.end.replace('fin de ligne ', '');
      const i = tight.lines.findIndex((l) => l.id === id);
      if (i + 1 < tight.lines.length) expect(c.end).toBeLessThanOrEqual(Math.max(tight.lines[i].end + 0.05, tight.lines[i + 1].start - 0.05) + 1e-6);
    }
  });
  it('le meilleur extrait contient l’accroche (ligne répétée / titre)', () => {
    expect(top[0].criteria.hook).toBeGreaterThan(0.5);
    expect(top[0].justification).toMatch(/accroche/);
  });
  it('justification explicable, sans prétention prédictive', () => {
    for (const c of top) {
      expect(c.justification.length).toBeGreaterThan(40);
      expect(c.justification).not.toMatch(/viral|vues|audience|succès|performance/i);
    }
  });
  it('déterminisme', () => {
    const again = selectDiverse(generateCandidates(inp()), 5, 0.35, 0.7, [10, 15]);
    expect(again).toEqual(top);
  });
  it('découpe et préambule : le défilement des paroles est décalé avec le reste (état identique image pour image)', () => {
    const b = bundle();
    for (const sc of b.timeline!.scenes) sc.lyrics = { style: { type: 'text-on-image', flow: 'scroll', karaoke: 'word' } as any };
    const t = compileTimeline(b, '9x16', S, A, fakeImages(1080, 1920), noStage).timeline;
    const withScroll = t.lyrics.filter((l) => l.scroll);
    expect(withScroll.length).toBeGreaterThan(3);
    const f0 = 600;
    const s = sliceTimeline(t, f0, 2400);
    const p = applyPreroll(t, 90);
    for (const l of withScroll) {
      const sl = s.lyrics.find((x) => x.id === l.id);
      const pl = p.lyrics.find((x) => x.id === l.id)!;
      for (const f of [l.from, l.scroll!.focusFrom - 3, l.scroll!.focusFrom, l.scroll!.leaveFrom + 4]) {
        if (sl) expect(scrollState(sl.scroll!, f - f0)).toEqual(scrollState(l.scroll!, f));
        expect(scrollState(pl.scroll!, f + 90)).toEqual(scrollState(l.scroll!, f));
      }
    }
  });
  it('découpe de timeline pour un Reel : décalage, conservation du mouvement', () => {
    const t = compileTimeline(bundle(), '9x16', S, A, fakeImages(1080, 1920), noStage).timeline;
    const s = sliceTimeline(t, 900, 1350);
    expect(s.durationInFrames).toBe(450);
    expect(s.shots.every((x) => x.to > 0 && x.from < 450)).toBe(true);
    const orig = t.shots.find((x) => x.to > 900 && x.from < 1350)!;
    const moved = s.shots.find((x) => x.id === orig.id)!;
    expect(moved.from).toBe(orig.from - 900);
    expect(moved.to - moved.from).toBe(orig.to - orig.from);
  });
});

describe('Shorts : couche de corrections de synchronisation dédiée (reels.json → params.syncOverrides)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmsvs-shorts '));
  fs.mkdirSync(path.join(dir, 'analysis'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'analysis', 'audio.json'), JSON.stringify(A));
  fs.writeFileSync(path.join(dir, 'analysis', 'sync.auto.json'), JSON.stringify({ version: 1, engine: 'test', audioSha256: A.audioSha256, lyricsHash: 'x', lines: S.lines }));
  const clipOverrides = { schemaVersion: 1 as const, lines: { 'verse-1.l1': { start: 8.1, lock: true }, 'verse-1.l2': { start: 10.6, lock: true } } };
  fs.writeFileSync(path.join(dir, 'sync.overrides.json'), JSON.stringify(clipOverrides));
  const b = bundle({ dir, overrides: structuredClone(clipOverrides), reels: { schemaVersion: 1, params: { syncOverrides: 'sync.overrides.shorts.json' }, selection: [] } });
  const ctx = new RunContext('test', dir, true);
  const batch = path.join(dir, 'lot.json');
  fs.writeFileSync(batch, JSON.stringify({ lines: { 'verse-1.l2': { start: 11.0, end: 12.5 } } }));

  it('fusion : une entrée des Shorts remplace celle du clip pour le même identifiant', () => {
    const m = mergeOverrides(clipOverrides, { schemaVersion: 1, lines: { 'verse-1.l2': { start: 11 } } });
    expect(m.lines!['verse-1.l1']).toEqual({ start: 8.1, lock: true });
    expect(m.lines!['verse-1.l2']).toEqual({ start: 11 });
  });
  it('apply --shorts : écrit la couche des Shorts, jamais sync.overrides.json ; synchro du clip intacte', () => {
    const before = fs.readFileSync(path.join(dir, 'sync.overrides.json'), 'utf8');
    const r = syncApply(b, batch, 'essai', 'shorts');
    expect(r.lines).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'sync.overrides.json'), 'utf8')).toBe(before);
    expect(b.overrides).toEqual(clipOverrides);
    const shorts = JSON.parse(fs.readFileSync(path.join(dir, 'sync.overrides.shorts.json'), 'utf8'));
    expect(shorts.lines['verse-1.l2']).toEqual({ start: 11, end: 12.5, lock: true });
    const rs = resolveShortsSync(ctx, b);
    expect(rs.lines.find((l) => l.id === 'verse-1.l2')!.start).toBe(11);
    expect(rs.lines.find((l) => l.id === 'verse-1.l1')!.start).toBe(8.1); // correction du clip conservée
    // Ni la synchro résolue du clip ni ses sous-titres ne sont réécrits.
    expect(fs.existsSync(path.join(dir, 'build', 'sync.resolved.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'exports'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'build', 'sync.shorts.resolved.json'))).toBe(true);
  });
  it('--shorts sans fichier déclaré : erreur explicite', () => {
    const nb = bundle({ dir, reels: { schemaVersion: 1, selection: [] } });
    expect(() => syncApply(nb, batch, undefined, 'shorts')).toThrow(/Shorts/);
  });
});

describe('pipeline : cache d’étape, reprise, purge', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmsvs-pipe '));
  const ctx = new RunContext('test', dir, true);
  const out = path.join(dir, 'out.txt');
  let runs = 0;
  const def = (inputs: unknown, fail = false) => ({
    id: 'etape', version: 1, inputs, outputs: [out], load: () => fs.readFileSync(out, 'utf8'),
    run: async () => { runs++; if (fail) throw new Error('panne simulée'); fs.writeFileSync(out, JSON.stringify(inputs)); return 'ok'; },
  });
  it('saute l’étape si clé et sorties inchangées ; recalcule sinon', async () => {
    await runStep(ctx, dir, def({ a: 1 }));
    expect((await runStep(ctx, dir, def({ a: 1 }))).cached).toBe(true);
    expect(runs).toBe(1);
    await runStep(ctx, dir, def({ a: 2 }));
    expect(runs).toBe(2);
    fs.rmSync(out);
    expect((await runStep(ctx, dir, def({ a: 2 }))).cached).toBe(false);
  });
  it('échec : état « failed » dans le manifeste, puis reprise réussie', async () => {
    await expect(runStep(ctx, dir, def({ a: 3 }, true))).rejects.toThrow(/panne/);
    expect(loadManifest(dir).steps.etape.status).toBe('failed');
    await runStep(ctx, dir, def({ a: 3 }));
    expect(loadManifest(dir).steps.etape.status).toBe('done');
  });
  it('purge : conserve les segments des 3 derniers plans', () => {
    const seg = path.join(dir, 'build', '16x9', 'segments');
    fs.mkdirSync(seg, { recursive: true });
    for (const k of ['k1', 'k2', 'k3', 'k4', 'k5']) fs.writeFileSync(path.join(seg, `${k}.mp4`), 'x');
    for (const p of [['k1'], ['k2'], ['k3'], ['k4']]) recordSegmentPlan(dir, '16x9', p);
    const r = gcSegments(dir);
    expect(r.removed.map((f) => path.basename(f)).sort()).toEqual(['k1.mp4', 'k5.mp4']);
    expect(fs.readdirSync(seg).sort()).toEqual(['k2.mp4', 'k3.mp4', 'k4.mp4']);
  });
});

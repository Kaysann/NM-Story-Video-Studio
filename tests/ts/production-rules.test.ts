// Règles de production V1.1 : fermeture des Shorts après la musique, export YouTube 4K direct, aucun écrasement
// ni archive automatique, propositions de Shorts séparées de la production, nettoyage sûr (liste blanche).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunContext } from '../../src/core/context';
import { loadPreset } from '../../src/model/presets';
import { updateManifest } from '../../src/pipeline/manifest';
import { assertYoutubeDeliverable, encodeFinal } from '../../src/modules/export/export';
import { classify, cleanProject } from '../../src/modules/project/clean';
import { generateCandidates, selectDiverse } from '../../src/modules/reels/candidates';
import { appendClosing } from '../../src/modules/reels/closing';
import { proposalDetails, proposalMarkdown, verticalPlan } from '../../src/modules/reels/proposal';
import { closingAudioSec, sliceTimeline } from '../../src/modules/reels/reels';
import { compileTimeline } from '../../src/modules/timeline/compile';
import { cameraAt } from '../../src/remotion/anim';
import { analysis, bundle, fakeImages, LYRICS, noStage, syncFor } from './helpers';

const A = analysis(90);
const S = syncFor(90);

describe('Short : fermeture du livre après la musique', () => {
  const b = bundle();
  for (const sc of b.timeline!.scenes) sc.lyrics = { style: { type: 'parchment', flow: 'phrase', lines: 2, leadSec: 0, karaoke: 'none', parchment: { orientation: 'horizontal', unrollSec: 0.25 } } as any };
  b.timeline!.scenes[0].lyrics = { style: 'none' };
  const full = compileTimeline(b, '9x16', S, A, fakeImages(1080, 1920), noStage).timeline;
  const f0 = 20 * 30, f1 = 50 * 30;
  const sliced = sliceTimeline(full, f0, f1);
  const D = sliced.durationInFrames;
  const { timeline: t, musicFrames } = appendClosing(sliced, full, { scene: 'sc-intro', transition: { type: 'page-turn', duration: { sec: 1.2 }, direction: 'right' }, lyricsOutSec: 0.4, holdSec: 0.8 });

  it('durée = musique + enroulement + page tournée + tenue ; la musique n’est pas tronquée', () => {
    expect(musicFrames).toBe(D);
    expect(t.durationInFrames).toBe(D + 12 + 36 + 24);
  });
  it('partie musicale inchangée image par image (plans, caméra, paroles)', () => {
    for (let f = 0; f < D; f += 7) {
      const vis = (tl: typeof t) => tl.shots.filter((s) => f >= s.from && f < s.to).map((s) => [s.id, cameraAt(s, f).scale.toFixed(6)].join('@')).sort();
      expect(vis(t)).toEqual(vis(sliced));
      const ly = (tl: typeof t) => tl.lyrics.filter((l) => f >= l.from && f < l.to && f >= l.groupFrom && f < l.groupTo).map((l) => l.id).sort();
      expect(ly(t)).toEqual(ly(sliced));
    }
  });
  it('paroles et parchemin masqués après la musique ; page tournée à rebours vers la couverture ; fin sur la couverture', () => {
    for (const l of t.lyrics) expect(l.groupTo).toBeLessThanOrEqual(D + 12);
    const last = t.shots.find((s) => s.id.endsWith('-fermeture'))!;
    expect(last.sceneId).toBe('sc-intro');
    expect(last.enter).toMatchObject({ type: 'page-turn', direction: 'right', frames: 36 });
    expect(last.from).toBe(D + 12);
    expect(last.to).toBe(t.durationInFrames);
    const out = t.shots.find((s) => s.exit?.direction === 'right')!;
    expect(out.to).toBe(D + 12 + 36);
    expect(t.fades.every((f) => f.to <= D)).toBe(true); // pas de fondu au noir : fin sur l'image
  });
  it('audio : silence après l’extrait par défaut ; « continue » poursuit le master sous la fermeture (boucle sans silence)', () => {
    expect(closingAudioSec({ scene: 'sc-intro' }, D, 30)).toBe(D / 30);
    expect(closingAudioSec({ scene: 'sc-intro', audio: 'stop' }, D, 30)).toBe(D / 30);
    expect(closingAudioSec({ scene: 'sc-intro', audio: 'continue' }, D, 30)).toBeUndefined();
  });
  it('dernière image identique au premier plan de la scène modèle (caméra au départ de son mouvement)', () => {
    const last = t.shots.find((s) => s.id.endsWith('-fermeture'))!;
    const tmpl = full.shots.find((s) => s.sceneId === 'sc-intro')!;
    expect(last.src).toBe(tmpl.src);
    expect(cameraAt(last, t.durationInFrames - 1).scale).toBeCloseTo(cameraAt(tmpl, tmpl.motion.start ?? tmpl.from).scale, 6);
  });
  it('scène de fermeture inconnue : erreur explicite', () => {
    expect(() => appendClosing(sliced, full, { scene: 'sc-absente' })).toThrow(/fermeture/);
  });
});

describe('Production YouTube : 3840 × 2160 direct, aucun écrasement ni archive automatique', () => {
  const p = loadPreset<any>('export', 'youtube-4k-master');
  it('profil maître conforme sur un projet 4K ; refus si résolution, échelle ou format non conformes', () => {
    const b = bundle();
    b.project.formats['16x9'] = { ...b.project.formats['16x9'], width: 3840, height: 2160 };
    expect(() => assertYoutubeDeliverable(b, 'youtube-4k-master', p)).not.toThrow();
    expect(() => assertYoutubeDeliverable(b, 'youtube-4k-master', { ...p, scale: 0.5 })).toThrow(/mise à l'échelle/);
    const low = bundle();
    low.project.formats['16x9'] = { ...low.project.formats['16x9'], width: 1920, height: 1080 };
    expect(() => assertYoutubeDeliverable(low, 'youtube-4k-master', p)).toThrow(/3840×2160/);
    expect(() => assertYoutubeDeliverable(low, 'reel-1080-h264', p)).not.toThrow(); // hors YouTube : non concerné
  });
  it('export existant : refus sans --replace, aucun fichier déplacé ni archivé', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmsvs-exp '));
    const out = path.join(dir, 'exports', 'clip.mp4');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'livrable');
    const ctx = new RunContext('test', dir, true);
    await expect(encodeFinal(ctx, { video: 'x.mp4', master: 'y.wav', durSec: 1, buildId: 'b' }, p, 30, out)).rejects.toThrow(/existe déjà/);
    expect(fs.readFileSync(out, 'utf8')).toBe('livrable');
    expect(fs.existsSync(path.join(dir, 'exports', 'archive'))).toBe(false);
  });
});

describe('Shorts : propositions détaillées, sans production', () => {
  const b = bundle();
  const top = selectDiverse(generateCandidates({ analysis: A, sync: S, lyrics: LYRICS, title: 'Le Phare Test', durations: [10, 15], weights: loadPreset('reels-weights', 'reels-balanced') }), 5, 0.35, 0.7, [10, 15]);
  const d = proposalDetails(b, top, S, A);
  it('chaque fiche : début/fin, durée, paroles, pertinence musicale et narrative, scènes, montage vertical, style, limites', () => {
    expect(d).toHaveLength(5);
    for (const x of d) {
      expect(x.end - x.start).toBeCloseTo(x.duration, 2);
      expect(x.lyrics.length).toBeGreaterThan(0);
      expect(x.musical).toMatch(/score/);
      expect(x.narrative).toMatch(/sections :/);
      expect(x.scenes.length).toBeGreaterThan(0);
      expect(x.vertical.length).toBeGreaterThan(0);
      expect(x.lyricStyle).toMatch(/à valider/);
      expect(Array.isArray(x.limits)).toBe(true);
    }
    expect(proposalMarkdown(d)).toMatch(/Fiches détaillées \(avant toute production\)/);
  });
  it('plan vertical : remplacement, recadrage dédié, image entière, recadrage fort signalé', () => {
    expect(verticalPlan({ id: 'a', path: 'a', replace: { '9x16': 'b' } }, 'a').plan).toMatch(/remplacée/);
    expect(verticalPlan({ id: 'a', path: 'a', crops: { '9x16': { x: 0, y: 0, w: 0.3, h: 1 } } }, 'a').plan).toMatch(/dédié/);
    expect(verticalPlan({ id: 'a', path: 'a', fits: { '9x16': 'blurFill' } }, 'a').plan).toMatch(/fond flouté/);
    const wide = verticalPlan({ id: 'a', path: 'a', size: { w: 5120, h: 2880 }, focal: { x: 0.4, y: 0.5 } }, 'a');
    expect(wide.plan).toMatch(/32 %/);
    expect(wide.limit).toMatch(/recadrage vertical fort/);
  });
});

describe('Nettoyage sûr : liste blanche des intermédiaires générés, sources toujours préservées', () => {
  const mk = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmsvs-clean '));
    const files: Record<string, string> = {
      'media/audio/chanson.wav': 'source', 'media/images/page-1.png': 'source', 'project.json': '{}', 'lyrics.json': '{}', 'decisions.jsonl': '',
      'build/16x9/segments/0123456789abcdef01234567.mp4': 'seg', 'build/16x9/segments/0123456789abcdef01234567.tmp.mp4': 'part',
      'build/16x9/mezzanine-0123456789abcdef01234567.mp4': 'mezz', 'build/16x9/timeline.resolved.json': '{}',
      'build/16x9/segments/inconnu.mp4': 'inconnu', 'build/assets/img/derive.png': 'derive', 'build/analysis/master-1.wav': 'wav',
      'exports/clip-final.mp4': 'mp4', 'exports/clip-final.tmp.mp4': 'partiel', 'exports/archive/ancien.mp4': 'historique',
      'exports/clip-final.srt': 'srt', 'reports/r/report.md': 'rapport', 'media/images/copie.tmp.mp4': 'source',
    };
    const old = (Date.now() - 3600_000) / 1000;
    for (const [rel, c] of Object.entries(files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, c);
      fs.utimesSync(p, old, old);
    }
    return { dir, files };
  };
  const ok = async () => true;

  it('classement : seuls segments, mezzanines et exports partiels sont supprimables', () => {
    expect(classify('build/9x16/segments/0123456789abcdef.mp4')).toBeDefined();
    expect(classify('build/reel-x/mezzanine-0123456789ab.mov')).toBeDefined();
    expect(classify('exports/a.tmp.mp4')).toBeDefined();
    for (const f of ['media/images/a.png', 'media/audio/a.tmp.mp4', 'exports/a.mp4', 'exports/archive/a.tmp.mp4', 'build/assets/img/a.png', 'build/analysis/master.wav', 'build/16x9/timeline.resolved.json', 'build/16x9/segments/inconnu.mp4', 'project.json'])
      expect(classify(f)).toBeUndefined();
  });
  it('à blanc par défaut : rien n’est supprimé ; --apply : uniquement la liste blanche, traçé', async () => {
    const { dir, files } = mk();
    const dry = await cleanProject(dir, { verify: ok });
    expect(dry.applied).toBe(false);
    expect(dry.removed.map((r) => r.file).sort()).toEqual(['build/16x9/mezzanine-0123456789abcdef01234567.mp4', 'build/16x9/segments/0123456789abcdef01234567.mp4', 'build/16x9/segments/0123456789abcdef01234567.tmp.mp4', 'exports/clip-final.tmp.mp4']);
    for (const rel of Object.keys(files)) expect(fs.existsSync(path.join(dir, rel))).toBe(true);
    expect(dry.outOfScope.sort()).toEqual(['exports/archive/ancien.mp4', 'exports/clip-final.srt']);
    const r = await cleanProject(dir, { apply: true, verify: ok });
    const gone = new Set(r.removed.map((x) => x.file));
    for (const rel of Object.keys(files)) expect(fs.existsSync(path.join(dir, rel))).toBe(!gone.has(rel));
    expect(fs.readFileSync(path.join(dir, 'decisions.jsonl'), 'utf8')).toMatch(/nmsvs clean --apply/);
  });
  it('refus (rien supprimé) : MP4 final illisible, commande en cours, activité récente', async () => {
    const a = mk();
    await expect(cleanProject(a.dir, { apply: true, verify: async () => false })).rejects.toThrow(/illisible/);
    expect(fs.existsSync(path.join(a.dir, 'build/16x9/mezzanine-0123456789abcdef01234567.mp4'))).toBe(true);
    const bb = mk();
    updateManifest(bb.dir, (m) => { m.lastCommand = { argv: ['export'], at: new Date().toISOString(), status: 'running' }; });
    await expect(cleanProject(bb.dir, { apply: true, verify: ok })).rejects.toThrow(/en cours/);
    const c = mk();
    fs.writeFileSync(path.join(c.dir, 'build/16x9/segments/fedcba9876543210.mp4'), 'actif');
    await expect(cleanProject(c.dir, { apply: true, verify: ok })).rejects.toThrow(/traitement actif/);
    expect(fs.existsSync(path.join(c.dir, 'build/16x9/segments/0123456789abcdef01234567.mp4'))).toBe(true);
  });
});

// Images de référence (« golden ») des composants : styles de paroles, transitions, mouvements, deux formats.
// Première exécution : les références sont créées dans tests/golden (à valider visuellement une fois).
// Exécutions suivantes : comparaison SSIM ≥ 0,99. Contrôle du déterminisme : deux rendus identiques au bit près.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { RunContext } from '../../../src/core/context';
import { compileTimeline } from '../../../src/modules/timeline/compile';
import { renderStills } from '../../../src/modules/render/render';
import type { TimelineFile } from '../../../src/model/types';
import type { RTimeline } from '../../../src/remotion/types';
import { analysis, bundle, syncFor } from '../helpers';

const GOLDEN = path.resolve(__dirname, '..', '..', 'golden');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nmsvs golden '));
const ASSETS = path.join(TMP, 'build', 'assets', 'img');
const ctx = new RunContext('golden', undefined, true);
const pseudoProject = { dir: TMP } as any;

const ff = (args: string[]) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r;
};
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const TRANSITIONS = ['preset:crossfade-long', 'preset:slide-left', 'preset:zoom-through', 'preset:wipe-linear', 'preset:wipe-radial', 'preset:blur-dissolve', 'preset:dip-to-color', 'preset:cut'];
const STYLES = ['preset:lyrics-cartouche-default', 'preset:lyrics-text-on-image-default', 'preset:lyrics-parchment-default'];

function timelineFile(): TimelineFile {
  const cuts = [0, 10, 20, 30, 40, 50, 60, 70, 80];
  return {
    schemaVersion: 1,
    scenes: cuts.map((c, i) => ({
      id: `sc-${i}`,
      span: { from: { at: c }, to: i + 1 < cuts.length ? { at: cuts[i + 1] } : { end: true } },
      illustrations: [{ asset: ['img-a', 'img-b', 'img-c'][i % 3], motion: ['preset:slow-push-in', 'preset:pan-left-right', 'preset:beat-pulse'][i % 3] }],
      transitionIn: i === 0 ? 'preset:fade-black' : TRANSITIONS[i - 1],
      lyrics: { style: STYLES[i % 3], karaoke: 'word' },
      ...(i === 0 ? { title: { text: 'Le Phare Test', style: 'preset:title-parchment', durationSec: 6 } } : {}),
    })),
  } as TimelineFile;
}

function compile(format: '16x9' | '9x16'): RTimeline {
  const b = bundle({ timeline: timelineFile() });
  b.project.formats['16x9'] = { width: 480, height: 270, safeZone: 'preset:safe-16x9-default' };
  b.project.formats['9x16'] = { width: 270, height: 480, safeZone: 'preset:safe-9x16-social' };
  const { width: W, height: H } = b.project.formats[format];
  return compileTimeline(b, format, syncFor(), analysis(), (id, m) => ({ rel: `img/${id}-${format}.png`, sha: id, w: Math.round(W * m), h: Math.round(H * m), upscale: 1, subjectCut: 0, sourceId: id, fit: 'cover' }), () => null).timeline;
}

function frames(t: RTimeline): Record<string, number> {
  const f: Record<string, number> = { 'titre-parchemin': 60, 'fondu-ouverture': 8 };
  TRANSITIONS.forEach((tr, i) => {
    const at = (i + 1) * 10 * t.fps;
    f[`transition-${tr.replace('preset:', '')}`] = at + 3;
  });
  const lyr = (id: string, d = 20) => t.lyrics.find((l) => l.id === id)!.from + d;
  f['paroles-parchemin'] = lyr('verse-1.l2', 25);
  f['paroles-cartouche-karaoke'] = lyr('chorus-1.l1', 40);
  f['paroles-texte-sur-image'] = lyr('verse-2.l2', 25);
  const s = t.shots.find((x) => x.sceneId === 'sc-1')!;
  f['mouvement-pan-debut'] = s.from + 20;
  f['mouvement-pan-fin'] = s.to - 20;
  return f;
}

beforeAll(() => {
  fs.mkdirSync(ASSETS, { recursive: true });
  fs.mkdirSync(GOLDEN, { recursive: true });
  const src = {
    'img-a': 'mandelbrot=s=WxH:maxiter=120',
    'img-b': 'gradients=s=WxH:c0=0x203060:c1=0xc08040:c2=0x602030:n=3:seed=7',
    'img-c': 'testsrc2=s=WxH',
  };
  for (const [id, lav] of Object.entries(src)) {
    ff(['-f', 'lavfi', '-i', lav.replace('WxH', '720x405'), '-frames:v', '1', path.join(ASSETS, `${id}-16x9.png`)]);
    ff(['-f', 'lavfi', '-i', lav.replace('WxH', '405x720'), '-frames:v', '1', path.join(ASSETS, `${id}-9x16.png`)]);
  }
}, 120_000);

for (const format of ['16x9', '9x16'] as const) {
  describe(`golden ${format}`, () => {
    it('chaque style de paroles, transition et mouvement correspond à sa référence', async () => {
      const t = compile(format);
      const fr = frames(t);
      const names = Object.keys(fr);
      const out = path.join(TMP, `out-${format}`);
      const files = await renderStills(ctx, pseudoProject, t, names.map((n) => fr[n]), out);
      const created: string[] = [];
      const results: Record<string, number> = {};
      names.forEach((n, i) => {
        const gold = path.join(GOLDEN, `${format}-${n}.png`);
        if (!fs.existsSync(gold)) {
          fs.copyFileSync(files[i], gold);
          created.push(n);
          return;
        }
        // Niveau de journal « info » nécessaire : la ligne de résultat SSIM n'est pas émise en « error ».
        const r = spawnSync('ffmpeg', ['-hide_banner', '-i', files[i], '-i', gold, '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' });
        results[n] = Number(r.stderr.match(/All:([\d.]+)/)?.[1] ?? 0);
      });
      if (created.length) console.warn(`[golden ${format}] références créées : ${created.join(', ')}`);
      console.log(`[golden ${format}] SSIM :`, JSON.stringify(results));
      for (const [n, v] of Object.entries(results)) expect({ n, ssim: v, ok: v >= 0.99 }).toEqual({ n, ssim: v, ok: true });
    });
  });
}

// Page tournée : timeline dédiée (deux scènes), pour ne pas déplacer les images des références existantes.
function compilePageTurn(format: '16x9' | '9x16'): RTimeline {
  const b = bundle({
    timeline: {
      schemaVersion: 1,
      scenes: [
        { id: 'pt-a', span: { from: { at: 0 }, to: { at: 10 } }, illustrations: [{ asset: 'img-c', motion: 'preset:still' }], lyrics: { style: 'none' } },
        { id: 'pt-b', span: { from: { at: 10 }, to: { end: true } }, illustrations: [{ asset: 'img-b', motion: 'preset:still' }], transitionIn: 'preset:page-turn', lyrics: { style: 'none' } },
      ],
    } as TimelineFile,
  });
  b.project.formats['16x9'] = { width: 480, height: 270, safeZone: 'preset:safe-16x9-default' };
  b.project.formats['9x16'] = { width: 270, height: 480, safeZone: 'preset:safe-9x16-social' };
  const { width: W, height: H } = b.project.formats[format];
  return compileTimeline(b, format, syncFor(), analysis(), (id, m) => ({ rel: `img/${id}-${format}.png`, sha: id, w: Math.round(W * m), h: Math.round(H * m), upscale: 1, subjectCut: 0, sourceId: id, fit: 'cover' }), () => null).timeline;
}

for (const format of ['16x9', '9x16'] as const) {
  describe(`golden page tournée ${format}`, () => {
    it('quart, moitié et trois quarts du retournement correspondent aux références', async () => {
      const t = compilePageTurn(format);
      const a = t.shots.find((s) => s.sceneId === 'pt-a')!;
      expect(a.exit?.type).toBe('page-turn');
      const n = a.exit!.frames;
      const start = a.to - n;
      const fr: Record<string, number> = {
        'transition-page-turn-25': start + Math.round(n * 0.25),
        'transition-page-turn-50': start + Math.round(n * 0.5),
        'transition-page-turn-75': start + Math.round(n * 0.75),
      };
      const names = Object.keys(fr);
      const files = await renderStills(ctx, pseudoProject, t, names.map((k) => fr[k]), path.join(TMP, `pt-${format}`));
      const created: string[] = [];
      const results: Record<string, number> = {};
      names.forEach((k, i) => {
        const gold = path.join(GOLDEN, `${format}-${k}.png`);
        if (!fs.existsSync(gold)) { fs.copyFileSync(files[i], gold); created.push(k); return; }
        const r = spawnSync('ffmpeg', ['-hide_banner', '-i', files[i], '-i', gold, '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' });
        results[k] = Number(r.stderr.match(/All:([\d.]+)/)?.[1] ?? 0);
      });
      if (created.length) console.warn(`[golden page tournée ${format}] références créées : ${created.join(', ')}`);
      console.log(`[golden page tournée ${format}] SSIM :`, JSON.stringify(results));
      for (const [k, v] of Object.entries(results)) expect({ k, ssim: v, ok: v >= 0.99 }).toEqual({ k, ssim: v, ok: true });
    });
  });
}

// Paroles en défilement (flow: scroll), 9:16 : ligne en attente atténuée, montée, puis premier plan avec karaoké.
describe('golden paroles en défilement 9x16', () => {
  it('attente, mi-montée et premier plan correspondent aux références', async () => {
    const tl = timelineFile();
    for (const sc of tl.scenes) sc.lyrics = { style: { type: 'text-on-image', flow: 'scroll', karaoke: 'word', position: 'lower-third', shadow: true, scrim: true } as any };
    const b = bundle({ timeline: tl });
    b.project.formats['9x16'] = { width: 270, height: 480, safeZone: 'preset:safe-9x16-social' };
    const t = compileTimeline(b, '9x16', syncFor(), analysis(), (id, m) => ({ rel: `img/${id}-9x16.png`, sha: id, w: Math.round(270 * m), h: Math.round(480 * m), upscale: 1, subjectCut: 0, sourceId: id, fit: 'cover' }), () => null).timeline;
    const l = t.lyrics.find((x) => x.scroll && x.from < x.scroll.focusFrom - 8)!; // une ligne qui passe par l'attente
    expect(l).toBeDefined();
    const fr: Record<string, number> = {
      'paroles-defilement-attente': l.from + 4,
      'paroles-defilement-montee': l.scroll!.focusFrom - 4,
      'paroles-defilement-premier-plan': l.scroll!.focusFrom + 6,
    };
    const names = Object.keys(fr);
    const files = await renderStills(ctx, pseudoProject, t, names.map((k) => fr[k]), path.join(TMP, 'scroll-9x16'));
    const created: string[] = [];
    const results: Record<string, number> = {};
    names.forEach((k, i) => {
      const gold = path.join(GOLDEN, `9x16-${k}.png`);
      if (!fs.existsSync(gold)) { fs.copyFileSync(files[i], gold); created.push(k); return; }
      const r = spawnSync('ffmpeg', ['-hide_banner', '-i', files[i], '-i', gold, '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' });
      results[k] = Number(r.stderr.match(/All:([\d.]+)/)?.[1] ?? 0);
    });
    if (created.length) console.warn(`[golden défilement 9x16] références créées : ${created.join(', ')}`);
    console.log('[golden défilement 9x16] SSIM :', JSON.stringify(results));
    for (const [k, v] of Object.entries(results)) expect({ k, ssim: v, ok: v >= 0.99 }).toEqual({ k, ssim: v, ok: true });
  });
});

describe('déterminisme du rendu (NF-01)', () => {
  it('deux rendus de la même image sont identiques au bit près', async () => {
    const t = compile('16x9');
    const f = frames(t)['paroles-cartouche-karaoke'];
    const [a] = await renderStills(ctx, pseudoProject, t, [f], path.join(TMP, 'det-a'));
    const [b] = await renderStills(ctx, pseudoProject, t, [f], path.join(TMP, 'det-b'));
    expect(sha(a)).toBe(sha(b));
  });
});

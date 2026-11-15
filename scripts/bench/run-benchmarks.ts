// Benchmarks B1 (concurrence / GL), B2 (flou du cartouche), B4 (encodeurs finaux), B5 (mezzanine) — docs/08 §3.
// Rendu 4K réel (3840×2160) d'une scène type ; résultats dans reports/bench/benchmarks.json.
// Les réglages par défaut de rendu sont ensuite fixés dans presets/render.json (décision automatique, docs/08 §3).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { RunContext } from '../../src/core/context';
import { ROOT, PATHS } from '../../src/core/paths';
import { loadProject } from '../../src/model/project';
import { initProject } from '../../src/modules/project/init';
import { importAudio, importImages, importLyrics } from '../../src/modules/project/import';
import { analyzeAudio } from '../../src/modules/analysis/analyze';
import { runSync } from '../../src/modules/sync/sync';
import { buildTimeline } from '../../src/modules/timeline/build';
import { getBundle, prepareBrowser } from '../../src/modules/render/render';
import { startAssetServer } from '../../src/modules/render/server';
import { assetsDir } from '../../src/modules/assets/prepare';
import { synthWav, FIXTURE_LYRICS } from '../../tests/fixtures/make-fixture';
import type { RTimeline } from '../../src/remotion/types';

const OUT = path.join(ROOT, 'reports', 'bench');
const WORK = path.join(ROOT, 'tests', '.tmp', 'bench');
const FRAMES = Number(process.env.BENCH_FRAMES ?? 240);
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
const results: Record<string, any> = { date: new Date().toISOString(), frames: FRAMES, resolution: '3840x2160' };
const save = () => fs.writeFileSync(path.join(OUT, 'benchmarks.json'), JSON.stringify(results, null, 2));
const ff = (args: string[]) => {
  const t0 = performance.now();
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(r.stderr.slice(-800));
  return { sec: (performance.now() - t0) / 1000, stderr: r.stderr };
};
const size = (f: string) => fs.statSync(f).size;

async function setup() {
  process.env.NMSVS_PROJECTS = path.join(WORK, 'projects');
  const dir = path.join(WORK, 'projects', 'bench-4k');
  const ctx = new RunContext('bench', dir, true);
  if (!fs.existsSync(path.join(dir, 'project.json'))) {
    initProject('bench-4k', { title: 'Benchmark 4K', root: path.join(WORK, 'projects') });
    const src = path.join(WORK, 'src');
    fs.mkdirSync(src, { recursive: true });
    synthWav(path.join(src, 'master.wav'), 12, 120, [[1, 5], [6, 11]]);
    fs.writeFileSync(path.join(src, 'paroles.txt'), FIXTURE_LYRICS);
    ff(['-f', 'lavfi', '-i', 'mandelbrot=s=4400x2475:maxiter=300', '-frames:v', '1', path.join(src, 'a.png')]);
    ff(['-f', 'lavfi', '-i', 'gradients=s=4400x2475:c0=0x203060:c1=0xc08040:c2=0x602030:n=3:seed=7', '-frames:v', '1', path.join(src, 'b.png')]);
    await importAudio(ctx, dir, path.join(src, 'master.wav'));
    importLyrics(ctx, dir, path.join(src, 'paroles.txt'), {});
    await importImages(ctx, dir, [path.join(src, 'a.png'), path.join(src, 'b.png')]);
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
    pj.sync.engine = 'uniform';
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(pj, null, 2));
  }
  return { dir, ctx };
}

function timelineWith(dir: string, style: string) {
  fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({
    schemaVersion: 1,
    scenes: [{ id: 'sc-1', span: { from: { at: 0 }, to: { end: true } }, illustrations: [{ asset: 'img-a', motion: 'preset:slow-push-in' }, { asset: 'img-b', motion: 'preset:drift' }], distribution: 'even', illustrationTransition: 'preset:crossfade-beat', lyrics: { style } }],
  }, null, 2));
}

async function renderRange(t: RTimeline, assetRoot: string, out: string, o: { concurrency: number; gl: any; codec?: 'h264' | 'prores' }) {
  const serveUrl = await getBundle(new RunContext('bench', undefined, true));
  const server = await startAssetServer(assetRoot);
  try {
    const props = { ...t, assetBaseUrl: server.url } as any;
    const composition = await selectComposition({ serveUrl, id: 'Main', inputProps: props, logLevel: 'error', chromiumOptions: { gl: o.gl } });
    const t0 = performance.now();
    await renderMedia({
      composition, serveUrl, inputProps: props, outputLocation: out, frameRange: [0, FRAMES - 1], muted: true,
      codec: o.codec ?? 'h264', crf: (o.codec ?? 'h264') === 'h264' ? 10 : null, x264Preset: (o.codec ?? 'h264') === 'h264' ? 'veryfast' : undefined,
      proResProfile: o.codec === 'prores' ? 'hq' : undefined, pixelFormat: o.codec === 'prores' ? 'yuv422p10le' : 'yuv420p',
      imageFormat: 'jpeg', jpegQuality: 95, colorSpace: 'bt709', concurrency: o.concurrency, chromiumOptions: { gl: o.gl }, logLevel: 'error', overwrite: true,
    });
    const sec = (performance.now() - t0) / 1000;
    return { sec, fps: FRAMES / sec, bytes: size(out) };
  } finally {
    await server.close();
  }
}

async function main() {
  const { dir, ctx } = await setup();
  await prepareBrowser(ctx);
  timelineWith(dir, 'preset:lyrics-cartouche-default');
  let b = loadProject(dir);
  await analyzeAudio(ctx, b);
  await runSync(ctx, b, { engine: 'uniform' });
  const blurT = (await buildTimeline(ctx, b, '16x9')).timeline;
  const assetRoot = assetsDir(b);
  console.log(`Scène 4K : ${blurT.shots.length} plans, ${blurT.lyrics.length} blocs de paroles ; ${FRAMES} images par mesure.`);

  // B1 — concurrence (GL angle)
  results.B1 = { concurrency: [] as any[], gl: [] as any[] };
  for (const c of [2, 4, 6, 8]) {
    const r = await renderRange(blurT, assetRoot, path.join(WORK, `b1-c${c}.mp4`), { concurrency: c, gl: 'angle' });
    console.log(`B1 concurrence ${c} : ${r.fps.toFixed(2)} i/s`);
    results.B1.concurrency.push({ concurrency: c, gl: 'angle', ...r });
    save();
  }
  const best = results.B1.concurrency.reduce((a: any, x: any) => (x.fps > a.fps ? x : a));
  for (const gl of ['vulkan', 'swangle', null]) {
    try {
      const r = await renderRange(blurT, assetRoot, path.join(WORK, `b1-gl-${gl}.mp4`), { concurrency: best.concurrency, gl });
      console.log(`B1 gl ${gl} : ${r.fps.toFixed(2)} i/s`);
      results.B1.gl.push({ gl: gl ?? 'null (défaut Chrome)', concurrency: best.concurrency, ...r });
    } catch (e) {
      console.log(`B1 gl ${gl} : échec ${(e as Error).message.slice(0, 120)}`);
      results.B1.gl.push({ gl: gl ?? 'null', error: (e as Error).message.slice(0, 300) });
    }
    save();
  }
  const glCands = [{ gl: 'angle', fps: best.fps }, ...results.B1.gl.filter((x: any) => x.fps)];
  const bestGl = glCands.reduce((a: any, x: any) => (x.fps > a.fps * 1.05 ? x : a));
  results.decision = { concurrency: best.concurrency, gl: bestGl.gl === 'null (défaut Chrome)' ? null : bestGl.gl };

  // B2 — cartouche avec / sans flou d'arrière-plan
  timelineWith(dir, 'preset:lyrics-fast');
  b = loadProject(dir);
  const noBlurT = (await buildTimeline(ctx, b, '16x9')).timeline;
  const nb = await renderRange(noBlurT, assetRoot, path.join(WORK, 'b2-noblur.mp4'), { concurrency: best.concurrency, gl: results.decision.gl });
  results.B2 = { withBlur: { fps: best.fps }, withoutBlur: { fps: nb.fps }, ratio: nb.fps / best.fps };
  console.log(`B2 sans flou : ${nb.fps.toFixed(2)} i/s (avec : ${best.fps.toFixed(2)})`);
  save();

  // B5 — mezzanine H.264 CRF 10 vs ProRes 422 HQ
  const pr = await renderRange(blurT, assetRoot, path.join(WORK, 'b5-prores.mov'), { concurrency: best.concurrency, gl: results.decision.gl, codec: 'prores' });
  results.B5 = { h264: { fps: best.fps, mbPerMin: (best.bytes / 2 ** 20) * (60 * 30 / FRAMES) }, prores: { fps: pr.fps, mbPerMin: (pr.bytes / 2 ** 20) * (60 * 30 / FRAMES) } };
  console.log(`B5 ProRes : ${pr.fps.toFixed(2)} i/s, ${results.B5.prores.mbPerMin.toFixed(0)} Mo/min ; H.264 : ${results.B5.h264.mbPerMin.toFixed(0)} Mo/min`);
  save();

  // B4 — encodage final depuis la mezzanine H.264 (qualité VMAF vs mezzanine)
  const mezz = path.join(WORK, `b1-c${best.concurrency}.mp4`);
  const encs: [string, string[]][] = [
    ['libx264 slow CRF16', ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16']],
    ['libx264 medium CRF16', ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16']],
    ['hevc_amf CQP20 quality', ['-c:v', 'hevc_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '20']],
    ['h264_amf CQP18 quality', ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '18', '-qp_p', '18']],
  ];
  results.B4 = [];
  for (const [name, args] of encs) {
    const out = path.join(WORK, `b4-${name.replace(/\W+/g, '-')}.mp4`);
    const e = ff(['-i', mezz, ...args, '-pix_fmt', 'yuv420p', out]);
    const v = ff(['-i', out, '-i', mezz, '-lavfi', '[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]libvmaf=n_threads=12:n_subsample=4', '-f', 'null', '-']);
    const vmaf = Number(v.stderr.match(/VMAF score:\s*([\d.]+)/)?.[1] ?? NaN);
    const row = { encoder: name, sec: e.sec, fps: FRAMES / e.sec, mbps: (size(out) * 8) / (FRAMES / 30) / 1e6, vmaf, minutesFor4min: (e.sec * (240 * 30 / FRAMES)) / 60 };
    console.log(`B4 ${name} : ${row.fps.toFixed(1)} i/s, ${row.mbps.toFixed(1)} Mb/s, VMAF ${vmaf}`);
    results.B4.push(row);
    save();
  }

  // Décision automatique : réglages de rendu par défaut
  const renderPreset = { concurrency: results.decision.concurrency, gl: results.decision.gl, mezz: { codec: 'h264', crf: 10, preset: 'veryfast', imageFormat: 'jpeg', jpegQuality: 95 } };
  fs.writeFileSync(path.join(PATHS.presets, 'render.json'), JSON.stringify(renderPreset, null, 2) + '\n');
  results.renderPreset = renderPreset;
  save();
  console.log('Terminé. presets/render.json mis à jour :', JSON.stringify(renderPreset));
}

main().catch((e) => { console.error(e); process.exit(1); });

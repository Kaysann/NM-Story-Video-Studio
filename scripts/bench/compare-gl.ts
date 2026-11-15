// Vérifie que deux moteurs GL produisent la même image (SSIM) sur des images types du projet de benchmark.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RunContext } from '../../src/core/context';
import { ROOT } from '../../src/core/paths';
import { loadProject } from '../../src/model/project';
import { buildTimeline } from '../../src/modules/timeline/build';
import { renderStills } from '../../src/modules/render/render';

const dir = path.join(ROOT, 'tests', '.tmp', 'bench', 'projects', 'bench-4k');
const ctx = new RunContext('gl', dir, true);
const b = loadProject(dir);
const { timeline } = await buildTimeline(ctx, b, '16x9');
const frames = [30, 100, 170, 230];
const out = path.join(ROOT, 'tests', '.tmp', 'bench', 'gl');
const a = await renderStills(ctx, b, timeline, frames, path.join(out, 'angle'), { gl: 'angle' });
const v = await renderStills(ctx, b, timeline, frames, path.join(out, 'vulkan'), { gl: 'vulkan' as any });
for (let i = 0; i < frames.length; i++) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', a[i], '-i', v[i], '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' });
  console.log(`image ${frames[i]} : SSIM angle/vulkan = ${r.stderr.match(/All:([\d.]+)/)?.[1]}`);
}

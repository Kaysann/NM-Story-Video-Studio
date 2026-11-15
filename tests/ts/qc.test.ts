import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { runQc, type QcInput } from '../../src/modules/qc/qc';
import type { RTimeline } from '../../src/remotion/types';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmsvs-qc '));
const ff = (args: string[]) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(String(r.stderr));
};
const TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const make = (name: string, o: { size?: string; audioSec?: number; black?: boolean } = {}) => {
  const f = path.join(dir, name);
  const sp = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
  const vf = ['-vf', o.black ? `drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,1.5,2.6)',${sp}` : sp];
  ff(['-f', 'lavfi', '-i', `testsrc2=size=${o.size ?? '640x360'}:rate=30:duration=4`, '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${o.audioSec ?? 4}`,
    ...vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...TAGS, '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-shortest', '-t', '4', f]);
  return f;
};
const timeline: RTimeline = {
  version: 1, format: '16x9', width: 640, height: 360, fps: 30, durationInFrames: 120, assetBaseUrl: '',
  safe: { title: { x: 32, y: 18, w: 576, h: 324 }, action: { x: 22, y: 13, w: 596, h: 334 } },
  shots: [{ id: 's', sceneId: 'x', from: 0, to: 120, src: 'a.png', srcW: 640, srcH: 360, fit: 'cover', z: 0, motion: { from: { scale: 1, x: 0.5, y: 0.5 }, to: { scale: 1, x: 0.5, y: 0.5 }, easing: 'linear' } }],
  lyrics: [], titles: [], fades: [], effects: { vignette: 0, grain: 0 }, fonts: [],
};
const base = (file: string, over: Partial<QcInput> = {}): QcInput => ({
  file, timeline, warnings: [], mezzanine: path.join(dir, 'ok.mp4'),
  expected: { width: 640, height: 360, fps: 30, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', sampleRate: 48000, durationSec: 4 },
  ...over,
});
const status = async (q: QcInput) => Object.fromEntries((await runQc(q)).checks.map((c) => [c.id, c.status]));

describe('contrôle qualité : détection des défauts', () => {
  beforeAll(() => { make('ok.mp4'); }, 60_000);
  it('vidéo conforme : aucun défaut bloquant ou majeur', async () => {
    const r = await runQc(base(path.join(dir, 'ok.mp4')));
    expect(r.blocking).toBe(false);
    expect(r.major).toBe(0);
  });
  it('désynchronisation audio de 3 images → QC-T3 bloquant', async () => {
    const f = make('desync.mp4', { audioSec: 3.9 });
    const r = await runQc(base(f));
    expect(r.checks.find((c) => c.id === 'QC-T3')!.status).toBe('ko');
    expect(r.blocking).toBe(true);
  });
  it('noir non prévu → QC-T6 ; mais toléré s’il correspond à un fondu déclaré', async () => {
    const f = make('black.mp4', { black: true });
    expect((await status(base(f)))['QC-T6']).toBe('ko');
    const withFade = { ...timeline, fades: [{ from: 45, peak: 60, to: 78, color: '#000000' }] };
    expect((await status(base(f, { timeline: withFade })))['QC-T6']).toBe('ok');
  });
  it('mauvaise résolution → QC-T1 bloquant', async () => {
    const f = make('size.mp4', { size: '642x360' });
    expect((await status(base(f, { mezzanine: undefined })))['QC-T1']).toBe('ko');
  });
  it('calque non déclaré ou superposition de contrôle active → QC-E7 bloquant', async () => {
    const bad = { ...timeline, lyrics: [{ style: { type: 'watermark' } } as any] };
    expect((await status(base(path.join(dir, 'ok.mp4'), { timeline: bad })))['QC-E7']).toBe('ko');
    expect((await status(base(path.join(dir, 'ok.mp4'), { timeline: { ...timeline, showSafe: true } })))['QC-E7']).toBe('ko');
  });
  it('QC-E4 : texte clair sur fond clair détecté ; sur fond sombre accepté', async () => {
    const white = path.join(dir, 'white.mp4');
    ff(['-f', 'lavfi', '-i', 'color=c=white:s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-vf', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...TAGS, '-c:a', 'aac', '-ac', '2', '-t', '4', white]);
    const lyric = (color: string) => ({ id: 'verse-1.l1', from: 30, to: 90, groupFrom: 30, groupTo: 90, box: { x: 100, y: 250, w: 440, h: 40 }, groupBox: { x: 100, y: 250, w: 440, h: 40 }, style: { type: 'text-on-image', color } }) as any;
    expect((await status(base(white, { mezzanine: undefined, timeline: { ...timeline, lyrics: [lyric('#F5EBDD')] } })))['QC-E4']).toBe('ko');
    expect((await status(base(white, { mezzanine: undefined, timeline: { ...timeline, lyrics: [lyric('#202020')] } })))['QC-E4']).toBe('ok');
  });
  it('alertes du compilateur reportées (zone sûre, agrandissement)', async () => {
    const r = await status(base(path.join(dir, 'ok.mp4'), { warnings: [{ code: 'QC-E1', message: 'x' }, { code: 'QC-E5', message: 'y' }] }));
    expect(r['QC-E1']).toBe('ko');
    expect(r['QC-E5']).toBe('ko');
  });
});

import path from 'node:path';
import fs from 'node:fs';
import { hashFileSync } from '../../core/hash';
import { ensureDir, readJson, writeJsonAtomic } from '../../core/fsx';
import { ffmpeg, TOOLS } from '../../core/tools';
import { run } from '../../core/exec';
import type { RunContext } from '../../core/context';
import { projectPath, type ProjectBundle } from '../../model/project';
import { assertValid } from '../../model/schemas';
import type { AudioAnalysis } from '../../model/types';
import { runStep } from '../../pipeline/step';
import { callPython } from '../python/bridge';

export const analysisFile = (dir: string) => path.join(dir, 'analysis', 'audio.json');

/** WAV PCM stéréo 44,1 kHz dérivé du master (le master n'est jamais modifié). */
export async function analysisWav(b: ProjectBundle): Promise<string> {
  const master = projectPath(b, b.project.audio.master);
  const sha = hashFileSync(master);
  const out = path.join(b.dir, 'build', 'analysis', `master-${sha.slice(0, 12)}.wav`);
  if (!fs.existsSync(out)) {
    ensureDir(path.dirname(out));
    const tmp = out.replace(/\.wav$/, '.tmp.wav');
    await ffmpeg(['-i', master, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', tmp]);
    fs.renameSync(tmp, out);
  }
  return out;
}

/** Sonie intégrée, LRA et crête vraie (EBU R128) via FFmpeg. */
export async function measureLoudness(file: string): Promise<{ integratedLUFS: number; truePeakDBTP: number; lra: number }> {
  const r = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { check: true, errorCode: 'E_FFMPEG' });
  const summary = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  const num = (re: RegExp) => {
    const m = summary.match(re);
    return m ? Number(m[1]) : NaN;
  };
  return { integratedLUFS: num(/I:\s+(-?[\d.]+) LUFS/), lra: num(/LRA:\s+(-?[\d.]+) LU/), truePeakDBTP: num(/Peak:\s+(-?[\d.]+) dBFS/) };
}

export async function analyzeAudio(ctx: RunContext, b: ProjectBundle, force = false): Promise<AudioAnalysis> {
  const master = projectPath(b, b.project.audio.master);
  const sha = hashFileSync(master);
  const out = analysisFile(b.dir);
  const { value } = await runStep(ctx, b.dir, {
    id: 'analyze-audio',
    version: 1,
    inputs: { audio: sha },
    outputs: [out],
    load: () => readJson<AudioAnalysis>(out),
    run: async () => {
      const wav = await analysisWav(b);
      const res = await ctx.log.time('analyze-audio', 'Analyse musicale (librosa)', () =>
        callPython<{ analysis: Omit<AudioAnalysis, 'audioSha256'> }>(ctx, 'analyze', { audio: wav }, {}, path.join(b.dir, 'build')),
      );
      const loudness = await measureLoudness(master);
      const analysis: AudioAnalysis = { ...res.outputs.analysis, audioSha256: sha, loudness } as AudioAnalysis;
      assertValid('audio-analysis', analysis, out);
      writeJsonAtomic(out, analysis);
      return analysis;
    },
  }, force);
  ctx.log.info(`Tempo ${value.tempo.bpm} BPM, ${value.beats.length} battements, mesure ${value.meter} temps, ${value.segments.length} segments, ${value.loudness?.integratedLUFS} LUFS`);
  return value;
}

/** Instants utiles pour l'ancrage (« snap ») : battements et temps forts. */
export function nearest(list: number[], t: number, tol: number): number {
  let best = t;
  let d = tol;
  for (const x of list) {
    const dd = Math.abs(x - t);
    if (dd <= d) {
      d = dd;
      best = x;
    }
  }
  return best;
}

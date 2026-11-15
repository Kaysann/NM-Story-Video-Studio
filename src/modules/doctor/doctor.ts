import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../../core/exec';
import { PATHS } from '../../core/paths';
import { TOOLS, toolVersions } from '../../core/tools';
import type { RunContext } from '../../core/context';
import { callPython, pythonAvailable } from '../python/bridge';

export interface DoctorCheck { id: string; ok: boolean; detail: string; required: boolean }

/** Diagnostic de l'environnement : outils, encodeurs, Python, modèles, navigateur de rendu. */
export async function doctor(ctx: RunContext): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
  const checks: DoctorCheck[] = [];
  const add = (id: string, ok: boolean, detail: string, required = true) => checks.push({ id, ok, detail, required });
  const v = await toolVersions();
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20, `Node ${process.version}`);
  add('ffmpeg', v.ffmpeg !== 'absent', `FFmpeg ${v.ffmpeg}`);
  if (v.ffmpeg !== 'absent') {
    const enc = (await run(TOOLS.ffmpeg, ['-hide_banner', '-encoders'])).stdout;
    for (const e of ['libx264', 'aac']) add(`encodeur:${e}`, enc.includes(` ${e} `), e);
    for (const e of ['hevc_amf', 'h264_amf']) {
      const r = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '0.2', '-c:v', e, '-f', 'null', '-']);
      add(`encodeur:${e}`, r.code === 0, r.code === 0 ? 'fonctionnel (GPU AMD)' : 'indisponible : profils rapides inutilisables', false);
    }
    const filters = (await run(TOOLS.ffmpeg, ['-hide_banner', '-filters'])).stdout;
    for (const f of ['ebur128', 'blackdetect', 'freezedetect', 'ssim', 'libvmaf', 'lut3d', 'colorbalance']) add(`filtre:${f}`, filters.includes(` ${f} `), f, f !== 'libvmaf');
  }
  add('python-venv', pythonAvailable(), TOOLS.python);
  if (pythonAvailable()) {
    try {
      const r = await callPython<{ python: string; packages: Record<string, string | null>; modelsPresent: string[] }>(ctx, 'env-check', {}, {}, path.join(os.tmpdir(), 'nmsvs-doctor'));
      add('python', r.outputs.python.startsWith('3.12'), `Python ${r.outputs.python}`);
      for (const [p, ver] of Object.entries(r.outputs.packages)) add(`py:${p}`, !!ver, ver ?? 'absent', ['librosa', 'numpy', 'pillow'].includes(p));
      const fw = fs.existsSync(path.join(PATHS.models, 'faster-whisper'));
      const al = fs.existsSync(path.join(PATHS.models, 'align'));
      add('modèle:asr', fw, fw ? 'faster-whisper présent' : 'sera téléchargé au premier `nmsvs sync` (~3 Go)', false);
      add('modèle:alignement', al, al ? 'wav2vec2 FR présent' : 'sera téléchargé au premier `nmsvs sync` (~1,2 Go)', false);
    } catch (e) {
      add('python', false, (e as Error).message);
    }
  }
  const shell = path.join(PATHS.models, '..');
  void shell;
  add('remotion', fs.existsSync(path.join(PATHS.remotionEntry)), `Remotion ${v.remotion}`);
  add('cpu', true, `${os.cpus()[0]?.model.trim()} — ${os.cpus().length} threads, ${(os.totalmem() / 2 ** 30).toFixed(1)} Go`, false);
  const ok = checks.filter((c) => c.required).every((c) => c.ok);
  return { checks, ok };
}

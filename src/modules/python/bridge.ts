import fs from 'node:fs';
import path from 'node:path';
import { run } from '../../core/exec';
import { NmsvsError } from '../../core/errors';
import { ensureDir, readJson, writeJsonAtomic } from '../../core/fsx';
import { PATHS } from '../../core/paths';
import { TOOLS } from '../../core/tools';
import type { RunContext } from '../../core/context';

export type PyCommand = 'env-check' | 'analyze' | 'transcribe' | 'align' | 'image-stats';

export interface PyResponse<T = any> {
  schemaVersion: 1;
  status: 'ok' | 'error';
  outputs: T;
  metrics?: Record<string, number>;
  toolVersions?: Record<string, string>;
  warnings?: string[];
  error?: { code: string; message: string; detail?: unknown };
}

export function pythonAvailable(): boolean {
  return fs.existsSync(TOOLS.python);
}

/** Appelle le worker Python via le contrat JSON fichier ; relaie la progression dans le journal. */
export async function callPython<T = any>(ctx: RunContext, command: PyCommand, inputs: object, params: object, workDir: string): Promise<PyResponse<T>> {
  if (!pythonAvailable()) {
    throw new NmsvsError('E_DEP_MISSING', `Environnement Python introuvable (${TOOLS.python}).`, 'Créer le venv : py -3.12 -m venv .venv puis pip install -r python/requirements.lock');
  }
  const dir = path.join(workDir, 'py');
  ensureDir(dir);
  const stamp = `${command}-${Date.now()}`;
  const reqFile = path.join(dir, `${stamp}.req.json`);
  const resFile = path.join(dir, `${stamp}.res.json`);
  writeJsonAtomic(reqFile, { schemaVersion: 1, command, inputs, params: { modelsDir: PATHS.models, ...params }, workDir });
  let lastPct = -1;
  const r = await run(TOOLS.python, ['-X', 'utf8', '-m', 'nmsvs_audio', command, '--request', reqFile, '--response', resFile], {
    cwd: PATHS.pythonSrc,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' },
    onStderrLine: (line) => {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'progress') {
          const pct = Math.floor(ev.ratio * 10) * 10;
          if (pct !== lastPct) {
            lastPct = pct;
            ctx.log.debug(`${ev.step} ${pct} %`, undefined, `py:${command}`);
          }
        } else if (ev.type === 'log') ctx.log.log(ev.level === 'warn' ? 'warn' : 'info', ev.msg, undefined, `py:${command}`);
      } catch {
        if (line.trim()) ctx.log.debug(line, undefined, `py:${command}`);
      }
    },
  });
  if (!fs.existsSync(resFile)) {
    throw new NmsvsError('E_PY_FAILED', `Le worker Python s’est arrêté sans réponse (code ${r.code}).`, 'Voir log.jsonl ; vérifier `nmsvs doctor`.', r.stderr.slice(-2000));
  }
  const res = readJson<PyResponse<T>>(resFile);
  if (res.status !== 'ok') {
    const code = res.error?.code === 'E_ASSET_MISSING' ? 'E_ASSET_MISSING' : 'E_PY_FAILED';
    throw new NmsvsError(code, `Python (${command}) : ${res.error?.message}`, 'Voir le détail dans log.jsonl.', res.error?.detail);
  }
  // Les requêtes/réponses sont conservées pour diagnostic, sauf les plus anciennes.
  const old = fs.readdirSync(dir).sort().slice(0, -40);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return res;
}

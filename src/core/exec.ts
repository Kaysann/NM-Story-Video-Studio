import { spawn } from 'node:child_process';
import { NmsvsError } from './errors';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStderrLine?: (line: string) => void;
  /** Lève une erreur si le code de retour ≠ 0. */
  check?: boolean;
  errorCode?: 'E_FFMPEG' | 'E_PY_FAILED' | 'E_INTERNAL';
}

// Processus enfants actifs : arrêtés proprement sur Ctrl+C.
const children = new Set<import('node:child_process').ChildProcess>();
export function killChildren() {
  for (const c of children) {
    try { c.kill(); } catch { /* déjà terminé */ }
  }
}

/** Exécute un programme sans shell (arguments passés tels quels : pas de problème d'espaces). */
export function run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true });
    children.add(child);
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (opts.onStderrLine) {
        pending += s;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        lines.forEach((l) => l && opts.onStderrLine!(l));
      }
    });
    child.on('error', (e) => {
      children.delete(child);
      reject(new NmsvsError('E_DEP_MISSING', `Impossible de lancer « ${cmd} » : ${e.message}`, 'Lancer `nmsvs doctor`.'));
    });
    child.on('close', (code) => {
      children.delete(child);
      const res = { code: code ?? -1, stdout, stderr };
      if (opts.check && res.code !== 0) {
        const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
        reject(new NmsvsError(opts.errorCode ?? 'E_INTERNAL', `« ${cmd} » a échoué (code ${res.code}) :\n${tail}`, 'Voir le journal de l’exécution.', { args }));
      } else resolve(res);
    });
  });
}

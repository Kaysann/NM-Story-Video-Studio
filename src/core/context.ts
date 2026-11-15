import path from 'node:path';
import { Logger } from './log';
import { ROOT } from './paths';
import { ensureDir } from './fsx';

/** Contexte d'une exécution de commande : identifiant, dossier de rapport, journal. */
export class RunContext {
  readonly id: string;
  readonly startedAt = new Date();
  readonly log: Logger;
  readonly warnings: { code: string; message: string; data?: unknown }[] = [];
  readonly artifacts: string[] = [];
  readonly steps: { id: string; status: 'cached' | 'done' | 'failed' | 'skipped'; durationMs: number; key?: string }[] = [];
  dir: string;

  constructor(public readonly command: string, public projectDir?: string, quiet = false) {
    const stamp = this.startedAt.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    this.id = `${stamp}-${command.replace(/[^a-z0-9]+/gi, '-')}`;
    this.dir = path.join(projectDir ? path.join(projectDir, 'reports') : path.join(ROOT, 'reports', 'runs'), this.id);
    this.log = new Logger();
    this.log.quiet = quiet;
  }

  /** Active l'écriture sur disque (seulement pour les commandes qui produisent quelque chose). */
  persist() {
    ensureDir(this.dir);
    this.log.setFile(path.join(this.dir, 'log.jsonl'));
  }

  warn(code: string, message: string, data?: unknown) {
    this.warnings.push({ code, message, data });
    this.log.warn(message, data);
  }
}

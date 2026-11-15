import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './fsx';

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: string;
  level: Level;
  step?: string;
  msg: string;
  data?: unknown;
  durationMs?: number;
}

/**
 * Journal structuré : chaque événement est écrit en JSONL dans le dossier d'exécution,
 * et affiché en clair sur stderr sauf en mode --json (stdout reste réservé au résultat).
 */
export class Logger {
  private file?: string;
  readonly records: LogRecord[] = [];
  quiet = false;

  constructor(file?: string) {
    if (file) this.setFile(file);
  }

  setFile(file: string) {
    ensureDir(path.dirname(file));
    this.file = file;
    for (const r of this.records) fs.appendFileSync(file, JSON.stringify(r) + '\n');
  }

  log(level: Level, msg: string, data?: unknown, step?: string, durationMs?: number) {
    const rec: LogRecord = { ts: new Date().toISOString(), level, msg };
    if (step) rec.step = step;
    if (data !== undefined) rec.data = data;
    if (durationMs !== undefined) rec.durationMs = Math.round(durationMs);
    this.records.push(rec);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
    if (!this.quiet && level !== 'debug') {
      const prefix = level === 'error' ? '✖' : level === 'warn' ? '⚠' : '•';
      process.stderr.write(`${prefix} ${step ? `[${step}] ` : ''}${msg}\n`);
    }
  }

  debug(msg: string, data?: unknown, step?: string) { this.log('debug', msg, data, step); }
  info(msg: string, data?: unknown, step?: string) { this.log('info', msg, data, step); }
  warn(msg: string, data?: unknown, step?: string) { this.log('warn', msg, data, step); }
  error(msg: string, data?: unknown, step?: string) { this.log('error', msg, data, step); }

  async time<T>(step: string, msg: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    this.info(`${msg}…`, undefined, step);
    try {
      const r = await fn();
      this.log('info', `${msg} — terminé`, undefined, step, performance.now() - t0);
      return r;
    } catch (e) {
      this.log('error', `${msg} — échec : ${(e as Error).message}`, undefined, step, performance.now() - t0);
      throw e;
    }
  }
}

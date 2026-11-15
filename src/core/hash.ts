import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NMSVS_HOME } from './paths';

/**
 * JSON canonique : clés triées récursivement, pas d'espaces.
 * Deux objets sémantiquement égaux produisent la même chaîne (base des clés de cache).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortDeep(val);
    }
    return out;
  }
  return v;
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function hashObject(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Clé courte pour les noms de fichiers (chemins courts, collisions négligeables à 24 hex). */
export function shortKey(hex: string): string {
  return hex.slice(0, 24);
}

// Index persistant chemin+taille+mtime → hash, pour éviter de rehacher des fichiers volumineux.
type IndexEntry = { size: number; mtimeMs: number; sha256: string };
let index: Record<string, IndexEntry> | null = null;
const indexPath = () => path.join(NMSVS_HOME, 'hash-index.json');

function loadIndex() {
  if (index) return index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
  } catch {
    index = {};
  }
  return index!;
}

let saveTimer: NodeJS.Timeout | null = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(NMSVS_HOME, { recursive: true });
      const tmp = indexPath() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(index));
      fs.renameSync(tmp, indexPath());
    } catch {
      /* index = optimisation, jamais bloquant */
    }
  }, 200);
  saveTimer.unref?.();
}

export function hashFileSync(file: string): string {
  const st = fs.statSync(file);
  const idx = loadIndex();
  const key = path.resolve(file).toLowerCase();
  const hit = idx[key];
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sha256;
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  const digest = h.digest('hex');
  idx[key] = { size: st.size, mtimeMs: st.mtimeMs, sha256: digest };
  scheduleSave();
  return digest;
}

/** Hash d'un répertoire (contenu des fichiers + chemins relatifs), filtré par extension. */
export function hashDirSync(dir: string, exts: string[]): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.includes(path.extname(e.name))) files.push(p);
    }
  };
  walk(dir);
  files.sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(path.relative(dir, f).split(path.sep).join('/'));
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex');
}

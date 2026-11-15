import fs from 'node:fs';
import path from 'node:path';
import { NmsvsError } from './errors';

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

/** Écriture atomique : fichier temporaire dans le même dossier puis renommage. */
export function writeFileAtomic(file: string, data: string | Buffer) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file: string, value: unknown) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export function readJson<T = unknown>(file: string): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new NmsvsError('E_ASSET_MISSING', `Fichier introuvable : ${file}`, 'Vérifier le chemin ou relancer l’étape qui le produit.');
  }
  try {
    return JSON.parse(raw.replace(/^﻿/, '')) as T;
  } catch (e) {
    throw new NmsvsError('E_SCHEMA', `JSON invalide dans ${file} : ${(e as Error).message}`, 'Corriger la syntaxe JSON.');
  }
}

export function readJsonIfExists<T>(file: string): T | undefined {
  return fs.existsSync(file) ? readJson<T>(file) : undefined;
}

/** Sauvegarde horodatée avant toute réécriture d'un fichier humain. */
export function backupFile(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, bak);
  return bak;
}

export function appendLine(file: string, line: string) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n');
}

export function listFiles(dir: string, filter?: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && (!filter || filter(e.name)))
    .map((e) => path.join(dir, e.name))
    .sort();
}

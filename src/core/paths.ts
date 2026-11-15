import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Racine du dépôt NMSVS (dossier contenant package.json). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Cache global : modèles, bundles Remotion, index de hachage. Chemins courts (R-08). */
export const NMSVS_HOME = process.env.NMSVS_HOME ?? path.join(ROOT, '.nmsvs');

export const PATHS = {
  schemas: path.join(ROOT, 'schemas'),
  presets: path.join(ROOT, 'presets'),
  projects: process.env.NMSVS_PROJECTS ?? path.join(ROOT, 'projects'),
  python: path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
  pythonSrc: path.join(ROOT, 'python'),
  remotionEntry: path.join(ROOT, 'src', 'remotion', 'index.ts'),
  remotionSrc: path.join(ROOT, 'src', 'remotion'),
  models: path.join(NMSVS_HOME, 'models'),
  bundles: path.join(NMSVS_HOME, 'bundles'),
  cache: path.join(NMSVS_HOME, 'cache'),
};

/** Chemin relatif au projet, toujours avec des « / » (portable, stable pour le hachage). */
export function toPosixRel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

export function fromPosixRel(base: string, rel: string): string {
  return path.join(base, ...rel.split('/'));
}

/** Identifiant valide pour projets, scènes, assets… */
export const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item';
}

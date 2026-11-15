import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec';
import { NmsvsError } from './errors';
import { PATHS, ROOT } from './paths';

/** Binaires externes. FFmpeg système (9.x) prioritaire ; surcharge possible par variables d'environnement. */
export const TOOLS = {
  ffmpeg: process.env.NMSVS_FFMPEG ?? 'ffmpeg',
  ffprobe: process.env.NMSVS_FFPROBE ?? 'ffprobe',
  python: process.env.NMSVS_PYTHON ?? PATHS.python,
};

export interface ToolVersions {
  node: string;
  nmsvs: string;
  remotion: string;
  ffmpeg: string;
  python?: string;
}

let cached: ToolVersions | null = null;

export async function toolVersions(): Promise<ToolVersions> {
  if (cached) return cached;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  let ffmpeg = 'absent';
  try {
    const r = await run(TOOLS.ffmpeg, ['-hide_banner', '-version']);
    ffmpeg = r.stdout.split('\n')[0].replace('ffmpeg version ', '').split(' ')[0];
  } catch { /* signalé par doctor */ }
  cached = {
    node: process.version,
    nmsvs: pkg.version,
    remotion: pkg.dependencies?.remotion ?? '?',
    ffmpeg,
  };
  return cached;
}

export async function ffprobeJson(file: string): Promise<any> {
  if (!fs.existsSync(file)) throw new NmsvsError('E_ASSET_MISSING', `Fichier introuvable : ${file}`);
  const r = await run(TOOLS.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
    check: true,
    errorCode: 'E_FFMPEG',
  });
  return JSON.parse(r.stdout);
}

/** Exécute ffmpeg avec options communes (pas de bannière, écrasement autorisé seulement pour des sorties machine). */
export async function ffmpeg(args: string[], onLine?: (l: string) => void) {
  return run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], { check: true, errorCode: 'E_FFMPEG', onStderrLine: onLine });
}

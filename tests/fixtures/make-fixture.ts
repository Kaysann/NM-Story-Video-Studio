// Projet de test synthétique (AUCUN média réel) : audio généré, images générées par FFmpeg, paroles fictives.
// Utilisé par les tests d'intégration et les benchmarks. Ne remplace jamais les médias des POC.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface FixtureOptions {
  durationSec?: number;
  bpm?: number;
  formats?: Record<string, { width: number; height: number; safeZone?: string }>;
  engine?: 'uniform' | 'whisperx' | 'stable-ts';
}

export const FIXTURE_LYRICS = `[Couplet 1]
Sous le phare des collines
Les étoiles se souviennent
[Refrain]
Phare rouge, phare d'or
Chante encore
[Couplet 2]
Le vent porte nos histoires
Jusqu'au bout de la nuit
[Refrain]
Phare rouge, phare d'or
Chante encore
`;

/** WAV PCM 16 bits stéréo : grosse caisse sur les temps, « voix » centrée (sinus vibrato) pendant les phrases, nappe latérale. */
export function synthWav(file: string, durationSec: number, bpm: number, sung: [number, number][]) {
  const sr = 44100;
  const n = Math.round(durationSec * sr);
  const data = Buffer.alloc(n * 4);
  const beat = 60 / bpm;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const tb = t % beat;
    const bar = Math.floor(t / beat) % 4 === 0;
    const kick = Math.exp(-tb * 18) * Math.sin(2 * Math.PI * (bar ? 55 : 90) * tb) * (bar ? 0.6 : 0.35);
    const pad = 0.05 * Math.sin(2 * Math.PI * 220 * t) * Math.sin(2 * Math.PI * 0.25 * t);
    let voice = 0;
    for (const [a, b] of sung) {
      if (t >= a && t < b) {
        const env = Math.min(1, (t - a) * 20, (b - t) * 20);
        const f0 = 330 + 40 * Math.sin(2 * Math.PI * 0.5 * (t - a)) + 6 * Math.sin(2 * Math.PI * 5.5 * t);
        voice = 0.25 * env * (Math.sin(2 * Math.PI * f0 * t) + 0.4 * Math.sin(4 * Math.PI * f0 * t));
      }
    }
    const L = Math.max(-1, Math.min(1, kick + voice + pad));
    const R = Math.max(-1, Math.min(1, kick + voice - pad));
    data.writeInt16LE(Math.round(L * 32767), i * 4);
    data.writeInt16LE(Math.round(R * 32767), i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

function ff(args: string[]) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
}

/** Génère un dossier source (hors projet) : audio, paroles, images, texture. */
export function makeSources(dir: string, o: FixtureOptions = {}) {
  const dur = o.durationSec ?? 24;
  fs.mkdirSync(dir, { recursive: true });
  const sung: [number, number][] = [[2, 4.8], [5.2, 7.8], [8.5, 10.5], [10.8, 12], [13, 15.5], [15.8, 18], [18.5, 20.5], [20.8, 22]];
  synthWav(path.join(dir, 'master.wav'), dur, o.bpm ?? 120, sung.filter(([a]) => a < dur - 1));
  fs.writeFileSync(path.join(dir, 'paroles.txt'), FIXTURE_LYRICS, 'utf8');
  ff(['-f', 'lavfi', '-i', 'mandelbrot=s=1920x1080:maxiter=200', '-frames:v', '1', path.join(dir, 'foret.png')]);
  ff(['-f', 'lavfi', '-i', 'gradients=s=1920x1080:c0=0x203060:c1=0xc08040:c2=0x602030:n=3:seed=7', '-frames:v', '1', path.join(dir, 'chateau.png')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1440x1440', '-frames:v', '1', path.join(dir, 'phare.png')]);
  ff(['-f', 'lavfi', '-i', 'gradients=s=1920x1080:c0=0x103020:c1=0x80a060:n=2:seed=3', '-vf', 'drawbox=x=800:y=300:w=320:h=480:color=0xd0c080@0.9:t=fill', '-frames:v', '1', path.join(dir, 'gardien.png')]);
  ff(['-f', 'lavfi', '-i', 'color=c=0xE3CD9E:s=1024x512', '-vf', 'noise=alls=25:allf=t', '-frames:v', '1', path.join(dir, 'parchemin.png')]);
  return dir;
}

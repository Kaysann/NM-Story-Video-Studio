// Projet de mesure de l'alignement (B3) : voix de synthèse Windows (fr-FR) placée à des instants CONNUS
// sur un fond musical synthétique. Les repères de vérité découlent de la construction (pas d'annotation inventée).
// Limite : parole synthétique ≠ voix chantée ; mesure un plancher d'erreur de la chaîne, pas la précision sur chant.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { synthWav } from '../../tests/fixtures/make-fixture';

export const SPEECH_LYRICS = [
  ['[Couplet 1]', ''],
  ['Sous le phare des collines anciennes', 'verse-1.l1'],
  ['Les étoiles gardent nos secrets', 'verse-1.l2'],
  ['Le chemin s’ouvre sous la neige', 'verse-1.l3'],
  ['Et les tambours répondent au vent', 'verse-1.l4'],
  ['[Refrain]', ''],
  ['Phare rouge, phare d’or', 'chorus-1.l1'],
  ['Chante encore pour les rois', 'chorus-1.l2'],
  ['[Couplet 2]', ''],
  ['La rivière porte les histoires', 'verse-2.l1'],
  ['De ceux qui marchaient avant nous', 'verse-2.l2'],
  ['Mille lumières dans la vallée', 'verse-2.l3'],
  ['Éclairent la route jusqu’à l’aube', 'verse-2.l4'],
  ['[Refrain]', ''],
  ['Phare rouge, phare d’or', 'chorus-2.l1'],
  ['Chante encore pour les rois', 'chorus-2.l2'],
] as const;

const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} : ${r.stderr}`);
  return r;
};

/** Crée les sources dans `dir` et retourne les instants de début de chaque ligne. */
export function makeSpeechSources(dir: string): { starts: Record<string, number>; durationSec: number } {
  fs.mkdirSync(dir, { recursive: true });
  const lines = SPEECH_LYRICS.filter(([, id]) => id);
  const parts: { id: string; file: string; dur: number }[] = [];
  lines.forEach(([text, id], i) => {
    const raw = path.join(dir, `l${i}.raw.wav`);
    const ps = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Hortense Desktop'); $s.Rate=-1; $s.SetOutputToWaveFile('${raw.replace(/'/g, "''")}'); $s.Speak('${text.replace(/'/g, "''").replace(/’/g, "''")}'); $s.Dispose()`;
    run('powershell', ['-NoProfile', '-Command', ps]);
    const trimmed = path.join(dir, `l${i}.wav`);
    // Suppression du silence de tête/queue : le début du fichier = début réel de la voix (seuil -45 dB).
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse', '-ar', '44100', '-ac', '2', trimmed]);
    const dur = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', trimmed]).stdout);
    parts.push({ id, file: trimmed, dur });
  });
  // Placement : 2,5 s d'intro, 1,2 s entre lignes, 3 s entre sections.
  const starts: Record<string, number> = {};
  let t = 2.5;
  let prevSection = '';
  for (const p of parts) {
    const sec = p.id.split('.')[0];
    if (prevSection && sec !== prevSection) t += 1.8;
    prevSection = sec;
    starts[p.id] = Math.round(t * 1000) / 1000;
    t += p.dur + 1.2;
  }
  const durationSec = Math.ceil(t + 3);
  const bed = path.join(dir, 'bed.wav');
  synthWav(bed, durationSec, 96, []); // fond musical sans « voix »
  const inputs = parts.flatMap((p) => ['-i', p.file]);
  const delays = parts.map((p, i) => `[${i + 1}:a]adelay=${Math.round(starts[p.id] * 1000)}|${Math.round(starts[p.id] * 1000)},volume=1.6[v${i}]`).join(';');
  const mix = `[0:a]volume=0.6[b];${delays};[b]${parts.map((_, i) => `[v${i}]`).join('')}amix=inputs=${parts.length + 1}:normalize=0:duration=first,alimiter=limit=0.95[o]`;
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', bed, ...inputs, '-filter_complex', mix, '-map', '[o]', '-c:a', 'pcm_s16le', path.join(dir, 'master.wav')]);
  const txt = SPEECH_LYRICS.map(([t2, id]) => (id ? t2 : t2)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'paroles.txt'), txt, 'utf8');
  fs.writeFileSync(path.join(dir, 'verite.json'), JSON.stringify({ source: 'construction (voix de synthèse placée à des instants connus)', starts }, null, 2));
  for (const f of fs.readdirSync(dir)) if (/^l\d+\.(raw\.)?wav$/.test(f)) fs.rmSync(path.join(dir, f));
  return { starts, durationSec };
}

if (process.argv[1] && process.argv[1].endsWith('make-speech-fixture.ts')) {
  const r = makeSpeechSources(process.argv[2] ?? 'tests/.tmp/speech');
  console.log(JSON.stringify(r, null, 2));
}

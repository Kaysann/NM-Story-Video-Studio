import { NmsvsError } from '../../core/errors';
import type { AudioAnalysis, SyncResolved, TimeAnchor } from '../../model/types';
import { nearest } from '../analysis/analyze';

export interface AnchorContext { sync: SyncResolved; analysis: Pick<AudioAnalysis, 'beats' | 'downbeats' | 'durationSec' | 'tempo'> }

/** Résout une ancre musicale en secondes (avant conversion en images). */
export function resolveAnchor(a: TimeAnchor, ctx: AnchorContext, where = ''): number {
  const { sync, analysis } = ctx;
  let t: number;
  if ('at' in a) t = a.at;
  else if ('end' in a) t = analysis.durationSec;
  else if ('section' in a) {
    const s = sync.sections[a.section];
    if (!s) throw new NmsvsError('E_ANCHOR', `${where} : section « ${a.section} » sans synchronisation.`, 'Lancer `nmsvs sync`.');
    t = a.edge === 'end' ? s.end : s.start;
  } else if ('line' in a) {
    const l = sync.lines.find((x) => x.id === a.line);
    if (!l) throw new NmsvsError('E_ANCHOR', `${where} : ligne « ${a.line} » sans synchronisation.`);
    t = a.edge === 'end' ? l.end : l.start;
  } else if ('word' in a) {
    const w = sync.lines.flatMap((l) => l.words).find((x) => x.id === a.word);
    if (!w) throw new NmsvsError('E_ANCHOR', `${where} : mot « ${a.word} » inconnu.`);
    t = w.start;
  } else if ('beat' in a) {
    if (a.beat >= analysis.beats.length) throw new NmsvsError('E_ANCHOR', `${where} : battement ${a.beat} inexistant (${analysis.beats.length} détectés).`);
    t = analysis.beats[a.beat];
  } else if ('bar' in a) {
    if (a.bar >= analysis.downbeats.length) throw new NmsvsError('E_ANCHOR', `${where} : mesure ${a.bar} inexistante (${analysis.downbeats.length} détectées).`);
    t = analysis.downbeats[a.bar];
  } else throw new NmsvsError('E_ANCHOR', `${where} : ancre invalide.`);
  t += a.offsetSec ?? 0;
  if (a.snap === 'beat') t = nearest(analysis.beats, t, 0.15);
  else if (a.snap === 'downbeat') t = nearest(analysis.downbeats, t, 0.3);
  return Math.max(0, Math.min(analysis.durationSec, t));
}

/** Durée d'une transition en secondes : temps musicaux convertis avec le tempo détecté. */
export function transitionSeconds(d: { beats: number } | { sec: number } | undefined, bpm: number): number {
  if (!d) return 0;
  if ('sec' in d) return d.sec;
  return (d.beats * 60) / (bpm > 0 ? bpm : 120);
}

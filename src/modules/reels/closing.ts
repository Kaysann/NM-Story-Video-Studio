import { NmsvsError } from '../../core/errors';
import type { ReelClosing } from '../../model/types';
import type { RShot, RTimeline, RTransition } from '../../remotion/types';

/**
 * Fermeture d'un Short, ajoutée APRÈS la partie musicale d'une timeline déjà découpée (images 0…D−1 = musique) :
 *  1. paroles et conteneur masqués pendant `lyricsOutSec` (le parchemin s'enroule) ;
 *  2. transition (page tournée à rebours par défaut) du dernier plan vers le 1er plan de la scène `scene` ;
 *  3. tenue `holdSec` sur ce plan, caméra fixe, puis fin (pas de fondu au noir : la vidéo se termine sur l'image).
 * Aucune image de la partie musicale n'est modifiée : le plan prolongé garde son mouvement d'origine (motion.end).
 * `source` : timeline résolue complète (non découpée) où chercher le plan modèle de la scène.
 */
export function appendClosing(t: RTimeline, source: RTimeline, c: ReelClosing): { timeline: RTimeline; musicFrames: number } {
  const fps = t.fps;
  const D = t.durationInFrames;
  const tmpl = source.shots.find((s) => s.sceneId === c.scene);
  if (!tmpl) throw new NmsvsError('E_REELS', `Scène de fermeture inconnue : ${c.scene}`, 'reels.json → params.closing.scene doit désigner une scène de la timeline des Shorts (ex. "sc-couverture").');
  const L = Math.round((c.lyricsOutSec ?? 0.4) * fps);
  const T = Math.max(1, Math.round((c.transition?.duration?.sec ?? 1.2) * fps));
  const H = Math.round((c.holdSec ?? 0.8) * fps);
  const turnFrom = D + L;
  const end = turnFrom + T + H;
  const tr: RTransition = { type: c.transition?.type ?? 'page-turn', frames: T, direction: c.transition?.direction ?? 'right', color: tmpl.enter?.color ?? '#F0B429' };

  // Plan visible à la dernière image de musique : le plus haut des plans actifs.
  const active = t.shots.filter((s) => s.from <= D - 1 && s.to > D - 1);
  if (!active.length) throw new NmsvsError('E_INTERNAL', 'Aucun plan à la fin de la partie musicale.');
  const top = active.reduce((a, s) => (s.z > a.z ? s : a));
  const shots: RShot[] = t.shots.map((s) => {
    if (s === top) return { ...s, to: turnFrom + T, exit: tr, motion: { ...s.motion, end: s.motion.end ?? s.to - 1 } };
    // Autres plans encore actifs (ex. fin de transition) : arrêtés à la fin de la musique.
    return s.to > D ? { ...s, to: Math.max(s.from + 1, D), motion: { ...s.motion, end: s.motion.end ?? s.to - 1 } } : s;
  });
  const z = Math.max(...t.shots.map((s) => s.z)) + 1;
  shots.push({ ...tmpl, id: `${tmpl.id}-fermeture`, from: turnFrom, to: end, enter: tr, exit: undefined, z,
    motion: { from: tmpl.motion.from, to: tmpl.motion.from, easing: 'linear' } });

  // Paroles : jusqu'à la fin de la musique, puis enroulement du conteneur pendant L images.
  const lyrics = t.lyrics.filter((l) => l.from < D).map((l) => {
    const groupTo = Math.min(l.groupTo, turnFrom);
    return { ...l, groupTo, to: Math.max(l.from + 1, Math.min(l.to, groupTo)) };
  });
  return {
    timeline: {
      ...t, durationInFrames: end, shots, lyrics, titles: t.titles.filter((x) => x.from < D), fades: t.fades.filter((f) => f.to <= D),
      ...(t.sprites ? { sprites: t.sprites.filter((s) => s.from < D).map((s) => ({ ...s, to: Math.min(s.to, D) })) } : {}),
    },
    musicFrames: D,
  };
}

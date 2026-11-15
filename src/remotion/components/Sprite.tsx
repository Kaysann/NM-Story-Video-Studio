import React from 'react';
import { Img } from 'remotion';
import type { RSprite, RTimeline } from '../types';
import { clamp01 } from '../anim';

/** Pose affichée et position du point d'appui (bas-centre) d'un sprite à l'image `frame`. Fonction pure. */
export function spriteAt(s: RSprite, frame: number, fps: number): { pose: number; x: number; y: number; opacity: number } {
  const n = Math.max(1, s.to - s.from - 1);
  // Vitesse constante : une marche n'accélère pas (pas d'easing).
  const p = clamp01((frame - s.from) / n);
  const pose = Math.floor(((frame - s.from) * s.poseFps) / fps) % s.frames.length;
  const f = Math.max(1, s.fadeFrames);
  const opacity = s.fadeFrames > 0 ? Math.min(clamp01((frame - s.from + 1) / f), clamp01((s.to - frame) / f)) : 1;
  return { pose, x: s.path.from.x + (s.path.to.x - s.path.from.x) * p, y: s.path.from.y + (s.path.to.y - s.path.from.y) * p, opacity };
}

/**
 * Personnages animés : PNG transparents affichés tels quels (hauteur imposée, largeur proportionnelle).
 * Toutes les poses sont montées (une seule visible) pour qu'aucune ne soit chargée en cours de rendu.
 */
export const SpriteLayer: React.FC<{ t: RTimeline; frame: number }> = ({ t, frame }) => {
  const active = (t.sprites ?? []).filter((s) => frame >= s.from && frame < s.to).sort((a, b) => a.z - b.z);
  return (
    <>
      {active.map((s) => {
        const st = spriteAt(s, frame, t.fps);
        return (
          <div key={s.id} style={{ position: 'absolute', left: st.x, top: st.y - s.height, height: s.height, transform: 'translateX(-50%)', opacity: st.opacity }}>
            {s.frames.map((src, i) => (
              <Img key={i} src={`${t.assetBaseUrl}/${src}`} style={{ position: i === st.pose ? 'relative' : 'absolute', top: 0, left: 0, height: s.height, width: 'auto', visibility: i === st.pose ? 'visible' : 'hidden' }} />
            ))}
          </div>
        );
      })}
    </>
  );
};

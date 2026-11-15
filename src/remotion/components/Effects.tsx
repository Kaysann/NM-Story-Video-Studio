import React from 'react';
import { AbsoluteFill } from 'remotion';
import type { RTimeline } from '../types';
import { fadeOpacity } from '../anim';

/** Vignettage et grain (grain déterministe : graine = numéro d'image). */
export const Effects: React.FC<{ t: RTimeline; frame: number }> = ({ t, frame }) => {
  const fx = t.effectRanges?.find((r) => frame >= r.from && frame < r.to) ?? t.effects;
  return (
  <>
    {fx.vignette > 0 ? (
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,${(0.85 * fx.vignette).toFixed(3)}) 100%)` }} />
    ) : null}
    {fx.grain > 0 ? (
      <AbsoluteFill style={{ opacity: 0.35 * fx.grain, mixBlendMode: 'overlay' }}>
        <svg width="100%" height="100%">
          <filter id={`g${frame}`}>
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} seed={frame % 997} />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter={`url(#g${frame})`} />
        </svg>
      </AbsoluteFill>
    ) : null}
  </>
  );
};

/** Calques de couleur des fondus au noir et des passages par une couleur. */
export const FadeLayer: React.FC<{ t: RTimeline; frame: number }> = ({ t, frame }) => (
  <>
    {t.fades.map((f, i) => {
      const o = fadeOpacity(f, frame);
      return o > 0 ? <AbsoluteFill key={i} style={{ backgroundColor: f.color, opacity: o }} /> : null;
    })}
  </>
);

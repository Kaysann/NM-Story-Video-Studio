import React from 'react';
import type { RTimeline } from '../types';
import { ramp } from '../anim';
import { ParchmentPanel } from './Parchment';

/** Titres (carton d'ouverture, titre de Reel) : texte simple ou sur parchemin. */
export const TitleLayer: React.FC<{ t: RTimeline; frame: number }> = ({ t, frame }) => (
  <>
    {t.titles.filter((x) => frame >= x.from && frame < x.to).map((x) => {
      const o = ramp(frame, x.from, x.to, 12, 12);
      const text = (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
          fontFamily: `"${x.fontFamily}", Georgia, serif`, fontSize: x.fontSize, color: x.color, padding: x.fontSize * 0.3,
          textShadow: x.type === 'plain' ? `0 ${x.fontSize * 0.04}px ${x.fontSize * 0.2}px rgba(0,0,0,0.8)` : undefined }}>
          {x.text}
        </div>
      );
      if (x.type === 'parchment') {
        return (
          <ParchmentPanel key={x.id} box={x.box} frame={frame} from={x.from} to={x.to} unrollFrames={Math.round(t.fps * 0.9)} orientation="horizontal"
            textureUrl={x.parchmentSrc ? `${t.assetBaseUrl}/${x.parchmentSrc}` : null} float={0.003} H={t.height} fps={t.fps}>
            {text}
          </ParchmentPanel>
        );
      }
      return <div key={x.id} style={{ position: 'absolute', left: x.box.x, top: x.box.y, width: x.box.w, height: x.box.h, opacity: o }}>{text}</div>;
    })}
  </>
);

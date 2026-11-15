import React, { useEffect, useState } from 'react';
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame } from 'remotion';
import type { RTimeline } from './types';
import { ShotLayer } from './components/Shot';
import { LyricsLayer } from './components/Lyrics';
import { TitleLayer } from './components/Title';
import { Effects, FadeLayer } from './components/Effects';
import { SafeOverlay } from './components/SafeOverlay';
import { SpriteLayer } from './components/Sprite';
import { layerOrder } from './anim';

/** Charge les polices déclarées par la timeline avant le premier rendu (aucune police réseau). */
function useFonts(t: RTimeline) {
  const [handle] = useState(() => (t.fonts.length ? delayRender('polices') : null));
  useEffect(() => {
    if (handle === null) return;
    Promise.all(
      t.fonts.map(async (f) => {
        const face = new FontFace(f.family, `url("${t.assetBaseUrl}/${f.src}")`);
        await face.load();
        (document.fonts as unknown as { add: (f: FontFace) => void }).add(face);
      }),
    )
      .catch((e) => console.error('Police non chargée', e))
      .finally(() => continueRender(handle));
  }, [handle, t]);
}

export const Main: React.FC<RTimeline> = (t) => {
  useFonts(t);
  const frame = useCurrentFrame();
  const shots = t.shots.filter((s) => frame >= s.from && frame < s.to).sort((a, b) => layerOrder(a, frame) - layerOrder(b, frame));
  return (
    <AbsoluteFill style={{ backgroundColor: '#000', overflow: 'hidden' }}>
      {shots.map((s) => (
        <ShotLayer key={s.id} shot={s} frame={frame} t={t} />
      ))}
      <SpriteLayer t={t} frame={frame} />
      <Effects t={t} frame={frame} />
      <FadeLayer t={t} frame={frame} />
      <LyricsLayer t={t} frame={frame} />
      <TitleLayer t={t} frame={frame} />
      {t.showSafe ? <SafeOverlay t={t} /> : null}
    </AbsoluteFill>
  );
};

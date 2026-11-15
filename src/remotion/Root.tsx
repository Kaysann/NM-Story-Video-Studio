import React from 'react';
import { Composition } from 'remotion';
import { Main } from './Main';
import type { RTimeline } from './types';

// Timeline vide par défaut : Studio et rendu reçoivent toujours la timeline résolue en props.
const EMPTY: RTimeline = {
  version: 1, format: '16x9', width: 1920, height: 1080, fps: 30, durationInFrames: 30, assetBaseUrl: '',
  safe: { title: { x: 0, y: 0, w: 1920, h: 1080 }, action: { x: 0, y: 0, w: 1920, h: 1080 } },
  shots: [], lyrics: [], titles: [], fades: [], effects: { vignette: 0, grain: 0 }, fonts: [],
};

export const Root: React.FC = () => (
  <Composition
    id="Main"
    component={Main as unknown as React.FC<Record<string, unknown>>}
    defaultProps={EMPTY as unknown as Record<string, unknown>}
    durationInFrames={30}
    fps={30}
    width={1920}
    height={1080}
    calculateMetadata={({ props }) => {
      const t = props as unknown as RTimeline;
      return { durationInFrames: t.durationInFrames, fps: t.fps, width: t.width, height: t.height };
    }}
  />
);

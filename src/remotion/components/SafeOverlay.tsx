import React from 'react';
import { AbsoluteFill } from 'remotion';
import type { RRect, RTimeline } from '../types';

const box = (r: RRect, color: string, label: string, H: number) => (
  <div style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, border: `${Math.max(2, H / 400)}px dashed ${color}`, boxSizing: 'border-box' }}>
    <span style={{ position: 'absolute', top: 4, left: 8, color, fontFamily: 'sans-serif', fontSize: H / 50 }}>{label}</span>
  </div>
);

/** Superposition de contrôle des zones de sécurité (jamais présente dans un export final). */
export const SafeOverlay: React.FC<{ t: RTimeline }> = ({ t }) => (
  <AbsoluteFill>
    {box(t.safe.action, '#ff4d4d', 'action safe', t.height)}
    {box(t.safe.title, '#ffd84d', 'title safe', t.height)}
  </AbsoluteFill>
);

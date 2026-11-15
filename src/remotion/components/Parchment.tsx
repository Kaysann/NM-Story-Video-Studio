import React from 'react';
import { Img } from 'remotion';
import type { RRect } from '../types';
import { clamp01, ease } from '../anim';

/**
 * Bandeau de parchemin fourni (PNG transparent) : dessiné tel quel, proportions conservées, sans ombre ni rouleaux
 * (les enroulements font partie de l'illustration). Apparition par déroulé horizontal depuis le centre.
 */
export const TexturedParchment: React.FC<{ rect: RRect; k: number; dy: number; src: string }> = ({ rect, k, dy, src }) => {
  const hidden = ((1 - k) * 50).toFixed(3);
  return (
    <Img src={src} style={{
      position: 'absolute', left: rect.x, top: rect.y + dy, width: rect.w, height: rect.h,
      clipPath: `inset(0 ${hidden}% 0 ${hidden}%)`, opacity: clamp01(k * 1.5),
    }} />
  );
};

/**
 * Parchemin : panneau qui se déroule depuis le centre (deux rouleaux qui s'écartent),
 * reste affiché en flottant légèrement, puis s'enroule en fin de groupe.
 * Texture fournie par l'utilisateur, sinon texture procédurale (dégradés + bruit SVG).
 */
export const ParchmentPanel: React.FC<{
  box: RRect; frame: number; from: number; to: number; unrollFrames: number; orientation: 'horizontal' | 'vertical';
  textureUrl: string | null; float: number; H: number; fps: number; children?: React.ReactNode;
}> = ({ box, frame, from, to, unrollFrames, orientation, textureUrl, float, H, fps, children }) => {
  const n = Math.max(1, unrollFrames);
  const open = ease('inOutCubic', clamp01((frame - from + 1) / n));
  const close = ease('inOutCubic', clamp01((to - frame) / Math.max(1, Math.round(n * 0.7))));
  const k = Math.min(open, close); // 0 = enroulé, 1 = ouvert
  const horiz = orientation === 'horizontal';
  const hidden = ((1 - k) * 50).toFixed(3);
  const clip = horiz ? `inset(0 ${hidden}% 0 ${hidden}%)` : `inset(${hidden}% 0 ${hidden}% 0)`;
  const dy = Math.sin(((frame - from) / fps) * Math.PI * 0.8) * float * H;
  const roller = Math.max(6, (horiz ? box.h : box.w) * 0.09);
  const bg = textureUrl
    ? { backgroundImage: `url("${textureUrl}")`, backgroundSize: '100% 100%' }
    : { background: 'radial-gradient(ellipse at 50% 45%, #F1E3C2 0%, #E3CD9E 60%, #C9AD76 100%)' };
  const rollerStyle = (pos: 'a' | 'b'): React.CSSProperties => {
    const offset = `${(50 - k * 50).toFixed(3)}%`;
    const common: React.CSSProperties = { position: 'absolute', borderRadius: roller / 2, background: 'linear-gradient(90deg,#6B4A2B,#B98F5E 45%,#6B4A2B)', boxShadow: '0 0 8px rgba(0,0,0,0.5)' };
    return horiz
      ? { ...common, top: -roller * 0.25, height: box.h + roller * 0.5, width: roller, [pos === 'a' ? 'left' : 'right']: `calc(${offset} - ${roller / 2}px)` }
      : { ...common, left: -roller * 0.25, width: box.w + roller * 0.5, height: roller, [pos === 'a' ? 'top' : 'bottom']: `calc(${offset} - ${roller / 2}px)`, background: 'linear-gradient(180deg,#6B4A2B,#B98F5E 45%,#6B4A2B)' };
  };
  if (k <= 0) return null;
  return (
    <div style={{ position: 'absolute', left: box.x, top: box.y + dy, width: box.w, height: box.h }}>
      <div style={{ position: 'absolute', inset: 0, clipPath: clip, ...bg, boxShadow: 'inset 0 0 40px rgba(90,60,20,0.55), 0 6px 24px rgba(0,0,0,0.45)', borderRadius: 4 }}>
        {!textureUrl ? (
          <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.25, mixBlendMode: 'multiply' }}>
            <filter id="parch"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.04" numOctaves={4} seed={7} /><feColorMatrix type="matrix" values="0 0 0 0 0.45  0 0 0 0 0.32  0 0 0 0 0.15  0 0 0 1.2 -0.2" /></filter>
            <rect width="100%" height="100%" filter="url(#parch)" />
          </svg>
        ) : null}
        <div style={{ position: 'absolute', inset: 0, opacity: clamp01((k - 0.6) / 0.4) }}>{children}</div>
      </div>
      {k < 1 ? (<><div style={rollerStyle('a')} /><div style={rollerStyle('b')} /></>) : null}
    </div>
  );
};

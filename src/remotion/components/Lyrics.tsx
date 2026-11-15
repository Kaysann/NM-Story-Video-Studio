import React from 'react';
import type { RLyric, RTimeline } from '../types';
import { clamp01, ramp, scrollState, texturedParchmentState } from '../anim';
import { ParchmentPanel, TexturedParchment } from './Parchment';

const IN = 8; // images d'apparition
const OUT = 6; // images de disparition

/** Toutes les paroles : un conteneur par groupe (cartouche / parchemin) puis les lignes actives. */
export const LyricsLayer: React.FC<{ t: RTimeline; frame: number }> = ({ t, frame }) => {
  const groups = new Map<string, RLyric[]>();
  for (const l of t.lyrics) {
    if (frame < l.groupFrom || frame >= l.groupTo) continue;
    const g = groups.get(l.groupId) ?? [];
    g.push(l);
    groups.set(l.groupId, g);
  }
  return (
    <>
      {[...groups.entries()].map(([gid, lines]) => {
        const first = lines[0];
        const visible = lines.filter((l) => frame >= l.from && frame < l.to);
        const content = visible.map((l) => <LyricLine key={l.id} l={l} frame={frame} t={t} />);
        if (first.style.type === 'cartouche') return <Cartouche key={gid} l={first} frame={frame} t={t}>{content}</Cartouche>;
        if (first.style.type === 'parchment' && first.panelBox && first.style.parchment.textureSrc) {
          // Bandeau fourni : texture et texte sur deux calques indépendants (aucun texte incrusté dans l'image).
          const p = first.style.parchment;
          const st = texturedParchmentState(frame, first.groupFrom, first.groupTo, p.unrollFrames, p.float, t.height, t.fps);
          if (st.k <= 0) return null;
          return (
            <React.Fragment key={gid}>
              <TexturedParchment rect={first.panelBox} k={st.k} dy={st.dy} src={`${t.assetBaseUrl}/${p.textureSrc}`} />
              <div style={{ position: 'absolute', inset: 0, transform: `translateY(${st.dy}px)`, opacity: st.text }}>{content}</div>
            </React.Fragment>
          );
        }
        if (first.style.type === 'parchment') {
          const p = first.style.parchment;
          return (
            <ParchmentPanel key={gid} box={first.groupBox} frame={frame} from={first.groupFrom} to={first.groupTo} unrollFrames={p.unrollFrames}
              orientation={p.orientation} textureUrl={p.textureSrc ? `${t.assetBaseUrl}/${p.textureSrc}` : null} float={p.float} H={t.height} fps={t.fps}>
              <div style={{ position: 'absolute', left: -first.groupBox.x, top: -first.groupBox.y, width: t.width, height: t.height }}>{content}</div>
            </ParchmentPanel>
          );
        }
        return <React.Fragment key={gid}>{content}</React.Fragment>;
      })}
    </>
  );
};

const Cartouche: React.FC<{ l: RLyric; frame: number; t: RTimeline; children: React.ReactNode }> = ({ l, frame, t, children }) => {
  const p = l.style.panel;
  const o = ramp(frame, l.groupFrom, l.groupTo, IN, OUT);
  const hex = p.color.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const box = l.groupBox;
  return (
    <>
      <div style={{
        position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, opacity: o,
        transform: `scale(${0.96 + 0.04 * o})`, borderRadius: p.radius * t.height,
        backgroundColor: `rgba(${r},${g},${b},${p.opacity})`,
        backdropFilter: p.blur ? `blur(${((p.blur * t.height) / 1080).toFixed(1)}px)` : undefined,
        border: p.border ? `${Math.max(1, t.height / 540)}px solid ${p.border}` : undefined,
      }} />
      {children}
    </>
  );
};

/** Une ligne : rendu du texte, mise en évidence karaoké (mot ou ligne), apparition. */
const LyricLine: React.FC<{ l: RLyric; frame: number; t: RTimeline }> = ({ l, frame, t }) => {
  const s = l.style;
  // Défilement : l'opacité et la position suivent scrollState (apparition en fondu, sortie gérée par le défilement).
  const sc = l.scroll ? scrollState(l.scroll, frame) : null;
  const o = sc ? Math.min(clamp01((frame - l.from + 1) / IN), l.scroll!.last ? ramp(frame, l.from, l.to, IN, OUT) : 1) * sc.opacity : ramp(frame, l.from, l.to, IN, OUT);
  const rise = (s.enter === 'rise' && !sc ? (1 - clamp01((frame - l.from + 1) / IN)) * l.fontSize * 0.4 : 0) + (sc?.dy ?? 0);
  const shadow = s.shadow ? `0 ${(l.fontSize * 0.05).toFixed(1)}px ${(l.fontSize * 0.18).toFixed(1)}px ${s.shadowColor}` : undefined;
  const stroke = s.stroke > 0 ? `${(s.stroke * l.fontSize).toFixed(2)}px ${s.shadowColor}` : undefined;
  const base: React.CSSProperties = {
    fontFamily: `"${s.fontFamily}", Georgia, serif`, fontWeight: s.weight, fontSize: l.fontSize, lineHeight: `${l.lineHeight}px`,
    color: s.color, textShadow: shadow, WebkitTextStroke: stroke, paintOrder: 'stroke fill', whiteSpace: 'pre',
  };
  return (
    <div style={{ position: 'absolute', left: l.box.x, top: l.box.y + rise, width: l.box.w, height: l.box.h, opacity: o, textAlign: s.align, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      {s.scrim && s.type === 'text-on-image' ? (
        <div style={{ position: 'absolute', left: -l.fontSize, right: -l.fontSize, top: -l.fontSize * 0.6, bottom: -l.fontSize * 0.6, background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0) 72%)' }} />
      ) : null}
      {l.lines.map((_, li) => (
        <div key={li} style={{ ...base, position: 'relative' }}>
          {l.words.filter((w) => w.line === li).map((w, wi) => (
            <Word key={wi} w={w} frame={frame} l={l} base={base} />
          ))}
        </div>
      ))}
    </div>
  );
};

const Word: React.FC<{ w: RLyric['words'][number]; frame: number; l: RLyric; base: React.CSSProperties }> = ({ w, frame, l, base }) => {
  const s = l.style;
  const reveal = s.enter === 'reveal' ? clamp01((frame - (w.from - s.leadFrames) + 1) / 6) : 1;
  let fill = 0;
  if (s.karaoke === 'word') fill = w.to > w.from ? clamp01((frame - w.from) / (w.to - w.from)) : frame >= w.from ? 1 : 0;
  else if (s.karaoke === 'line') fill = frame >= l.words[0].from ? 1 : 0;
  const text = `${w.text} `;
  return (
    <span style={{ position: 'relative', opacity: reveal, filter: reveal < 1 ? `blur(${((1 - reveal) * 3).toFixed(2)}px)` : undefined }}>
      {text}
      {fill > 0 ? (
        <span aria-hidden style={{ ...base, position: 'absolute', left: 0, top: 0, color: s.accent, clipPath: `inset(0 ${((1 - fill) * 100).toFixed(2)}% 0 0)` }}>{text}</span>
      ) : null}
    </span>
  );
};

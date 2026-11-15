import React from 'react';
import { AbsoluteFill, Img } from 'remotion';
import type { RShot, RTimeline } from '../types';
import { cameraAt, placeImage, shotTransitionAt, type PageTurnStyle } from '../anim';

/** Un plan : illustration animée par la caméra virtuelle, avec effets d'entrée/sortie de transition. */
export const ShotLayer: React.FC<{ shot: RShot; frame: number; t: RTimeline }> = ({ shot, frame, t }) => {
  const W = t.width;
  const H = t.height;
  const cam = cameraAt(shot, frame);
  const tr = shotTransitionAt(shot, frame);
  const url = `${t.assetBaseUrl}/${shot.src}`;
  const mode = shot.fit === 'cover' ? 'cover' : 'contain';
  const p = placeImage(shot.srcW, shot.srcH, W, H, cam, mode);
  const pg = tr.page?.part === 'page' ? tr.page : undefined;
  const wrap: React.CSSProperties = {
    opacity: tr.opacity,
    // Page tournée : pivot 3D sur la reliure (perspective appliquée à l'élément lui-même).
    transform: `${pg ? `perspective(${pg.perspective * W}px) rotateY(${pg.rotateY.toFixed(3)}deg) ` : ''}translate(${tr.translateX * W}px, ${tr.translateY * H}px) scale(${tr.scale})`,
    transformOrigin: pg ? `${pg.spine} center` : undefined,
    backfaceVisibility: pg ? 'hidden' : undefined,
    filter: tr.blur ? `blur(${(tr.blur * H).toFixed(2)}px)` : undefined,
    clipPath: tr.clipPath,
    overflow: 'hidden',
  };
  return (
    <AbsoluteFill style={wrap}>
      {shot.fit === 'blurFill' ? <BlurBackground url={url} shot={shot} W={W} H={H} /> : null}
      <Img src={url} style={{ position: 'absolute', left: p.left, top: p.top, width: p.width, height: p.height }} />
      {shot.foreground ? <Foreground shot={shot} cam={cam} W={W} H={H} base={t.assetBaseUrl} /> : null}
      {tr.page ? <PageShading page={tr.page} /> : null}
    </AbsoluteFill>
  );
};

/**
 * Ombres de la page tournée. Page qui pivote : dégradé plus sombre vers le bord libre.
 * Page du dessous : occlusion uniforme + ombre portée qui s'estompe au-delà du bord libre projeté.
 */
const PageShading: React.FC<{ page: PageTurnStyle }> = ({ page }) => {
  const dir = page.spine === 'left' ? 'to right' : 'to left';
  const a = (v: number) => `rgba(0,0,0,${Math.max(0, Math.min(1, v)).toFixed(4)})`;
  if (page.part === 'page') {
    return <AbsoluteFill style={{ background: `linear-gradient(${dir}, ${a(page.shade * 0.3)} 0%, ${a(page.shade)} 100%)` }} />;
  }
  const e = Math.max(0, Math.min(100, page.shadowEdge * 100));
  return (
    <>
      <AbsoluteFill style={{ backgroundColor: a(page.shade) }} />
      <AbsoluteFill style={{ background: `linear-gradient(${dir}, ${a(page.shadow)} ${e.toFixed(3)}%, ${a(0)} ${Math.min(100, e + 22).toFixed(3)}%)` }} />
    </>
  );
};

const BlurBackground: React.FC<{ url: string; shot: RShot; W: number; H: number }> = ({ url, shot, W, H }) => {
  const p = placeImage(shot.srcW, shot.srcH, W, H, { scale: 1.1, x: 0.5, y: 0.5 }, 'cover');
  return <Img src={url} style={{ position: 'absolute', left: p.left, top: p.top, width: p.width, height: p.height, filter: `blur(${Math.round(H * 0.03)}px) brightness(0.6)` }} />;
};

/** Parallaxe : le premier plan (calque détouré fourni) se déplace davantage que le fond. */
const Foreground: React.FC<{ shot: RShot; cam: { scale: number; x: number; y: number }; W: number; H: number; base: string }> = ({ shot, cam, W, H, base }) => {
  const fg = shot.foreground!;
  const p = placeImage(fg.srcW, fg.srcH, W, H, cam, 'cover');
  const extra = (cam.x - 0.5) * fg.depth * W;
  return <Img src={`${base}/${fg.src}`} style={{ position: 'absolute', left: p.left - extra, top: p.top, width: p.width, height: p.height }} />;
};

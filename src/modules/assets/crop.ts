import type { ImageAsset, Rect } from '../../model/types';

export interface PixelRect { x: number; y: number; w: number; h: number }

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * Zone source d'une image pour un format, selon la priorité du cadrage :
 *   1. crops[format] (rectangle explicite, normalisé) ;
 *   2. point focal : plus grand rectangle au ratio du format, centré sur le point focal, borné à l'image ;
 *   3. centre de l'image.
 * (Le remplacement par une autre image est résolu en amont : voir resolveImageForFormat.)
 * Pour fit = contain / blurFill, l'image entière est conservée.
 */
/** Ajustement effectif d'une image pour un format : `fits[format]` > `fit` > cover. */
export function fitFor(img: Pick<ImageAsset, 'fit' | 'fits'>, format: string): 'cover' | 'contain' | 'blurFill' {
  return img.fits?.[format] ?? img.fit ?? 'cover';
}

export function sourceRegion(img: Pick<ImageAsset, 'crops' | 'focal' | 'fit' | 'fits'> & { size: { w: number; h: number } }, format: string, frame: { width: number; height: number }): { region: PixelRect; rule: 'crop' | 'focal' | 'center' | 'full' } {
  const { w, h } = img.size;
  const fit = fitFor(img, format);
  if (fit === 'contain' || fit === 'blurFill') return { region: { x: 0, y: 0, w, h }, rule: 'full' };
  const crop: Rect | undefined = img.crops?.[format];
  if (crop) {
    const px = { x: Math.round(crop.x * w), y: Math.round(crop.y * h), w: Math.round(crop.w * w), h: Math.round(crop.h * h) };
    px.w = Math.min(px.w, w - px.x);
    px.h = Math.min(px.h, h - px.y);
    return { region: even(px), rule: 'crop' };
  }
  const target = frame.width / frame.height;
  let rw = w;
  let rh = Math.round(w / target);
  if (rh > h) {
    rh = h;
    rw = Math.round(h * target);
  }
  const f = img.focal ?? { x: 0.5, y: 0.5 };
  const cx = clamp(f.x * w - rw / 2, 0, w - rw);
  const cy = clamp(f.y * h - rh / 2, 0, h - rh);
  return { region: even({ x: Math.round(cx), y: Math.round(cy), w: rw, h: rh }), rule: img.focal && (f.x !== 0.5 || f.y !== 0.5) ? 'focal' : 'center' };
}

function even(r: PixelRect): PixelRect {
  return { x: r.x, y: r.y, w: Math.max(2, r.w - (r.w % 2)), h: Math.max(2, r.h - (r.h % 2)) };
}

/** Image effectivement utilisée pour un format (remplacement éventuel). */
export function resolveImageForFormat(images: ImageAsset[], id: string, format: string): ImageAsset {
  const img = images.find((i) => i.id === id);
  if (!img) throw new Error(`Image inconnue : ${id}`);
  const rep = img.replace?.[format];
  if (rep) {
    const r = images.find((i) => i.id === rep);
    if (!r) throw new Error(`Image de remplacement inconnue : ${rep}`);
    return r;
  }
  return img;
}

/** Part du sujet (safeSubject) coupée par la zone source (0 = entier, 1 = invisible). */
export function subjectCutRatio(img: Pick<ImageAsset, 'safeSubject'> & { size: { w: number; h: number } }, region: PixelRect): number {
  const s = img.safeSubject;
  if (!s) return 0;
  const sx = s.x * img.size.w, sy = s.y * img.size.h, sw = s.w * img.size.w, sh = s.h * img.size.h;
  const ix = Math.max(0, Math.min(sx + sw, region.x + region.w) - Math.max(sx, region.x));
  const iy = Math.max(0, Math.min(sy + sh, region.y + region.h) - Math.max(sy, region.y));
  return 1 - (ix * iy) / (sw * sh);
}

/** Taille du dérivé : cadre × marge de mouvement, au ratio de la zone source pour contain/blurFill. */
export function derivativeSize(region: PixelRect, frame: { width: number; height: number }, margin: number, fit: string): { w: number; h: number; upscale: number } {
  let w: number, h: number;
  if (fit === 'contain' || fit === 'blurFill') {
    const k = Math.min(frame.width / region.w, frame.height / region.h) * margin;
    w = region.w * k;
    h = region.h * k;
  } else {
    w = frame.width * margin;
    h = frame.height * margin;
  }
  w = Math.round(w / 2) * 2;
  h = Math.round(h / 2) * 2;
  return { w, h, upscale: Math.max(w / region.w, h / region.h) };
}

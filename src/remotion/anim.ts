// Fonctions d'animation pures (aucune dépendance au navigateur) : testables sous Node.
import type { RCamera, REasing, RShot, RTransition } from './types';

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function ease(kind: REasing, t: number): number {
  const x = clamp01(t);
  switch (kind) {
    case 'linear': return x;
    case 'inOutSine': return -(Math.cos(Math.PI * x) - 1) / 2;
    case 'inOutQuad': return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case 'inOutCubic': return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case 'outExpo': return x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
  }
}

/** Caméra virtuelle d'un plan à l'image `frame` (mouvement + micro-pulsations sur temps forts). */
export function cameraAt(shot: RShot, frame: number): RCamera {
  // Préambule : le mouvement commence à motion.start (caméra figée avant) et garde sa durée d'origine.
  const start = shot.motion.start ?? shot.from;
  const len = Math.max(1, (shot.motion.end ?? shot.to - 1) - start);
  const t = ease(shot.motion.easing, Math.min(1, (frame - start) / len));
  let scale = lerp(shot.motion.from.scale, shot.motion.to.scale, t);
  if (shot.motion.pulseFrames?.length && shot.motion.pulseIntensity) {
    for (const pf of shot.motion.pulseFrames) {
      const d = frame - pf;
      if (d >= 0 && d < 15) scale += shot.motion.pulseIntensity * Math.exp(-d / 4);
    }
  }
  return { scale, x: lerp(shot.motion.from.x, shot.motion.to.x, t), y: lerp(shot.motion.from.y, shot.motion.to.y, t) };
}

/**
 * Placement de l'image du plan dans le cadre (pixels) pour une caméra donnée.
 * La caméra (x, y) ∈ [0,1] choisit la position dans la marge disponible : 0,5 = centré.
 */
export function placeImage(srcW: number, srcH: number, W: number, H: number, cam: RCamera, mode: 'cover' | 'contain') {
  const k0 = mode === 'cover' ? Math.max(W / srcW, H / srcH) : Math.min(W / srcW, H / srcH);
  const w = srcW * k0 * cam.scale;
  const h = srcH * k0 * cam.scale;
  const left = w > W ? -(w - W) * clamp01(cam.x) : (W - w) / 2;
  const top = h > H ? -(h - H) * clamp01(cam.y) : (H - h) / 2;
  return { left, top, width: w, height: h };
}

/**
 * Page tournée : `page` = page sortante qui pivote sur sa reliure ; `under` = page entrante, dessous.
 * - rotateY en degrés (signe déjà appliqué), perspective en multiples de la largeur du cadre ;
 * - shade ∈ [0,1] : assombrissement (dégradé reliure → bord libre pour la page, uniforme dessous) ;
 * - shadowEdge : position projetée du bord libre (fraction de la largeur depuis la reliure),
 *   à partir de laquelle l'ombre portée s'estompe sur la page du dessous.
 */
export interface PageTurnStyle { part: 'page' | 'under'; spine: 'left' | 'right'; rotateY: number; perspective: number; shade: number; shadow: number; shadowEdge: number }

export interface TStyle { opacity: number; translateX: number; translateY: number; scale: number; blur: number; clipPath?: string; page?: PageTurnStyle }
export const IDENTITY: TStyle = { opacity: 1, translateX: 0, translateY: 0, scale: 1, blur: 0 };

/** Distance de la caméra pour la page tournée (× largeur) : 4 = relief visible, grossissement transitoire ≤ 3,3 % (3 rognait les bords). */
export const PAGE_PERSPECTIVE = 4;

/**
 * Géométrie de la page tournée à l'avancement q ∈ [0,1].
 * La page se soulève vers le spectateur en pivotant sur la reliure (0° → 90°, chant de la page à la fin) ;
 * au-delà de 90° la page passerait derrière la reliure, hors cadre : l'effet s'arrête donc à 90°.
 * Bord libre projeté : x = cos θ · P / (P − sin θ) (projection perspective d'un point à profondeur sin θ).
 */
export function pageTurnAt(q: number, spine: 'left' | 'right' = 'left'): { angle: number; edge: number; shade: number; shadow: number; under: number } {
  const p = ease('inOutSine', q);
  const theta = (p * Math.PI) / 2;
  const P = PAGE_PERSPECTIVE;
  return {
    // Reliure à gauche : rotation négative (le bord droit vient vers le spectateur), et inversement.
    angle: (spine === 'left' ? -1 : 1) * p * 90,
    edge: (Math.cos(theta) * P) / (P - Math.sin(theta)),
    shade: 0.55 * Math.sin(theta), // la page s'éloigne de la lumière frontale
    shadow: 0.6 * Math.sin(2 * theta), // ombre portée : nulle à plat et de chant, maximale à mi-course
    under: 0.35 * (1 - p), // occlusion de la page du dessous, qui se découvre
  };
}

/**
 * Effet d'une transition sur un plan entrant (`in`) ou sortant (`out`), q ∈ [0,1] (avancement).
 * Les translations sont exprimées en fraction de la taille du cadre.
 * cut / fade-black / dip-color ne modifient pas le plan : ils passent par un calque de couleur.
 */
export function transitionStyle(t: RTransition, role: 'in' | 'out', q: number): TStyle {
  const p = ease('inOutSine', q);
  const s: TStyle = { ...IDENTITY };
  switch (t.type) {
    case 'crossfade':
      if (role === 'in') s.opacity = p;
      break;
    case 'blur-dissolve':
      if (role === 'in') { s.opacity = p; s.blur = (1 - p) * 0.012; } else s.blur = p * 0.012;
      break;
    case 'slide': {
      const dir = t.direction ?? 'left';
      const sign = dir === 'left' || dir === 'up' ? -1 : 1;
      const v = role === 'in' ? -sign * (1 - p) : sign * p;
      if (dir === 'left' || dir === 'right') s.translateX = v; else s.translateY = v;
      break;
    }
    case 'zoom-through':
      if (role === 'out') { s.scale = 1 + 0.35 * p; s.opacity = 1 - p; } else { s.scale = 0.85 + 0.15 * p; s.opacity = p; }
      break;
    case 'wipe':
      if (role === 'in') {
        if (t.shape === 'radial') s.clipPath = `circle(${(p * 75).toFixed(3)}% at 50% 50%)`;
        else {
          const r = ((1 - p) * 100).toFixed(3);
          const d = t.direction ?? 'right';
          s.clipPath = d === 'right' ? `inset(0 ${r}% 0 0)` : d === 'left' ? `inset(0 0 0 ${r}%)` : d === 'down' ? `inset(0 0 ${r}% 0)` : `inset(${r}% 0 0 0)`;
        }
      }
      break;
    case 'page-turn': {
      // direction « left » (défaut) = reliure à gauche : la page se tourne de droite à gauche.
      const spine = t.direction === 'right' ? 'right' : 'left';
      const g = pageTurnAt(q, spine);
      s.page = role === 'out'
        ? { part: 'page', spine, rotateY: g.angle, perspective: PAGE_PERSPECTIVE, shade: g.shade, shadow: 0, shadowEdge: g.edge }
        : { part: 'under', spine, rotateY: 0, perspective: PAGE_PERSPECTIVE, shade: g.under, shadow: g.shadow, shadowEdge: g.edge };
      break;
    }
    default:
      break;
  }
  return s;
}

/**
 * Ordre d'empilement d'un plan à l'image `frame`. Par défaut le plan entrant (z supérieur) recouvre le sortant ;
 * pour une page tournée, c'est la page sortante qui doit rester au-dessus pendant sa sortie.
 */
export function layerOrder(shot: RShot, frame: number): number {
  const turning = shot.exit?.type === 'page-turn' && shot.exit.frames > 0 && frame >= shot.to - shot.exit.frames;
  return turning ? shot.z + 1_000_000 : shot.z;
}

/** Combine l'effet d'entrée et de sortie d'un plan à l'image `frame`. */
export function shotTransitionAt(shot: RShot, frame: number): TStyle {
  let s: TStyle = { ...IDENTITY };
  if (shot.enter && shot.enter.frames > 0 && frame < shot.from + shot.enter.frames) {
    s = merge(s, transitionStyle(shot.enter, 'in', (frame - shot.from + 1) / (shot.enter.frames + 1)));
  }
  if (shot.exit && shot.exit.frames > 0 && frame >= shot.to - shot.exit.frames) {
    s = merge(s, transitionStyle(shot.exit, 'out', (frame - (shot.to - shot.exit.frames) + 1) / (shot.exit.frames + 1)));
  }
  return s;
}

function merge(a: TStyle, b: TStyle): TStyle {
  // Si un plan court entre et sort simultanément en page tournée, la sortie (pivot) prime.
  return { opacity: a.opacity * b.opacity, translateX: a.translateX + b.translateX, translateY: a.translateY + b.translateY, scale: a.scale * b.scale, blur: a.blur + b.blur, clipPath: b.clipPath ?? a.clipPath, page: b.page ?? a.page };
}

/** Opacité d'un calque de couleur (fondu/dip) : montée jusqu'à `peak`, descente jusqu'à `to`. */
export function fadeOpacity(f: { from: number; peak: number; to: number }, frame: number): number {
  if (frame < f.from || frame >= f.to) return 0;
  if (frame <= f.peak) return f.peak === f.from ? 1 : clamp01((frame - f.from + 1) / (f.peak - f.from + 1));
  return f.to - 1 === f.peak ? 1 : clamp01(1 - (frame - f.peak) / (f.to - f.peak));
}

/** Rampe d'apparition/disparition d'un élément sur `n` images. */
export function ramp(frame: number, from: number, to: number, nIn: number, nOut: number): number {
  if (frame < from || frame >= to) return 0;
  const a = nIn > 0 ? clamp01((frame - from + 1) / nIn) : 1;
  const b = nOut > 0 ? clamp01((to - frame) / nOut) : 1;
  return Math.min(a, b);
}

/** Durée (images) d'une montée de ligne en défilement (paroles `flow: scroll`). */
export const SCROLL_FRAMES = 8;
/** Opacité d'une ligne en attente (emplacement bas) avant de monter au premier plan. */
export const SCROLL_DIM = 0.42;

/**
 * Défilement synchronisé d'une ligne : décalage vertical (px, positif = plus bas) et opacité relative.
 * En attente : un emplacement plus bas, atténuée ; montée sur SCROLL_FRAMES images jusqu'à `focusFrom` ;
 * sortie sur les MÊMES images que la montée de la ligne suivante (jusqu'à `leaveFrom`) : remontée de 60 %
 * d'emplacement et effacement, pour que les deux lignes ne se superposent jamais au premier plan.
 * Si une ligne reste moins de SCROLL_FRAMES images au premier plan (ligne très brève), sa sortie prime.
 */
export function scrollState(s: { focusFrom: number; leaveFrom: number; gap: number; last: boolean }, frame: number): { dy: number; opacity: number } {
  const T = SCROLL_FRAMES;
  if (!s.last && frame >= s.leaveFrom - T) {
    const p = ease('inOutCubic', (frame - (s.leaveFrom - T) + 1) / T);
    // Départ de la sortie depuis la position courante (premier plan, ou encore en montée si la ligne est brève).
    const startDy = s.leaveFrom - T < s.focusFrom ? s.gap * (1 - ease('inOutCubic', (s.leaveFrom - T - (s.focusFrom - T) + 1) / T)) : 0;
    return { dy: startDy * (1 - p) - s.gap * 0.6 * p, opacity: (1 - p) * (startDy > 0 ? SCROLL_DIM + (1 - SCROLL_DIM) * (1 - startDy / s.gap) : 1) };
  }
  if (frame < s.focusFrom - T) return { dy: s.gap, opacity: SCROLL_DIM };
  if (frame < s.focusFrom) {
    const p = ease('inOutCubic', (frame - (s.focusFrom - T) + 1) / T);
    return { dy: s.gap * (1 - p), opacity: SCROLL_DIM + (1 - SCROLL_DIM) * p };
  }
  return { dy: 0, opacity: 1 };
}

/**
 * Parchemin texturé à l'image `frame` : `k` = ouverture (0 enroulé → 1 déroulé, déroulé depuis le centre),
 * `text` = opacité du texte (il n'apparaît qu'une fois le papier presque ouvert), `dy` = flottement (pixels).
 */
export function texturedParchmentState(frame: number, from: number, to: number, unrollFrames: number, float: number, H: number, fps: number) {
  const n = Math.max(1, unrollFrames);
  const open = ease('inOutCubic', clamp01((frame - from + 1) / n));
  const close = ease('inOutCubic', clamp01((to - frame) / Math.max(1, Math.round(n * 0.7))));
  const k = Math.min(open, close);
  return { k, text: clamp01((k - 0.6) / 0.4), dy: Math.sin(((frame - from) / fps) * Math.PI * 0.8) * float * H };
}

// Timeline résolue : contrat entre le compilateur (Node) et les compositions Remotion (navigateur).
// Toutes les valeurs temporelles sont en IMAGES ; toutes les positions en PIXELS du format.
// Aucun import Node ici : ce fichier est inclus dans le bundle navigateur.

export type REasing = 'linear' | 'inOutSine' | 'inOutCubic' | 'outExpo' | 'inOutQuad';
export type RTransitionType = 'cut' | 'crossfade' | 'fade-black' | 'dip-color' | 'slide' | 'zoom-through' | 'wipe' | 'blur-dissolve' | 'page-turn';

export interface RRect { x: number; y: number; w: number; h: number }
export interface RCamera { scale: number; x: number; y: number }

export interface RTransition {
  type: RTransitionType;
  frames: number;
  color?: string;
  direction?: 'left' | 'right' | 'up' | 'down';
  shape?: 'linear' | 'radial';
}

export interface RShot {
  id: string;
  sceneId: string;
  from: number; // inclus
  to: number; // exclu
  src: string; // chemin relatif à assetBaseUrl
  srcW: number;
  srcH: number;
  fit: 'cover' | 'contain' | 'blurFill';
  /** start : image où commence le mouvement (défaut : from) ; caméra figée sur `from` avant (préambule). */
  /** end : dernière image du mouvement (défaut : to − 1) ; caméra figée au-delà (plan prolongé, ex. fermeture d'un Short). */
  motion: { from: RCamera; to: RCamera; easing: REasing; pulseFrames?: number[]; pulseIntensity?: number; start?: number; end?: number };
  enter?: RTransition;
  exit?: RTransition;
  foreground?: { src: string; srcW: number; srcH: number; depth: number };
  z: number;
}

export interface RLyricsStyle {
  type: 'text-on-image' | 'parchment' | 'cartouche';
  fontFamily: string;
  weight: number;
  color: string;
  accent: string;
  shadowColor: string;
  align: 'left' | 'center' | 'right';
  karaoke: 'none' | 'line' | 'word';
  enter: 'fade' | 'rise' | 'reveal';
  flow?: 'static' | 'scroll' | 'phrase';
  shadow: boolean;
  stroke: number;
  scrim: boolean;
  panel: { opacity: number; blur: number; radius: number; border: string | null; color: string };
  parchment: { textureSrc: string | null; orientation: 'horizontal' | 'vertical'; unrollFrames: number; ink: string; float: number };
  leadFrames: number;
}

export interface RWord { text: string; from: number; to: number; line: number }

export interface RLyric {
  id: string;
  sceneId: string;
  from: number;
  to: number;
  lines: string[];
  words: RWord[];
  style: RLyricsStyle;
  fontSize: number;
  lineHeight: number;
  box: RRect;
  groupId: string;
  groupFrom: number;
  groupTo: number;
  groupBox: RRect;
  /** Parchemin texturé : rectangle (pixels) où la texture est dessinée, proportions conservées ; groupBox = zone de papier. */
  panelBox?: RRect;
  /** Défilement : image où la ligne prend le premier plan, image où elle le quitte, distance (px) à la place d'attente. */
  scroll?: { focusFrom: number; leaveFrom: number; gap: number; last: boolean };
}

export interface RTitle {
  id: string;
  from: number;
  to: number;
  text: string;
  type: 'plain' | 'parchment';
  fontFamily: string;
  fontSize: number;
  color: string;
  box: RRect;
  parchmentSrc: string | null;
}

/** Sprite animé : poses en boucle (`poseFps`), trajectoire linéaire du point d'appui (bas-centre, pixels). */
export interface RSprite {
  id: string;
  sceneId: string;
  from: number; // inclus
  to: number; // exclu
  frames: string[]; // chemins relatifs à assetBaseUrl
  poseFps: number;
  height: number; // pixels
  path: { from: { x: number; y: number }; to: { x: number; y: number } };
  fadeFrames: number;
  z: number;
}

export interface RColorFade { from: number; peak: number; to: number; color: string }

export interface RFont { family: string; src: string; sha256: string }

export interface RTimeline {
  version: 1;
  format: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  /** Images de préambule avant le début du master audio (l'image `prerollFrames` = temps chanson 0). */
  prerollFrames?: number;
  /** Injecté au moment du rendu (URL du serveur d'assets) : n'entre PAS dans les clés de cache. */
  assetBaseUrl: string;
  safe: { title: RRect; action: RRect };
  shots: RShot[];
  /** Optionnel : absent des timelines sans personnage animé (clés de cache inchangées pour celles-ci). */
  sprites?: RSprite[];
  lyrics: RLyric[];
  titles: RTitle[];
  fades: RColorFade[];
  effects: { vignette: number; grain: number };
  /** Surcharges d'effets par scène (intervalles d'images). */
  effectRanges?: { from: number; to: number; vignette: number; grain: number }[];
  fonts: RFont[];
  showSafe?: boolean;
}

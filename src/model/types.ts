// Types du modèle de projet NMSVS. Ils reflètent exactement les schémas de `schemas/`
// (la conformité est vérifiée par tests/ts/schemas.test.ts sur les fixtures et exemples).

export type FormatId = string; // ex. "16x9", "9x16"
export type Ref<T> = string | T; // "preset:<id>" ou objet en ligne

export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }
export interface Margins { top: number; right: number; bottom: number; left: number }

// ───────────── project.json ─────────────
export interface SafeZoneSpec { title: Margins; action: Margins }
export interface FormatSpec { width: number; height: number; safeZone?: Ref<SafeZoneSpec> }

export interface ArtDirection {
  lyricStyle?: Ref<LyricsStyle>;
  transitionDefault?: Ref<TransitionSpec>;
  motionCycle?: string[];
  colorLook?: { lut?: string; intensity?: number };
  harmonize?: { mode: 'auto' | 'off'; strength?: number; reference?: string };
  fonts?: { lyrics?: string; titles?: string };
  palette?: { text?: string; accent?: string; shadow?: string };
  shotLength?: { min: number; max: number };
  vignette?: number;
  grain?: number;
  lyricLeadSec?: number;
  lyricTailSec?: number;
  maxUpscale?: number;
}

export interface SyncSettings {
  engine?: 'whisperx' | 'stable-ts' | 'uniform';
  preprocess?: 'vocal-focus' | 'none';
  asrModel?: string;
  alignModel?: string;
}

export interface ProjectFile {
  $schema?: string;
  schemaVersion: 1;
  id: string;
  title: string;
  audio: { master: string; offsetSec?: number };
  /** Préambule : la vidéo commence `sec` secondes avant le master audio (silence ajouté à l'assemblage). */
  preroll?: { sec: number };
  lyrics: string;
  fps: number;
  formats: Record<FormatId, FormatSpec>;
  art: ArtDirection;
  sync?: SyncSettings;
  exportProfiles?: string[];
  reels?: { format?: FormatId; lyricStyle?: Ref<LyricsStyle>; titleCard?: boolean; fadeInSec?: number; fadeOutSec?: number };
}

// ───────────── assets.json ─────────────
export interface Grade { exposure?: number; contrast?: number; saturation?: number; temperature?: number; excludeFromHarmonize?: boolean }
export interface ImageAsset {
  id: string;
  path: string;
  sha256?: string;
  size?: { w: number; h: number };
  focal?: Point;
  safeSubject?: Rect;
  crops?: Record<FormatId, Rect>;
  replace?: Record<FormatId, string>;
  grade?: Grade;
  fit?: 'cover' | 'contain' | 'blurFill';
  /** Ajustement par format, prioritaire sur `fit` (ex. blurFill en 9:16 seulement). */
  fits?: Record<string, 'cover' | 'contain' | 'blurFill'>;
  tags?: string[];
}
export interface FileAsset { id: string; path: string; sha256?: string }
export interface AssetsFile { $schema?: string; schemaVersion: 1; images: ImageAsset[]; textures?: FileAsset[] }

// ───────────── lyrics.json ─────────────
export type SectionKind = 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'outro' | 'instrumental' | 'spoken' | 'other';
export interface LyricsLine { id: string; text: string; display?: Record<FormatId, string>; singer?: string | null; skipAlign?: boolean; style?: Ref<LyricsStyle> }
export interface LyricsSection { id: string; kind: SectionKind; label: string; repeatOf?: string | null; lines: LyricsLine[]; style?: Ref<LyricsStyle> }
export interface LyricsFile { $schema?: string; schemaVersion: 1; language: string; title?: string; sections: LyricsSection[] }

// ───────────── presets / styles ─────────────
export type Easing = 'linear' | 'inOutSine' | 'inOutCubic' | 'outExpo' | 'inOutQuad';
export interface CameraKey { scale?: number; x?: number; y?: number }
export interface MotionSpec {
  type: 'zoom' | 'pan' | 'drift' | 'still' | 'parallax' | 'beat-pulse';
  from?: CameraKey;
  to?: CameraKey;
  easing?: Easing;
  pulse?: { intensity: number; every: number };
  depth?: number;
}

export type TransitionType = 'cut' | 'crossfade' | 'fade-black' | 'dip-color' | 'slide' | 'zoom-through' | 'wipe' | 'blur-dissolve' | 'page-turn';
export interface TransitionSpec {
  type: TransitionType;
  duration?: { beats: number } | { sec: number };
  color?: string;
  direction?: 'left' | 'right' | 'up' | 'down';
  shape?: 'linear' | 'radial';
}

export type LyricsStyleType = 'text-on-image' | 'parchment' | 'cartouche' | 'none';
export interface LyricsStyle {
  type: LyricsStyleType;
  font?: string;
  fontSize?: { min: number; max: number }; // fraction de la hauteur de l'image
  weight?: number;
  color?: string;
  accent?: string;
  position?: 'lower-third' | 'center' | 'upper-third' | 'auto';
  align?: 'left' | 'center' | 'right';
  lines?: 1 | 2;
  /** scroll : ligne chantée au premier plan, ligne suivante en attente dessous (défilement synchronisé). */
  flow?: 'static' | 'scroll' | 'phrase';
  /**
   * Mode phrase : refermer le conteneur à chaque changement de scène (sinon il persiste tant que le chant continue).
   * Le conteneur est alors absent pendant les transitions entre scènes (pages tournées) : il se referme au plus tard au
   * premier instant de la transition et ne se rouvre qu'à sa fin (ajustement visuel local, synchronisation inchangée).
   */
  sceneBreak?: boolean;
  /** Centre horizontal du conteneur (fraction de la largeur du cadre) ; défaut : centre de la zone sûre. */
  centerX?: number;
  /** Avance d'affichage propre au style (s) ; défaut : art.lyricLeadSec. 0 = jamais avant le chant. */
  leadSec?: number;
  karaoke?: 'none' | 'line' | 'word';
  enter?: 'fade' | 'rise' | 'reveal';
  shadow?: boolean;
  stroke?: number;
  scrim?: boolean;
  maxWidth?: number; // fraction de la largeur sûre
  panel?: { opacity?: number; blur?: number; radius?: number; border?: string | null; color?: string };
  /** paper : zone de papier plat de la texture (fractions) → rendu texturé, proportions du bandeau conservées. */
  parchment?: { texture?: string; orientation?: 'horizontal' | 'vertical'; unrollSec?: number; ink?: string; float?: number; paper?: Rect };
}

export interface TitleStyle { type: 'plain' | 'parchment'; font?: string; size?: number; color?: string; position?: 'center' | 'upper-third' | 'lower-third' }

// ───────────── timeline.json ─────────────
export type TimeAnchor = (
  | { at: number }
  | { section: string; edge?: 'start' | 'end' }
  | { line: string; edge?: 'start' | 'end' }
  | { word: string }
  | { beat: number }
  | { bar: number }
  | { end: true }
) & { offsetSec?: number; snap?: 'beat' | 'downbeat' | 'none' };

export interface IllustrationRef {
  asset: string;
  motion?: Ref<MotionSpec>;
  until?: TimeAnchor;
  weight?: number;
  foreground?: string;
}

export interface SceneLyrics {
  style?: Ref<LyricsStyle> | 'none';
  karaoke?: 'none' | 'line' | 'word';
  position?: LyricsStyle['position'];
  lines?: 1 | 2;
}

export interface Scene {
  id: string;
  span: { from: TimeAnchor; to: TimeAnchor };
  illustrations: IllustrationRef[];
  distribution?: 'byLines' | 'even' | 'explicit' | 'weights';
  illustrationTransition?: Ref<TransitionSpec>;
  lyrics?: SceneLyrics;
  title?: { text: string; style?: Ref<TitleStyle>; durationSec?: number };
  transitionIn?: Ref<TransitionSpec>;
  transitionOut?: Ref<TransitionSpec>;
  effects?: { vignette?: number; grain?: number };
  formats?: Record<FormatId, { lyrics?: SceneLyrics; illustrations?: IllustrationRef[] }>;
  /** Personnages animés (cycle de poses PNG transparentes) traversant la scène, au-dessus des illustrations. */
  sprites?: SpriteSpec[];
  note?: string;
}

/**
 * Sprite animé : cycle de poses (textures PNG de assets.json, proportions et transparence conservées)
 * déplacé en ligne droite à vitesse constante. Positions normalisées (0–1) du point d'appui (bas-centre).
 * Temps relatifs au début de la scène.
 */
export interface SpriteSpec {
  id: string;
  frames: string[];
  poseFps?: number;
  height: number;
  path: { from: Point; to: Point };
  startSec?: number;
  durationSec: number;
  fadeSec?: number;
}
export interface TimelineFile { $schema?: string; schemaVersion: 1; credits?: CreditsRef; scenes: Scene[] }

// ───────────── générique réutilisable (*.credits.json) ─────────────
/** Média d'un générique : chemin (absolu, ou relatif à une racine de médias) ou asset du projet appelant. */
export type CreditsMediaRef = string | { asset: string };
export interface CreditsSequence {
  id: string;
  /** Emplacement média du fond. */
  background: string;
  /** Absente sur la dernière séquence : jusqu'à la fin de la musique. */
  durationSec?: number;
  motion?: Ref<MotionSpec>;
  transitionIn?: Ref<TransitionSpec>;
  transitionOut?: Ref<TransitionSpec>;
  /** `frames` = emplacements média des poses. */
  sprites?: SpriteSpec[];
  note?: string;
}
export interface CreditsTemplate { $schema?: string; schemaVersion: 1; id: string; title?: string; mediaRoot?: string | string[]; media: Record<string, CreditsMediaRef>; sequences: CreditsSequence[] }
/** Appel d'un générique depuis timeline.json : séquences ajoutées après la dernière scène, à partir de `from`. */
export interface CreditsRef {
  template: string;
  from: TimeAnchor;
  mediaRoot?: string | string[];
  media?: Record<string, CreditsMediaRef>;
  overrides?: Record<string, Partial<Omit<CreditsSequence, 'id' | 'background' | 'sprites'>> & { sprites?: (Partial<SpriteSpec> & { id: string })[] }>;
}

/**
 * Fermeture des Shorts, ajoutée APRÈS la musique (aucune image de la partie musicale n'est modifiée) :
 * paroles et conteneur masqués, transition vers le premier plan de `scene` (ex. la couverture), tenue, fin.
 */
/** `audio` : `stop` (défaut) = silence après la musique ; `continue` = le master se poursuit sous la fermeture (fondu audio final). */
export interface ReelClosing { scene: string; transition?: { type: 'page-turn' | 'crossfade'; duration?: { sec: number }; direction?: 'left' | 'right' }; lyricsOutSec?: number; holdSec?: number; audio?: 'stop' | 'continue' }

// ───────────── sync.overrides.json ─────────────
export interface LineOverride { start?: number; end?: number; shift?: number; lock?: boolean; note?: string }
export interface WordOverride { start?: number; end?: number; lock?: boolean }
export interface SyncOverridesFile { $schema?: string; schemaVersion: 1; globalOffsetSec?: number; lines?: Record<string, LineOverride>; words?: Record<string, WordOverride> }

// ───────────── reels.json ─────────────
export interface ReelsFile {
  $schema?: string;
  schemaVersion: 1;
  params?: { durations?: number[]; count?: number; maxOverlap?: number; weights?: Ref<Record<string, number>>; lambda?: number; timeline?: string; syncOverrides?: string; closing?: ReelClosing };
  selection: { candidate: string; name?: string; adjust?: { startSec?: number; endSec?: number }; snap?: boolean }[];
}

export interface Decision { ts: string; by: 'user' | 'engine'; via?: string; scope?: string; decision: string; reason?: string; refs?: string[] }

// ───────────── fichiers machine ─────────────
export interface AudioAnalysis {
  version: 1;
  audioSha256: string;
  durationSec: number;
  sampleRate: number;
  channels: number;
  tempo: { bpm: number; confidence: number };
  beats: number[];
  downbeats: number[];
  meter: number;
  onsets: number[];
  rms: { hopSec: number; values: number[] };
  novelty: { hopSec: number; values: number[] };
  vocalBand: { hopSec: number; values: number[] };
  chroma: { hopSec: number; values: number[][] };
  segments: { start: number; end: number; label: string }[];
  loudness?: { integratedLUFS: number; truePeakDBTP: number; lra: number };
}

export interface TimedWord { id: string; text: string; start: number; end: number; confidence: number; source: 'auto' | 'override' | 'interpolated' | 'uniform' }
export interface TimedLine { id: string; start: number; end: number; confidence: number; source: TimedWord['source']; words: TimedWord[] }
export interface SyncAuto {
  version: 1;
  engine: string;
  audioSha256: string;
  lyricsHash: string;
  lines: TimedLine[];
  textDiff?: { lineId: string; expected: string; heard: string }[];
  metrics?: Record<string, number>;
}
export interface SyncResolved {
  version: 1;
  audioSha256: string;
  engine: string;
  lines: TimedLine[];
  sections: Record<string, { start: number; end: number }>;
  staleOverrides: string[];
}

export interface Candidate {
  id: string;
  start: number;
  end: number;
  duration: number;
  targetDuration: number;
  sections: string[];
  criteria: Record<string, number>;
  score: number;
  rank?: number;
  strengths: string[];
  weaknesses: string[];
  justification: string;
  boundaries: { start: string; end: string };
}

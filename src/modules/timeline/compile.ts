import { NmsvsError } from '../../core/errors';
import { resolveRef } from '../../model/presets';
import { allLines, type ProjectBundle } from '../../model/project';
import type {
  AudioAnalysis, IllustrationRef, LyricsStyle, Margins, MotionSpec, Scene, SceneLyrics, SafeZoneSpec, SyncResolved, TimedLine, TitleStyle, TransitionSpec,
} from '../../model/types';
import type { RColorFade, RLyric, RLyricsStyle, RRect, RShot, RSprite, RTimeline, RTitle, RTransition } from '../../remotion/types';
import { resolveAnchor, transitionSeconds, type AnchorContext } from './anchors';
import { fitLines } from './layout';

export interface ImageInfo { rel: string; sha: string; w: number; h: number; upscale: number; subjectCut: number; sourceId: string; fit: 'cover' | 'contain' | 'blurFill' }
export type ImageResolver = (assetId: string, margin: number) => ImageInfo;
export type FileStager = (kind: 'font' | 'texture', idOrPath: string) => { rel: string; sha: string; family?: string; w?: number; h?: number } | null;

export interface CompileWarning { code: string; message: string; at?: number }
export interface CompileResult { timeline: RTimeline; warnings: CompileWarning[]; usage: { assetId: string; margin: number }[] }

const OVERLAP: RTransition['type'][] = ['crossfade', 'blur-dissolve', 'slide', 'zoom-through', 'wipe', 'page-turn'];
const COLOR: RTransition['type'][] = ['fade-black', 'dip-color'];

export function safeRects(spec: SafeZoneSpec, W: number, H: number): { title: RRect; action: RRect } {
  const r = (m: Margins): RRect => ({ x: Math.round(m.left * W), y: Math.round(m.top * H), w: Math.round(W * (1 - m.left - m.right)), h: Math.round(H * (1 - m.top - m.bottom)) });
  return { title: r(spec.title), action: r(spec.action) };
}

/**
 * Compilation d'une timeline déclarative en timeline résolue (images, pixels) pour un format.
 * Fonction pure : les accès disque (préparation des images, polices) passent par les callbacks.
 */
export function compileTimeline(b: ProjectBundle, format: string, sync: SyncResolved, analysis: AudioAnalysis, images: ImageResolver, stage: FileStager, opts: { prerollFrames?: number } = {}): CompileResult {
  const timeline = b.timeline;
  if (!timeline) throw new NmsvsError('E_ASSET_MISSING', 'timeline.json absent.', 'Lancer `nmsvs compose`.');
  const spec = b.project.formats[format];
  if (!spec) throw new NmsvsError('E_ARGS', `Format « ${format} » absent de project.json (${Object.keys(b.project.formats).join(', ')}).`);
  const W = spec.width;
  const H = spec.height;
  const fps = b.project.fps;
  const D = Math.max(1, Math.ceil(analysis.durationSec * fps));
  const toF = (sec: number) => Math.max(0, Math.min(D, Math.round(sec * fps)));
  const bpm = analysis.tempo.bpm;
  const art = b.project.art;
  const warnings: CompileWarning[] = [];
  const usage: { assetId: string; margin: number }[] = [];
  const actx: AnchorContext = { sync, analysis };
  const safe = safeRects(resolveRef<SafeZoneSpec>('safe', spec.safeZone ?? 'preset:safe-none')!, W, H);

  // 1. Résolution et contrôle de couverture des scènes
  const scenes = timeline.scenes.map((sc) => ({
    sc,
    from: toF(resolveAnchor(sc.span.from, actx, `${sc.id}.span.from`)),
    to: toF(resolveAnchor(sc.span.to, actx, `${sc.id}.span.to`)),
  })).sort((a, c) => a.from - c.from);
  const gaps: string[] = [];
  if (scenes[0].from > 1) gaps.push(`début non couvert : 0 → ${(scenes[0].from / fps).toFixed(2)} s`);
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (s.to <= s.from) gaps.push(`scène ${s.sc.id} de durée nulle ou négative (${(s.from / fps).toFixed(2)} → ${(s.to / fps).toFixed(2)} s)`);
    const next = scenes[i + 1];
    if (next && Math.abs(next.from - s.to) > 1) gaps.push(`${next.from > s.to ? 'trou' : 'chevauchement'} entre ${s.sc.id} et ${next.sc.id} (${(s.to / fps).toFixed(2)} s / ${(next.from / fps).toFixed(2)} s)`);
    if (next) s.to = next.from; // tolérance d'une image : jointure exacte
  }
  const last = scenes[scenes.length - 1];
  if (D - last.to > 1) gaps.push(`fin non couverte : ${(last.to / fps).toFixed(2)} s → ${(D / fps).toFixed(2)} s`);
  if (gaps.length) throw new NmsvsError('E_TIMELINE_GAP', `Timeline incomplète :\n  ${gaps.join('\n  ')}`, 'Ajuster les ancres « span » des scènes (elles doivent se suivre sans trou).', gaps);
  scenes[0].from = 0;
  last.to = D;

  // 2. Plans (illustrations) et transitions
  const shots: RShot[] = [];
  const shotSource = new Map<string, string>(); // plan → image source (après remplacement par format)
  const fades: RColorFade[] = [];
  const effectRanges: NonNullable<RTimeline['effectRanges']> = [];
  const motionCycle = art.motionCycle ?? ['preset:slow-push-in'];
  let cycle = 0;
  const lineStarts = (from: number, to: number) => sync.lines.map((l) => toF(l.start - (art.lyricLeadSec ?? 0.25))).filter((f) => f > from + fps && f < to - fps);
  const transitionOf = (ref: TransitionSpec | string | undefined): RTransition => {
    const t = resolveRef<TransitionSpec>('transition', ref ?? art.transitionDefault ?? 'preset:crossfade-beat')!;
    return { type: t.type, frames: Math.round(transitionSeconds(t.duration, bpm) * fps), color: t.color ?? (t.type === 'fade-black' ? '#000000' : art.palette?.accent ?? '#FFFFFF'), direction: t.direction, shape: t.shape };
  };
  const pendingJoins: { a: RShot; b: RShot; tr: RTransition; at: number }[] = [];
  let prevShot: RShot | null = null;

  scenes.forEach(({ sc, from, to }, si) => {
    const fo = sc.formats?.[format];
    let ills: IllustrationRef[] = fo?.illustrations ?? sc.illustrations;
    // Scène longue avec une seule illustration : relances de mouvement (plans successifs sur la même image,
    // mouvement alterné ou inversé), pour éviter un mouvement unique imperceptible (docs/06 §5).
    const maxShot = (art.shotLength?.max ?? 10) * fps;
    if (ills.length === 1 && !ills[0].until && to - from > 2 * maxShot) {
      const k = Math.ceil((to - from) / (maxShot * 1.5));
      const il = ills[0];
      const base = il.motion ? resolveRef<MotionSpec>('motion', il.motion)! : undefined;
      ills = Array.from({ length: k }, (_, i) => {
        if (!base) return { ...il, motion: undefined };
        const m: MotionSpec = i % 2 ? { ...base, from: base.to, to: base.from } : base;
        return { ...il, motion: m };
      });
      warnings.push({ code: 'I_MOTION_RELAUNCH', message: `${sc.id} : scène de ${((to - from) / fps).toFixed(0)} s sur une seule illustration → ${k} relances de mouvement`, at: from / fps });
    }
    const bounds = distribute(sc, ills, from, to, actx, toF, lineStarts(from, to), analysis, fps);
    ills.forEach((il, i) => {
      const motion = resolveRef<MotionSpec>('motion', il.motion ?? motionCycle[cycle++ % motionCycle.length])!;
      const f = motion.from ?? {};
      const t2 = motion.to ?? {};
      const maxScale = Math.max(f.scale ?? 1, t2.scale ?? 1) + (motion.pulse?.intensity ?? 0) * 2;
      const margin = Math.min(1.35, Math.max(1, Math.ceil(maxScale * 100) / 100));
      usage.push({ assetId: il.asset, margin });
      const img = images(il.asset, margin);
      const s0 = bounds[i];
      const s1 = bounds[i + 1];
      const shot: RShot = {
        id: `${sc.id}-${i + 1}`, sceneId: sc.id, from: s0, to: s1, src: img.rel, srcW: img.w, srcH: img.h, fit: img.fit,
        motion: {
          from: { scale: f.scale ?? 1, x: f.x ?? 0.5, y: f.y ?? 0.5 },
          to: { scale: t2.scale ?? f.scale ?? 1, x: t2.x ?? f.x ?? 0.5, y: t2.y ?? f.y ?? 0.5 },
          easing: motion.easing ?? 'inOutSine',
        },
        z: shots.length,
      };
      shotSource.set(shot.id, img.sourceId);
      if (motion.type === 'beat-pulse' && motion.pulse) {
        const every = motion.pulse.every;
        shot.motion.pulseFrames = analysis.downbeats.map(toF).filter((x, k) => x >= s0 && x < s1 && k % every === 0);
        shot.motion.pulseIntensity = motion.pulse.intensity;
      }
      if (il.foreground) {
        const fg = images(il.foreground, margin);
        usage.push({ assetId: il.foreground, margin });
        shot.foreground = { src: fg.rel, srcW: fg.w, srcH: fg.h, depth: motion.depth ?? 0.04 };
      }
      if (img.upscale > (art.maxUpscale ?? 1.5)) warnings.push({ code: 'QC-E5', message: `${il.asset} (${format}) agrandie ${img.upscale.toFixed(2)}× > ${art.maxUpscale ?? 1.5}×`, at: s0 / fps });
      else if (img.upscale > 1.2) warnings.push({ code: 'QC-E5-info', message: `${il.asset} (${format}) agrandie ${img.upscale.toFixed(2)}×`, at: s0 / fps });
      if (img.subjectCut > 0.15) warnings.push({ code: 'QC-E6', message: `${il.asset} (${format}) : sujet coupé à ${Math.round(img.subjectCut * 100)} %`, at: s0 / fps });
      const speed = Math.abs(shot.motion.to.scale - shot.motion.from.scale) * W / Math.max(1, s1 - s0);
      if (speed > 0.004 * W) warnings.push({ code: 'W_MOTION_FAST', message: `${shot.id} : mouvement rapide (risque de saccade)`, at: s0 / fps });
      if ((s1 - s0) / fps > 30 && motion.type === 'still') warnings.push({ code: 'W_LONG_STILL', message: `${shot.id} : plan fixe de ${((s1 - s0) / fps).toFixed(0)} s`, at: s0 / fps });
      if (prevShot) {
        const tr = i === 0 ? transitionOf(sc.transitionIn) : transitionOf(sc.illustrationTransition);
        pendingJoins.push({ a: prevShot, b: shot, tr, at: s0 });
      } else if (sc.transitionIn) {
        const tr = transitionOf(sc.transitionIn);
        if (COLOR.includes(tr.type) && tr.frames > 0) fades.push({ from: 0, peak: 0, to: Math.min(tr.frames, s1 - s0), color: tr.color ?? '#000000' });
      }
      shots.push(shot);
      prevShot = shot;
    });
    if (sc.effects) effectRanges.push({ from, to, vignette: sc.effects.vignette ?? art.vignette ?? 0, grain: sc.effects.grain ?? art.grain ?? 0 });
    if (si === scenes.length - 1 && sc.transitionOut) {
      const tr = transitionOf(sc.transitionOut);
      if (COLOR.includes(tr.type) && tr.frames > 0) fades.push({ from: D - tr.frames, peak: D - 1, to: D, color: tr.color ?? '#000000' });
    }
  });

  // Jointures : chevauchement symétrique (fondus, glissés…) ou calque de couleur (noir, dip)
  for (const { a, b, tr, at } of pendingJoins) {
    // Le premier plan sera prolongé par le préambule (applyPreroll) : sa durée réelle inclut ces images.
    const aLen = a.to - a.from + (a === shots[0] ? opts.prerollFrames ?? 0 : 0);
    const maxF = Math.floor(Math.min(aLen, b.to - b.from) * 0.4);
    const d = Math.min(tr.frames, maxF);
    if (tr.type === 'cut' || d <= 1) continue;
    if (OVERLAP.includes(tr.type)) {
      const half = Math.floor(d / 2);
      a.to = at + (d - half);
      b.from = Math.max(0, at - half);
      a.exit = { ...tr, frames: d };
      b.enter = { ...tr, frames: d };
    } else if (COLOR.includes(tr.type)) {
      const half = Math.floor(d / 2);
      fades.push({ from: at - half, peak: at, to: at + (d - half), color: tr.color ?? '#000000' });
    }
  }

  // 2 bis. Sprites (personnages animés) : au-dessus des plans, sous les effets, fondus et paroles.
  const sprites: RSprite[] = [];
  for (const { sc, from, to } of scenes) {
    for (const sp of sc.sprites ?? []) {
      const unknown = sp.frames.filter((id) => !b.assets.textures?.some((t) => t.id === id));
      if (unknown.length) throw new NmsvsError('E_ASSET_MISSING', `${sc.id}.sprites.${sp.id} : pose(s) inconnue(s) ${unknown.join(', ')}`, 'Importer les poses avec `nmsvs import textures <png…>` (fichiers utilisés tels quels, transparence conservée).');
      const s0 = Math.min(to, from + Math.round((sp.startSec ?? 0) * fps));
      const want = s0 + Math.round(sp.durationSec * fps);
      const s1 = Math.min(to, want);
      if (s1 <= s0) throw new NmsvsError('E_TIMELINE_GAP', `${sc.id}.sprites.${sp.id} : commence après la fin de la scène.`, 'Réduire startSec.');
      if (want > to) warnings.push({ code: 'W_SPRITE_CUT', message: `${sc.id}.sprites.${sp.id} : trajet tronqué de ${((want - to) / fps).toFixed(2)} s par la fin de la scène`, at: to / fps });
      sprites.push({
        id: `${sc.id}-${sp.id}`, sceneId: sc.id, from: s0, to: s1,
        frames: sp.frames.map((id) => stage('texture', id)?.rel ?? ''),
        poseFps: sp.poseFps ?? 8, height: Math.round(sp.height * H),
        path: { from: { x: Math.round(sp.path.from.x * W), y: Math.round(sp.path.from.y * H) }, to: { x: Math.round(sp.path.to.x * W), y: Math.round(sp.path.to.y * H) } },
        fadeFrames: Math.round((sp.fadeSec ?? 0.4) * fps),
        // Le personnage le plus bas (le plus proche) passe devant au croisement.
        z: Math.round(Math.max(sp.path.from.y, sp.path.to.y) * 1000),
      });
    }
  }

  // 3. Paroles (position « auto » : côté opposé au sujet déclaré de l'illustration visible)
  const subjectY = (frame: number): number | undefined => {
    const shot = [...shots].reverse().find((s) => frame >= s.from && frame < s.to);
    const src = shot ? shotSource.get(shot.id) : undefined;
    const ss = src ? b.assets.images.find((i) => i.id === src)?.safeSubject : undefined;
    return ss ? ss.y + ss.h / 2 : undefined;
  };
  // Fenêtres des transitions entre scènes (pages tournées…) : un conteneur `sceneBreak` n'y est jamais visible.
  const turns = shots.filter((s, i) => i > 0 && s.enter && shots[i - 1].sceneId !== s.sceneId).map((s) => ({ from: s.from, to: s.from + s.enter!.frames }));
  const { lyrics, fonts } = compileLyrics(b, format, scenes, sync, toF, W, H, fps, safe, stage, warnings, subjectY, turns);

  // 4. Titres
  const titles: RTitle[] = [];
  for (const { sc, from, to } of scenes) {
    if (!sc.title) continue;
    const ts = resolveRef<TitleStyle>('title', sc.title.style ?? 'preset:title-plain')!;
    const fontSize = Math.round((ts.size ?? 0.08) * H);
    const fam = fontFamily(stage, art.fonts?.titles ?? ts.font ?? 'Georgia', fonts);
    const bw = Math.round(safe.title.w * 0.85);
    const lines = fitLines(sc.title.text, fontSize * 0.6, fontSize, bw * 0.9, 2);
    const bh = Math.round(lines.lines.length * lines.fontSize * 1.25 + lines.fontSize * 1.4);
    const y = ts.position === 'upper-third' ? safe.title.y : ts.position === 'lower-third' ? safe.title.y + safe.title.h - bh : Math.round((H - bh) / 2);
    const parch = ts.type === 'parchment' ? b.assets.textures?.[0] : undefined;
    titles.push({
      id: `title-${sc.id}`, from, to: Math.min(to, from + Math.round((sc.title.durationSec ?? 4) * fps)), text: sc.title.text, type: ts.type,
      fontFamily: fam, fontSize: lines.fontSize, color: ts.color ?? art.palette?.text ?? '#FFFFFF',
      box: { x: Math.round((W - bw) / 2), y, w: bw, h: bh }, parchmentSrc: parch ? stage('texture', parch.id)?.rel ?? null : null,
    });
  }

  const rt: RTimeline = {
    version: 1, format, width: W, height: H, fps, durationInFrames: D, assetBaseUrl: '', safe,
    shots, lyrics, titles, fades, effects: { vignette: art.vignette ?? 0, grain: art.grain ?? 0 }, fonts,
  };
  if (effectRanges.length) rt.effectRanges = effectRanges;
  if (sprites.length) rt.sprites = sprites;
  return { timeline: rt, warnings, usage };
}

/** Bornes (images) des plans d'une scène selon le mode de répartition. */
/**
 * Préambule de présentation (project.preroll) : décale de `frames` images TOUS les événements d'une timeline
 * compilée en temps chanson (plans, pulsations, paroles, titres, fondus, effets), allonge la durée d'autant
 * et prolonge le premier plan jusqu'à l'image 0, caméra figée jusqu'au début de son mouvement d'origine.
 * Exception : un fondu d'ouverture (depuis l'image 0) reste ancré au début de la vidéo.
 * Fonction pure ; seul point d'application du préambule côté images (l'export lit `prerollFrames`
 * pour retarder l'audio d'autant : aucun double décalage possible).
 */
export function applyPreroll(t: RTimeline, frames: number): RTimeline {
  if (frames <= 0) return t;
  const sh = (f: number) => f + frames;
  const shots = t.shots.map((s) => ({ ...s, from: sh(s.from), to: sh(s.to), motion: { ...s.motion, start: sh(s.motion.start ?? s.from), ...(s.motion.end !== undefined ? { end: sh(s.motion.end) } : {}), pulseFrames: s.motion.pulseFrames?.map(sh) } }));
  const first = shots.reduce((a, s) => (s.from < a.from ? s : a), shots[0]);
  if (first) first.from = 0;
  return {
    ...t,
    durationInFrames: t.durationInFrames + frames,
    prerollFrames: (t.prerollFrames ?? 0) + frames,
    shots,
    lyrics: t.lyrics.map((l) => ({
      ...l, from: sh(l.from), to: sh(l.to), groupFrom: sh(l.groupFrom), groupTo: sh(l.groupTo), words: l.words.map((w) => ({ ...w, from: sh(w.from), to: sh(w.to) })),
      ...(l.scroll ? { scroll: { ...l.scroll, focusFrom: sh(l.scroll.focusFrom), leaveFrom: sh(l.scroll.leaveFrom) } } : {}),
    })),
    titles: t.titles.map((x) => ({ ...x, from: sh(x.from), to: sh(x.to) })),
    ...(t.sprites ? { sprites: t.sprites.map((s) => ({ ...s, from: sh(s.from), to: sh(s.to) })) } : {}),
    fades: t.fades.map((f) => (f.from === 0 ? f : { ...f, from: sh(f.from), peak: sh(f.peak), to: sh(f.to) })),
    effectRanges: t.effectRanges?.map((r) => ({ ...r, from: r.from === 0 ? 0 : sh(r.from), to: sh(r.to) })),
  };
}

function distribute(sc: Scene, ills: IllustrationRef[], from: number, to: number, actx: AnchorContext, toF: (s: number) => number, lineStarts: number[], analysis: AudioAnalysis, fps: number): number[] {
  const n = ills.length;
  if (n === 1) return [from, to];
  const mode = sc.distribution ?? (ills.some((i) => i.until) ? 'explicit' : 'byLines');
  let cuts: number[] = [];
  if (mode === 'explicit') {
    cuts = ills.slice(0, -1).map((il, i) => (il.until ? toF(resolveAnchor(il.until, actx, `${sc.id}.illustrations[${i}].until`)) : NaN));
    // Les coupes non précisées sont réparties entre leurs voisines.
    for (let i = 0; i < cuts.length; i++) {
      if (!Number.isNaN(cuts[i])) continue;
      const prev = i > 0 ? cuts[i - 1] : from;
      let j = i;
      while (j < cuts.length && Number.isNaN(cuts[j])) j++;
      const next = j < cuts.length ? cuts[j] : to;
      for (let k = i; k < j; k++) cuts[k] = Math.round(prev + ((next - prev) * (k - i + 1)) / (j - i + 1));
    }
  } else {
    const weights = mode === 'weights' ? ills.map((i) => i.weight ?? 1) : ills.map(() => 1);
    const total = weights.reduce((a, w) => a + w, 0);
    let acc = 0;
    const ideal = weights.slice(0, -1).map((w) => (acc += w, from + ((to - from) * acc) / total));
    const beats = analysis.downbeats.map(toF);
    cuts = ideal.map((x) => {
      const pool = mode === 'byLines' && lineStarts.length ? lineStarts : beats;
      let best = Math.round(x);
      let d = (to - from) / (n * 2);
      for (const c of pool) if (Math.abs(c - x) < d) { d = Math.abs(c - x); best = c; }
      return best;
    });
  }
  const minLen = Math.max(2, Math.round(fps * 0.5));
  const all = [from, ...cuts, to];
  for (let i = 1; i < all.length - 1; i++) all[i] = Math.max(all[i - 1] + minLen, Math.min(all[i], to - minLen * (all.length - 1 - i)));
  if (all.some((x, i) => i > 0 && x <= all[i - 1])) throw new NmsvsError('E_TIMELINE_GAP', `Scène ${sc.id} trop courte pour ${n} illustrations.`, 'Réduire le nombre d’illustrations ou allonger la scène.');
  return all;
}

function fontFamily(stage: FileStager, font: string, fonts: RTimeline['fonts']): string {
  if (/\.(ttf|otf|woff2?)$/i.test(font)) {
    const st = stage('font', font);
    if (!st) return 'Georgia';
    const family = `nmsvs-${st.sha.slice(0, 10)}`;
    if (!fonts.some((f) => f.family === family)) fonts.push({ family, src: st.rel, sha256: st.sha });
    return family;
  }
  return font;
}

function compileLyrics(
  b: ProjectBundle, format: string, scenes: { sc: Scene; from: number; to: number }[], sync: SyncResolved, toF: (s: number) => number,
  W: number, H: number, fps: number, safe: { title: RRect }, stage: FileStager, warnings: CompileWarning[],
  subjectY: (frame: number) => number | undefined = () => undefined,
  turns: { from: number; to: number }[] = [],
): { lyrics: RLyric[]; fonts: RTimeline['fonts'] } {
  const art = b.project.art;
  const fonts: RTimeline['fonts'] = [];
  const lines = allLines(b.lyrics);
  const sectionOf = new Map(b.lyrics.sections.map((s) => [s.id, s]));
  const out: RLyric[] = [];
  const artLead = art.lyricLeadSec ?? 0.25;
  const tail = art.lyricTailSec ?? 0.2;
  const timed = new Map<string, TimedLine>(sync.lines.map((l) => [l.id, l]));

  type Item = { line: (typeof lines)[number]; t: TimedLine; style: LyricsStyle; scene: Scene; sl: SceneLyrics };
  const items: Item[] = [];
  for (const line of lines) {
    const t = timed.get(line.id);
    if (!t) continue;
    const sf = toF(t.start);
    const owner = scenes.find((s) => sf >= s.from && sf < s.to) ?? scenes[scenes.length - 1];
    const sl: SceneLyrics = { ...(owner.sc.lyrics ?? {}), ...(owner.sc.formats?.[format]?.lyrics ?? {}) };
    if (sl.style === 'none') continue;
    const ref = line.style ?? (sl.style as LyricsStyle | string | undefined) ?? sectionOf.get(line.sectionId)?.style ?? art.lyricStyle ?? 'preset:lyrics-cartouche-default';
    const style = resolveRef<LyricsStyle>('lyrics', ref as any)!;
    if (style.type === 'none') continue;
    if (sl.karaoke) style.karaoke = sl.karaoke;
    if (sl.position) style.position = sl.position;
    if (sl.lines) style.lines = sl.lines;
    items.push({ line, t, style, scene: owner.sc, sl });
  }

  // Groupes : même scène, même style, écart < 1 s (cartouche) ; parchemin = toute la strophe de la scène.
  const groups: Item[][] = [];
  for (const it of items) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    // Mode « phrase » : le conteneur persiste d'une scène à l'autre (les pages tournent derrière lui) tant que le chant
    // continue ; il ne se referme que sur une pause de plus de 3 s.
    // `sceneBreak` : le conteneur se referme à chaque changement de scène (un parchemin par page).
    const phraseFlow = it.style.flow === 'phrase' && prev?.style.flow === 'phrase' && !(it.style.sceneBreak && prev.scene.id !== it.scene.id);
    const same = prev && (phraseFlow || prev.scene.id === it.scene.id) && JSON.stringify(prev.style) === JSON.stringify(it.style) && (it.style.type !== 'text-on-image' || it.style.flow === 'scroll' || phraseFlow);
    // Défilement : la ligne suivante reste en attente pendant une courte pause (≤ 2 s) ; cartouche : 1 s.
    const close = prev && (phraseFlow ? it.t.start - prev.t.end < 3.0 : it.style.type === 'parchment' ? it.line.sectionId === prev.line.sectionId : it.t.start - prev.t.end < (it.style.flow === 'scroll' ? 2.0 : 1.0));
    if (same && close) g.push(it);
    else groups.push([it]);
  }

  for (const g of groups) {
    const st = g[0].style;
    const lead = st.leadSec ?? artLead;
    const light = st.type !== 'parchment';
    // La police du projet (art.fonts) prime sur celle des presets.
    const fam = fontFamily(stage, art.fonts?.lyrics ?? st.font ?? 'Georgia', fonts);
    const textureId = st.parchment?.texture;
    const tex = textureId ? stage('texture', textureId) : null;
    const rs: RLyricsStyle = {
      type: st.type as RLyricsStyle['type'], fontFamily: fam, weight: st.weight ?? 600,
      color: light ? art.palette?.text ?? st.color ?? '#FFFFFF' : st.parchment?.ink ?? st.color ?? '#3B2412',
      accent: light ? art.palette?.accent ?? st.accent ?? '#F0B429' : st.accent ?? '#7A1F12',
      shadowColor: art.palette?.shadow ?? '#000000B0', align: st.align ?? 'center', karaoke: st.karaoke ?? 'line', enter: st.enter ?? 'fade',
      shadow: st.shadow ?? st.type === 'text-on-image', stroke: st.stroke ?? 0, scrim: st.scrim ?? false,
      panel: { opacity: st.panel?.opacity ?? 0.45, blur: st.panel?.blur ?? 0, radius: st.panel?.radius ?? 0.02, border: st.panel?.border ?? null, color: st.panel?.color ?? '#000000' },
      parchment: { textureSrc: tex?.rel ?? null, orientation: st.parchment?.orientation ?? (W < H ? 'vertical' : 'horizontal'), unrollFrames: Math.round((st.parchment?.unrollSec ?? 0.8) * fps), ink: st.parchment?.ink ?? '#3B2412', float: st.parchment?.float ?? 0.003 },
      leadFrames: Math.round(lead * fps), flow: st.flow ?? 'static',
    };
    const scroll = st.flow === 'scroll' && st.type !== 'parchment';
    // Défilement : deux emplacements (ligne chantée + ligne en attente), quelle que soit l'option `lines`.
    const slots = scroll ? 2 : st.lines ?? 1;
    // Parchemin texturé (bandeau fourni + zone de papier déclarée) : bandeau de largeur fixe (maxWidth × zone sûre),
    // proportions de la texture conservées ; le texte tient dans la zone de papier (une ligne de texte par ligne chantée).
    const paper = st.type === 'parchment' && tex?.w && tex?.h && st.parchment?.paper ? st.parchment.paper : null;
    const texW = paper ? Math.round(safe.title.w * (st.maxWidth ?? 0.9)) : 0;
    const texH = paper ? Math.round((texW * tex!.h!) / tex!.w!) : 0;
    const paperW = paper ? Math.round(paper.w * texW) : 0;
    const paperH = paper ? Math.round(paper.h * texH) : 0;
    // Hauteur utile : `slots` lignes (1,25 em) + interlignes de 0,4 ligne + marge de 0,3 em.
    const fsPaper = paper ? paperH / (slots * 1.25 + (slots - 1) * 0.5 + 0.3) : Infinity;
    const fsMax = Math.min((st.fontSize?.max ?? 0.055) * H, fsPaper);
    const fsMin = Math.min((st.fontSize?.min ?? 0.035) * H, fsMax);
    const boxW = paper ? Math.round(paperW * 0.96) : Math.round(safe.title.w * (st.maxWidth ?? 0.9) * (st.type === 'text-on-image' ? 1 : 0.88));
    const maxLinesPer = paper ? 1 : W < H ? 3 : 2;
    // Taille commune au groupe : la ligne la plus contraignante fixe la taille (largeur stable du cartouche).
    let fontSize = fsMax;
    for (const it of g) {
      const text = it.line.display?.[format] ?? it.line.text;
      fontSize = Math.min(fontSize, fitLines(text, fsMin, fsMax, boxW, maxLinesPer).fontSize);
    }
    const lineHeight = Math.round(fontSize * 1.25);
    const laid = g.map((it) => {
      const text = it.line.display?.[format] ?? it.line.text;
      const f = fitLines(text, fontSize, fontSize, boxW, maxLinesPer);
      if (f.overflow) warnings.push({ code: 'QC-E1', message: `${it.line.id} (${format}) : texte trop long pour la zone sûre`, at: it.t.start });
      return { it, lines: f.lines };
    });
    const blockH = Math.max(...laid.map((l) => l.lines.length)) * lineHeight;
    const totalH = blockH * slots + (slots - 1) * lineHeight * 0.4;
    const padX = paper ? 0 : st.type === 'parchment' ? fontSize * 1.4 : st.type === 'cartouche' ? fontSize * 0.7 : 0;
    // Texturé : texte centré verticalement dans la zone de papier.
    const padY = paper ? Math.max(0, (paperH - totalH) / 2) : st.type === 'parchment' ? fontSize * 1.0 : st.type === 'cartouche' ? fontSize * 0.45 : 0;
    const gw = paper ? paperW : Math.min(safe.title.w, boxW + padX * 2);
    const gh = paper ? Math.max(paperH, totalH) : totalH + padY * 2;
    let pos = st.position ?? 'lower-third';
    if (pos === 'auto') {
      const y = subjectY(toF(g[0].t.start));
      pos = y !== undefined && y > 0.55 ? 'upper-third' : 'lower-third';
    }
    const gy = pos === 'upper-third' ? safe.title.y : pos === 'center' ? Math.round((H - gh) / 2) : safe.title.y + safe.title.h - gh;
    // Centrage horizontal dans la zone sûre (et non dans le cadre) : les zones sûres sociales 9:16 sont asymétriques
    // (marge droite élargie pour les boutons des plateformes). Identique au centrage cadre si la zone est symétrique.
    // `centerX` : centre imposé (ex. page d'un livre décalée par sa reliure), texte et bandeau déplacés ensemble.
    const cx = st.centerX !== undefined ? st.centerX * W : safe.title.x + safe.title.w / 2;
    const groupBox: RRect = { x: Math.round(cx - gw / 2), y: Math.round(gy), w: Math.round(gw), h: Math.round(gh) };
    const panelBox: RRect | undefined = paper ? { x: Math.round(groupBox.x - paper.x * texW), y: Math.round(groupBox.y - paper.y * texH), w: texW, h: texH } : undefined;
    if (groupBox.y < safe.title.y - 1 || groupBox.y + groupBox.h > safe.title.y + safe.title.h + 1) {
      warnings.push({ code: 'QC-E1', message: `groupe ${g[0].line.id} (${format}) dépasse la zone sûre verticalement`, at: g[0].t.start });
    }
    if (groupBox.x < safe.title.x - 1 || groupBox.x + groupBox.w > safe.title.x + safe.title.w + 1) {
      warnings.push({ code: 'QC-E1', message: `groupe ${g[0].line.id} (${format}) dépasse la zone sûre horizontalement`, at: g[0].t.start });
    }
    let unroll = st.type === 'parchment' ? rs.parchment.unrollFrames : 0;
    let groupFrom = Math.max(0, toF(g[0].t.start - lead) - unroll);
    let groupTo = toF(g[g.length - 1].t.end + tail) + (st.type === 'parchment' ? Math.round(unroll * 0.7) : 0);
    if (st.sceneBreak) {
      // Absent pendant les transitions de scène : ouverture repoussée après la transition qui précède le premier chant
      // (déroulé raccourci si la voix entre aussitôt, sans retarder le texte), fermeture achevée au début de la suivante.
      const firstF = toF(g[0].t.start - lead);
      const before = turns.find((w) => w.from <= firstF && w.to > groupFrom);
      if (before) {
        groupFrom = before.to;
        if (unroll > 0) {
          unroll = Math.max(3, Math.min(unroll, firstF - groupFrom));
          rs.parchment = { ...rs.parchment, unrollFrames: unroll };
        }
      }
      const after = turns.find((w) => w.from > groupFrom && w.from < groupTo);
      if (after) groupTo = after.from;
    }
    // Mode « phrase » : découpage en phrases (fin de phrase ou `slots` lignes atteintes) ; index de la 1re ligne de chaque phrase.
    const phrase = st.flow === 'phrase' && !scroll ? phrasesOf(g.map((it) => it.line.text), slots) : null;
    laid.forEach(({ it, lines: ls }, i) => {
      let slot = i % slots;
      let from = Math.max(groupFrom, toF(it.t.start - lead));
      // Affichage par paires (lignes 1+2, puis 3+4…) : l'ordre de lecture haut→bas est toujours respecté.
      const nextSame = g[(Math.floor(i / slots) + 1) * slots];
      const nextAny = g[i + 1];
      let to = toF(it.t.end + tail);
      if (slots > 1 && nextSame) to = toF(nextSame.t.start - lead);
      else if (slots > 1) to = groupTo;
      if (slots === 1 && nextAny) to = Math.min(to, toF(nextAny.t.start - lead));
      if (phrase) {
        // Une phrase à la fois : chaque ligne apparaît à son propre chant (révélation progressive) et toute la phrase
        // s'efface au départ de la phrase suivante. Une phrase d'une seule ligne est centrée dans le conteneur.
        const p = phrase[i];
        slot = p.len === 1 ? (slots - 1) / 2 : p.pos;
        const nextPhrase = g[p.first + p.len];
        to = nextPhrase ? toF(nextPhrase.t.start - lead) : groupTo;
      }
      if (st.sceneBreak) {
        // Ligne chantée pendant une page tournée : non affichée (le conteneur est fermé), synchronisation inchangée.
        if (from >= groupTo) {
          warnings.push({ code: 'I_TURN_HIDDEN', message: `${it.line.id} chantée pendant une transition de scène : non affichée`, at: it.t.start });
          return;
        }
        to = Math.min(to, groupTo);
      }
      to = Math.max(to, from + 1);
      let y = groupBox.y + padY + slot * (blockH + lineHeight * 0.4) + (blockH - ls.length * lineHeight) / 2;
      let scrollInfo: RLyric['scroll'];
      if (scroll) {
        // La ligne i apparaît en attente (emplacement bas) quand la ligne i−1 prend le premier plan,
        // monte au premier plan à son propre départ (début − avance), puis s'efface vers le haut au départ de i+1.
        const focusFrom = Math.max(groupFrom, toF(it.t.start - lead));
        const prevFocus = i > 0 ? Math.max(groupFrom, toF(g[i - 1].t.start - lead)) : focusFrom;
        const next = g[i + 1];
        const leaveFrom = next ? Math.max(focusFrom + 1, toF(next.t.start - lead)) : groupTo;
        from = prevFocus;
        to = next ? leaveFrom : groupTo; // la sortie se joue sur les SCROLL_FRAMES images qui précèdent leaveFrom
        y = groupBox.y + padY + (blockH - ls.length * lineHeight) / 2;
        scrollInfo = { focusFrom, leaveFrom, gap: Math.round(blockH + lineHeight * 0.4), last: !next };
      }
      // Mots : correspondance par position avec les mots synchronisés.
      const tokens = ls.flatMap((l, li) => l.split(/\s+/).filter(Boolean).map((w) => ({ w, li })));
      const tw = it.t.words;
      const words = tokens.map((tok, k) => {
        const src = tokens.length === tw.length ? tw[k] : tw[Math.min(tw.length - 1, Math.floor((k * tw.length) / tokens.length))];
        return { text: tok.w, from: toF(src.start), to: Math.max(toF(src.start) + 1, toF(src.end)), line: tok.li };
      });
      // Karaoké au mot seulement si les mots sont appariés et leurs timings plausibles : un mot de moins de 80 ms
      // (ou de durée nulle) trahit un alignement dégénéré → mise en évidence de la ligne entière.
      const degenerate = tw.some((w) => w.end - w.start < 0.08);
      if (rs.karaoke === 'word' && degenerate) warnings.push({ code: 'I_KARAOKE_LINE', message: `${it.line.id} : timings de mots dégénérés → karaoké par ligne`, at: it.t.start });
      const style = tokens.length === tw.length && !degenerate ? rs : { ...rs, karaoke: rs.karaoke === 'word' ? ('line' as const) : rs.karaoke };
      const dur = (it.t.end - it.t.start);
      if (dur < 1.0) warnings.push({ code: 'QC-E2', message: `${it.line.id} affichée ${dur.toFixed(2)} s (< 1 s)`, at: it.t.start });
      else if (it.line.text.length / dur > 17) warnings.push({ code: 'QC-E2', message: `${it.line.id} : ${(it.line.text.length / dur).toFixed(1)} car./s (> 17)`, at: it.t.start });
      out.push({
        id: it.line.id, sceneId: it.scene.id, from, to, lines: ls, words, style, fontSize: Math.round(fontSize), lineHeight,
        box: { x: Math.round(cx - boxW / 2), y: Math.round(y), w: boxW, h: Math.round(ls.length * lineHeight) },
        groupId: `${g[0].line.id}-g`, groupFrom, groupTo, groupBox, ...(panelBox ? { panelBox } : {}), ...(scrollInfo ? { scroll: scrollInfo } : {}),
      });
    });
  }
  // Un conteneur (parchemin qui s'enroule, cartouche qui disparaît) ne doit pas chevaucher le groupe suivant.
  const groupIds = [...new Set(out.map((l) => l.groupId))];
  for (let i = 0; i < groupIds.length - 1; i++) {
    const cur = out.filter((l) => l.groupId === groupIds[i]);
    const nextFrom = out.find((l) => l.groupId === groupIds[i + 1])!.groupFrom;
    if (cur[0].groupTo > nextFrom) {
      const end = Math.max(cur[0].groupFrom + 1, nextFrom);
      for (const l of cur) {
        l.groupTo = end;
        l.to = Math.min(l.to, end);
        if (l.to <= l.from) l.to = l.from + 1;
      }
    }
  }
  return { lyrics: out, fonts };
}

/**
 * Découpage en phrases pour le mode `flow: 'phrase'` : une phrase se termine sur une ponctuation finale
 * (. ! ?, éventuellement suivie d'un guillemet ou d'une parenthèse) ou quand elle atteint `max` lignes.
 * Points de suspension : fin de phrase seulement si la ligne suivante commence par une majuscule ou un tiret
 * de dialogue (« — Eh bien… / on y va. » reste une seule phrase).
 * Renvoie, pour chaque ligne, l'index de la première ligne de sa phrase, sa position et la longueur de la phrase.
 */
export function phrasesOf(texts: string[], max: number): { first: number; pos: number; len: number }[] {
  const out: { first: number; pos: number; len: number }[] = [];
  let first = 0;
  const ends = (t: string, next: string | undefined) =>
    /[.!?]["»”)\s]*$/.test(t.trim()) || (/(…|\.\.\.)["»”)\s]*$/.test(t.trim()) && (next === undefined || /^[\p{Lu}—–-]/u.test(next.trim())));
  texts.forEach((t, i) => {
    const pos = i - first;
    out.push({ first, pos, len: 0 });
    if (ends(t, texts[i + 1]) || pos + 1 >= max || i === texts.length - 1) {
      for (let k = first; k <= i; k++) out[k].len = i - first + 1;
      first = i + 1;
    }
  });
  return out;
}

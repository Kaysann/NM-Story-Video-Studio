import fs from 'node:fs';
import path from 'node:path';
import { NmsvsError } from '../../core/errors';
import { backupFile, ensureDir, readJson, readJsonIfExists, writeFileAtomic, writeJsonAtomic } from '../../core/fsx';
import { ffmpeg } from '../../core/tools';
import type { RunContext } from '../../core/context';
import { resolveRef } from '../../model/presets';
import { assertValid } from '../../model/schemas';
import { FILES, projectPath, type ProjectBundle } from '../../model/project';
import type { AudioAnalysis, Candidate, ReelClosing, ReelsFile, TimelineFile } from '../../model/types';
import type { RTimeline } from '../../remotion/types';
import { analysisFile, analyzeAudio, nearest } from '../analysis/analyze';
import { addDecision } from '../project/init';
import { loadResolvedSync, resolveShortsSync } from '../sync/sync';
import { composeTimeline } from '../timeline/compose';
import { buildTimeline } from '../timeline/build';
import type { CompileWarning } from '../timeline/compile';
import { exportTimeline, loadProfile, type ExportResult } from '../export/export';
import { renderSettings } from '../render/render';
import { CRITERIA, CRITERIA_LABELS, generateCandidates, selectDiverse, type Criterion } from './candidates';
import { appendClosing } from './closing';
import { proposalDetails, proposalMarkdown } from './proposal';

export const candidatesFile = (dir: string) => path.join(dir, 'analysis', 'reels.candidates.json');
const DISCLAIMER = 'Ce classement reflète les critères musicaux et textuels choisis ; il ne constitue pas une prévision d’audience ni de performance sur les réseaux sociaux.';

function reelsParams(b: ProjectBundle) {
  const p = b.reels?.params ?? {};
  const weights = resolveRef<Record<string, number>>('reels-weights', (p.weights as any) ?? 'preset:reels-balanced')!;
  return { durations: p.durations ?? [20, 30, 45], count: p.count ?? 5, maxOverlap: p.maxOverlap ?? 0.35, lambda: p.lambda ?? 0.7, weights };
}

/** Propositions SEULEMENT : aucun Short n'est produit. Extraits audio d'écoute uniquement si `audio` (sur demande). */
export async function analyzeReels(ctx: RunContext, b: ProjectBundle, opts: { audio?: boolean } = {}): Promise<{ candidates: Candidate[]; poolSize: number; reportFile: string }> {
  const analysis = await analyzeAudio(ctx, b);
  const sync = loadResolvedSync(ctx, b);
  const prm = reelsParams(b);
  const all = generateCandidates({ analysis, sync, lyrics: b.lyrics, title: b.lyrics.title ?? b.project.title, durations: prm.durations, weights: prm.weights as Partial<Record<Criterion, number>> });
  if (!all.length) throw new NmsvsError('E_REELS', 'Aucun extrait admissible trouvé.', 'Vérifier la synchronisation et les durées demandées (reels.json → params.durations).');
  const picked = selectDiverse(all, prm.count, prm.maxOverlap, prm.lambda, prm.durations);
  if (picked.length < prm.count) ctx.warn('W_REELS_FEW', `Seulement ${picked.length} extrait(s) satisfont les contraintes de diversité.`);
  writeJsonAtomic(candidatesFile(b.dir), { version: 1, generatedFrom: { audioSha256: analysis.audioSha256, engine: sync.engine }, params: prm, poolSize: all.length, candidates: picked, disclaimer: DISCLAIMER });
  ctx.persist();
  const prevDir = path.join(ctx.dir, 'reels');
  const master = projectPath(b, b.project.audio.master);
  if (opts.audio) ensureDir(prevDir);
  for (const c of opts.audio ? picked : []) {
    // Mêmes fondus que la production (project.reels.fadeInSec / fadeOutSec) : l'écoute reflète le Short.
    const fi = b.project.reels?.fadeInSec ?? 0.1;
    const fo = b.project.reels?.fadeOutSec ?? 0.8;
    await ffmpeg(['-ss', c.start.toFixed(3), '-t', c.duration.toFixed(3), '-i', master, '-vn', '-af', `afade=t=in:d=${fi},afade=t=out:st=${Math.max(0, c.duration - fo).toFixed(3)}:d=${fo}`, '-c:a', 'aac', '-b:a', '192k', path.join(prevDir, `${c.id}.m4a`)]);
  }
  const reportFile = path.join(ctx.dir, 'reels.md');
  const details = proposalDetails(b, picked, sync, analysis);
  writeJsonAtomic(path.join(ctx.dir, 'reels.proposals.json'), details);
  writeFileAtomic(reportFile, reelsMarkdown(b, picked, all.length, sync.engine, !!opts.audio) + proposalMarkdown(details));
  ctx.artifacts.push(reportFile);
  return { candidates: picked, poolSize: all.length, reportFile };
}

export function reelsMarkdown(b: ProjectBundle, cands: Candidate[], pool: number, engine: string, audio = false): string {
  const f = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  let md = `# Propositions de Reels — ${b.project.title}\n\n> ${DISCLAIMER}\n\n${pool} extraits admissibles évalués ; ${cands.length} retenus après diversification (MMR).${engine === 'uniform' ? '\n\n> ⚠ Synchronisation **uniforme** (non issue de l’audio) : les critères textuels sont approximatifs.' : ''}\n\n`;
  md += '| Rang | ID | Début → fin | Durée | Section(s) | Score | Points forts | Points faibles |\n|---|---|---|---|---|---|---|---|\n';
  md += cands.map((c) => `| ${c.rank} | ${c.id} | ${f(c.start)} → ${f(c.end)} | ${c.duration.toFixed(1)} s | ${c.sections.join(', ')} | ${c.score.toFixed(2)} | ${c.strengths.join('<br>') || '—'} | ${c.weaknesses.join('<br>') || '—'} |`).join('\n');
  md += `\n\n## Détail des critères\n\n| ID | ${CRITERIA.map((c) => CRITERIA_LABELS[c]).join(' | ')} |\n|---|${CRITERIA.map(() => '---').join('|')}|\n`;
  md += cands.map((c) => `| ${c.id} | ${CRITERIA.map((k) => c.criteria[k].toFixed(2)).join(' | ')} |`).join('\n');
  md += `\n\n## Justifications\n\n${cands.map((c) => `- **${c.id}** — ${c.justification}`).join('\n')}\n\n${audio ? 'Extraits audio : \`reels/<id>.m4a\` dans ce dossier.' : 'Extraits audio non produits (sur demande : \`nmsvs reels analyze --audio\`).'}\n\n## Sélection\n\n**Aucun Short n’est produit avant la sélection explicite de l’utilisateur.** Puis : \`nmsvs reels select cand-1 cand-3 --name cand-1=refrain-final\` et \`nmsvs reels build\` (tous les Shorts retenus en une campagne).\n`;
  return md;
}

export function selectReels(b: ProjectBundle, ids: string[], names: Record<string, string>, adjust: Record<string, { startSec?: number; endSec?: number }>, noSnap: boolean) {
  const cf = readJsonIfExists<{ candidates: Candidate[] }>(candidatesFile(b.dir));
  if (!cf) throw new NmsvsError('E_REELS', 'Aucune proposition de Reels.', 'Lancer `nmsvs reels analyze`.');
  for (const id of ids) if (!cf.candidates.some((c) => c.id === id)) throw new NmsvsError('E_ARGS', `Candidat inconnu : ${id} (${cf.candidates.map((c) => c.id).join(', ')})`);
  const file = path.join(b.dir, FILES.reels);
  const reels: ReelsFile = readJsonIfExists<ReelsFile>(file) ?? { schemaVersion: 1, selection: [] };
  reels.selection = ids.map((id) => {
    const s: ReelsFile['selection'][number] = { candidate: id };
    if (names[id]) s.name = names[id];
    if (adjust[id]) s.adjust = adjust[id];
    if (noSnap) s.snap = false;
    return s;
  });
  assertValid('reels', reels, file);
  backupFile(file);
  writeJsonAtomic(file, reels);
  b.reels = reels;
  addDecision(b.dir, { by: 'user', via: 'nmsvs reels select', scope: 'reels', decision: `Extraits retenus : ${ids.map((i) => (names[i] ? `${i} (${names[i]})` : i)).join(', ')}` });
  return reels.selection;
}

/** Décale une timeline résolue de -F0 et la restreint à [0, D) (le mouvement des plans est conservé). */
export function sliceTimeline(t: RTimeline, f0: number, f1: number): RTimeline {
  const D = f1 - f0;
  const sh = <T extends { from: number; to: number }>(x: T): T => ({ ...x, from: x.from - f0, to: x.to - f0 });
  const shots = t.shots.filter((s) => s.to > f0 && s.from < f1).map((s) => ({ ...sh(s), motion: { ...s.motion, pulseFrames: s.motion.pulseFrames?.map((p) => p - f0) } }));
  const lyrics = t.lyrics.filter((l) => l.groupTo > f0 && l.groupFrom < f1).map((l) => ({
    ...sh(l), groupFrom: l.groupFrom - f0, groupTo: l.groupTo - f0, words: l.words.map((w) => ({ ...w, from: w.from - f0, to: w.to - f0 })),
    ...(l.scroll ? { scroll: { ...l.scroll, focusFrom: l.scroll.focusFrom - f0, leaveFrom: l.scroll.leaveFrom - f0 } } : {}),
  }));
  return {
    ...t, durationInFrames: D, shots, lyrics,
    titles: t.titles.filter((x) => x.to > f0 && x.from < f1).map(sh),
    ...(t.sprites ? { sprites: t.sprites.filter((s) => s.to > f0 && s.from < f1).map(sh) } : {}),
    fades: t.fades.filter((x) => x.to > f0 && x.from < f1).map((x) => ({ ...x, from: x.from - f0, peak: x.peak - f0, to: x.to - f0 })),
    effectRanges: t.effectRanges?.filter((r) => r.to > f0 && r.from < f1).map(sh),
  };
}

/** Bundle des Shorts : style de paroles dédié ; timeline = option ou params.timeline, sinon celle du clip, sinon composition auto. */
async function shortsBundle(ctx: RunContext, b: ProjectBundle, analysis: AudioAnalysis, timelinePath?: string): Promise<ProjectBundle> {
  const rb: ProjectBundle = { ...b, project: { ...b.project, art: { ...b.project.art, lyricStyle: b.project.reels?.lyricStyle ?? b.project.art.lyricStyle } } };
  const rel = timelinePath ?? b.reels?.params?.timeline;
  if (rel) {
    const file = path.isAbsolute(rel) ? rel : path.join(b.dir, rel);
    if (!fs.existsSync(file)) throw new NmsvsError('E_ASSET_MISSING', `Timeline des Shorts introuvable : ${rel}`, 'Vérifier reels.json → params.timeline.');
    const tl = readJson<TimelineFile>(file);
    assertValid('timeline', tl, file);
    rb.timeline = tl;
    ctx.log.info(`Timeline des Shorts : ${path.relative(b.dir, file)}`);
  } else if (!rb.timeline) {
    const sync = loadResolvedSync(ctx, b);
    rb.timeline = composeTimeline(rb, sync, analysis).timeline;
    ctx.log.info('Pas de timeline.json : composition automatique en mémoire pour les Reels (non enregistrée).');
  }
  return rb;
}

interface OneReel { start: number; end: number; name: string; baseName: string; title: string }

/** Durée de musique d'un Short fermé : jusqu'à la fin de l'extrait (`stop`, défaut) ou toute la vidéo (`continue` → undefined). */
export function closingAudioSec(c: ReelClosing, musicFrames: number, fps: number): number | undefined {
  return c.audio === 'continue' ? undefined : musicFrames / fps;
}

/** Rendu + export d'un extrait [start, end) (temps chanson) d'une timeline résolue sans préambule. */
async function exportOne(ctx: RunContext, b: ProjectBundle, built: { timeline: RTimeline; warnings: CompileWarning[] }, p: ReturnType<typeof loadProfile>, profileId: string, r: OneReel, replace = false): Promise<ExportResult> {
  const fps = b.project.fps;
  const f0 = Math.round(r.start * fps);
  const f1 = Math.round(r.end * fps);
  const fadeOut = b.project.reels?.fadeOutSec ?? 0.8;
  let t = sliceTimeline(built.timeline, f0, f1);
  const closing = b.reels?.params?.closing;
  let audioDurSec: number | undefined;
  if (closing) {
    // Fermeture après la musique (reels.json → params.closing) : l'audio s'arrête avec la musique, la vidéo se termine sur l'image.
    const c = appendClosing(t, built.timeline, closing);
    t = c.timeline;
    // `audio: continue` : le master se poursuit sous la fermeture (pas de silence final), fondu audio sur la fin de la vidéo.
    audioDurSec = closingAudioSec(closing, c.musicFrames, fps);
    ctx.log.info(`Fermeture : ${((t.durationInFrames - c.musicFrames) / fps).toFixed(2)} s après l’extrait, vers ${closing.scene}${closing.audio === 'continue' ? ' (musique poursuivie)' : ''}`);
  } else if (fadeOut > 0) {
    // Fondu image de fin, synchrone avec le fondu audio.
    t.fades = [...t.fades, { from: Math.max(0, t.durationInFrames - Math.round(fadeOut * fps)), peak: t.durationInFrames - 1, to: t.durationInFrames, color: '#000000' }];
  }
  if (b.project.reels?.titleCard) {
    const fsz = Math.round(t.height * 0.05);
    t.titles = [...t.titles, { id: 'reel-title', from: 0, to: Math.round(2 * fps), text: b.project.title, type: 'plain', fontFamily: 'Georgia', fontSize: fsz, color: '#FFFFFF', box: { x: t.safe.title.x, y: t.safe.title.y, w: t.safe.title.w, h: fsz * 3 }, parchmentSrc: null }];
  }
  const warnings = built.warnings.filter((w) => w.at === undefined || (w.at >= r.start && w.at < r.end));
  ctx.log.info(`Reel « ${r.name} » : ${r.start.toFixed(2)} → ${r.end.toFixed(2)} s`);
  return exportTimeline(ctx, b, t, warnings, p, profileId, `reel-${r.name}`, r.baseName, {
    settings: renderSettings(), startSec: r.start, audioDurSec, fadeInSec: b.project.reels?.fadeInSec ?? 0.1, fadeOutSec: fadeOut, title: r.title, replace,
  });
}

export async function buildReels(ctx: RunContext, b: ProjectBundle, opts: { profile?: string; only?: string[]; replace?: boolean } = {}): Promise<ExportResult[]> {
  const cf = readJsonIfExists<{ candidates: Candidate[] }>(candidatesFile(b.dir));
  const sel = (b.reels?.selection ?? []).filter((s) => !opts.only || opts.only.includes(s.candidate) || (s.name && opts.only.includes(s.name)));
  if (!cf || !sel.length) throw new NmsvsError('E_REELS', 'Aucun extrait sélectionné.', '`nmsvs reels analyze` puis `nmsvs reels select <ids>` (choix humain).');
  const profileId = opts.profile ?? 'reel-1080-h264';
  const p = loadProfile(profileId);
  const fmt = b.project.reels?.format ?? p.format;
  if (!b.project.formats[fmt]) throw new NmsvsError('E_ARGS', `Format ${fmt} absent du projet.`);
  const analysis = readJson<AudioAnalysis>(analysisFile(b.dir));
  const rb = await shortsBundle(ctx, b, analysis);
  const built = await buildTimeline(ctx, rb, fmt, { preroll: false, sync: resolveShortsSync(ctx, b) }); // extraits en temps chanson
  const results: ExportResult[] = [];
  for (const s of sel) {
    const c = cf.candidates.find((x) => x.id === s.candidate);
    if (!c) throw new NmsvsError('E_REELS', `Candidat ${s.candidate} absent des propositions actuelles.`, 'Relancer `nmsvs reels analyze` puis `reels select`.');
    let start = c.start + (s.adjust?.startSec ?? 0);
    let end = c.end + (s.adjust?.endSec ?? 0);
    if (s.snap !== false && (s.adjust?.startSec || s.adjust?.endSec)) {
      start = nearest(analysis.beats, start, 0.15);
      end = nearest(analysis.beats, end, 0.15);
    }
    start = Math.max(0, start);
    end = Math.min(analysis.durationSec, end);
    const name = s.name ?? s.candidate;
    results.push(await exportOne(ctx, b, built, p, profileId, { start, end, name, baseName: `${b.project.id}-reel-${name}`, title: `${b.project.title} — ${name}` }, opts.replace));
  }
  addDecision(b.dir, { by: 'engine', via: 'nmsvs reels build', scope: 'reels', decision: `Reels produits : ${results.map((r) => path.basename(r.file)).join(', ')}` });
  return results;
}

/**
 * Essai technique d'un Short sur un candidat, SANS sélection : reels.json n'est pas modifié et la décision
 * est consignée comme essai du moteur (jamais comme choix de l'utilisateur). `window` restreint à une partie
 * de l'extrait (prévisualisation de styles) ; `timeline` remplace la timeline des Shorts pour cet essai.
 */
export async function tryReel(ctx: RunContext, b: ProjectBundle, candidate: string, opts: { profile?: string; timeline?: string; window?: { from?: number; to?: number }; label?: string; replace?: boolean } = {}): Promise<ExportResult> {
  const cf = readJsonIfExists<{ candidates: Candidate[] }>(candidatesFile(b.dir));
  const c = cf?.candidates.find((x) => x.id === candidate);
  if (!c) throw new NmsvsError('E_REELS', `Candidat ${candidate} absent des propositions actuelles.`, 'Lancer `nmsvs reels analyze`.');
  const profileId = opts.profile ?? 'reel-1080-h264';
  const p = loadProfile(profileId);
  const fmt = b.project.reels?.format ?? p.format;
  if (!b.project.formats[fmt]) throw new NmsvsError('E_ARGS', `Format ${fmt} absent du projet.`);
  const analysis = readJson<AudioAnalysis>(analysisFile(b.dir));
  const rb = await shortsBundle(ctx, b, analysis, opts.timeline);
  const built = await buildTimeline(ctx, rb, fmt, { preroll: false, sync: resolveShortsSync(ctx, b) });
  const start = Math.max(0, opts.window?.from ?? c.start);
  const end = Math.min(analysis.durationSec, opts.window?.to ?? c.end);
  if (end - start < 1) throw new NmsvsError('E_ARGS', `Fenêtre trop courte (${start.toFixed(2)} → ${end.toFixed(2)} s).`);
  const name = `try-${candidate}${opts.label ? `-${opts.label}` : ''}`;
  const res = await exportOne(ctx, b, built, p, profileId, { start, end, name, baseName: `${b.project.id}-${name}`, title: `${b.project.title} — essai ${candidate}` }, opts.replace);
  addDecision(b.dir, { by: 'engine', via: 'nmsvs reels build --try', scope: 'reels', decision: `Essai technique (non validé artistiquement, aucune sélection enregistrée) : ${candidate} ${start.toFixed(2)} → ${end.toFixed(2)} s → ${path.basename(res.file)}` });
  return res;
}

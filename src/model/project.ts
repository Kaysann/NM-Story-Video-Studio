import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ID_RE } from '../core/paths';
import { withCredits } from './credits';
import { NmsvsError } from '../core/errors';
import { readJson, readJsonIfExists, exists } from '../core/fsx';
import { validate, type ValidationIssue } from './schemas';
import type { AssetsFile, LyricsFile, ProjectFile, ReelsFile, SyncOverridesFile, TimelineFile, LyricsLine, TimeAnchor } from './types';

export const FILES = {
  project: 'project.json',
  assets: 'assets.json',
  timeline: 'timeline.json',
  overrides: 'sync.overrides.json',
  reels: 'reels.json',
  decisions: 'decisions.jsonl',
  references: 'reference.timings.json',
} as const;

export interface ProjectBundle {
  dir: string;
  project: ProjectFile;
  assets: AssetsFile;
  lyrics: LyricsFile;
  timeline?: TimelineFile;
  overrides: SyncOverridesFile;
  reels?: ReelsFile;
}

/** Trouve le dossier projet : chemin explicite, slug sous projects/, variable NMSVS_PROJECT, ou dossier courant. */
export function findProjectDir(arg?: string): string {
  const candidates: string[] = [];
  const a = arg ?? process.env.NMSVS_PROJECT;
  if (a) {
    candidates.push(path.resolve(a));
    candidates.push(path.join(PATHS.projects, a));
  } else {
    let d = process.cwd();
    for (let i = 0; i < 6; i++) {
      candidates.push(d);
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  for (const c of candidates) if (exists(path.join(c, FILES.project))) return c;
  throw new NmsvsError('E_PROJECT_NOT_FOUND', `Projet introuvable${a ? ` : « ${a} »` : ' depuis le dossier courant'}.`, 'Utiliser `--project <slug>` ou `nmsvs init <slug>`.');
}

/** Chemin d'un fichier du projet ; un chemin absolu (médias lus en place, ex. générique commun) est rendu tel quel. */
export function projectPath(b: { dir: string }, rel: string) {
  return path.isAbsolute(rel) ? path.normalize(rel) : path.join(b.dir, ...rel.split('/'));
}

export function loadProject(dir: string, opts: { requireTimeline?: boolean } = {}): ProjectBundle {
  const issues = validateProjectFiles(dir);
  if (issues.length) {
    const txt = issues.slice(0, 15).map((i) => `  ${i.file} ${i.path} : ${i.message}`).join('\n');
    throw new NmsvsError('E_SCHEMA', `Projet invalide (${issues.length} problème(s)) :\n${txt}`, 'Corriger puis relancer `nmsvs validate`.', issues);
  }
  const project = readJson<ProjectFile>(path.join(dir, FILES.project));
  const b: ProjectBundle = {
    dir,
    project,
    assets: readJson<AssetsFile>(path.join(dir, FILES.assets)),
    lyrics: readJson<LyricsFile>(path.join(dir, ...project.lyrics.split('/'))),
    timeline: readJsonIfExists<TimelineFile>(path.join(dir, FILES.timeline)),
    overrides: readJsonIfExists<SyncOverridesFile>(path.join(dir, FILES.overrides)) ?? { schemaVersion: 1 },
    reels: readJsonIfExists<ReelsFile>(path.join(dir, FILES.reels)),
  };
  if (opts.requireTimeline && !b.timeline) {
    throw new NmsvsError('E_ASSET_MISSING', 'timeline.json absent.', 'Lancer `nmsvs compose` pour générer une proposition.');
  }
  // Générique réutilisable appelé par la timeline : scènes et assets virtuels ajoutés en mémoire uniquement.
  const c = withCredits(dir, b.timeline, b.assets);
  b.timeline = c.timeline;
  b.assets = c.assets;
  return b;
}

export interface FileIssue extends ValidationIssue { file: string }

/** Validation schéma + cohérence référentielle (ids uniques, références existantes). */
export function validateProjectFiles(dir: string): FileIssue[] {
  const issues: FileIssue[] = [];
  const check = (file: string, schema: string, optional = false): any => {
    const p = path.join(dir, ...file.split('/'));
    if (!fs.existsSync(p)) {
      if (!optional) issues.push({ file, path: '/', message: 'fichier manquant' });
      return undefined;
    }
    let data: any;
    try {
      data = readJson(p);
    } catch (e) {
      issues.push({ file, path: '/', message: (e as Error).message });
      return undefined;
    }
    for (const i of validate(schema, data)) issues.push({ file, ...i });
    return data;
  };
  const project = check(FILES.project, 'project') as ProjectFile | undefined;
  const assets = check(FILES.assets, 'assets') as AssetsFile | undefined;
  const lyrics = project ? (check(project.lyrics, 'lyrics') as LyricsFile | undefined) : undefined;
  const timeline = check(FILES.timeline, 'timeline', true) as TimelineFile | undefined;
  check(FILES.overrides, 'sync-overrides', true);
  const reels = check(FILES.reels, 'reels', true) as { params?: { syncOverrides?: string } } | undefined;
  if (reels?.params?.syncOverrides) check(reels.params.syncOverrides, 'sync-overrides', true);
  if (issues.length) return issues;

  // Cohérence
  const dup = (arr: string[]) => arr.filter((x, i) => arr.indexOf(x) !== i);
  const imageIds = assets!.images.map((i) => i.id);
  for (const d of dup(imageIds)) issues.push({ file: FILES.assets, path: '/images', message: `identifiant dupliqué « ${d} »` });
  for (const img of assets!.images) {
    if (!fs.existsSync(path.join(dir, ...img.path.split('/')))) issues.push({ file: FILES.assets, path: `/images/${img.id}`, message: `fichier image absent : ${img.path}` });
    for (const [fmt, rep] of Object.entries(img.replace ?? {})) {
      if (!imageIds.includes(rep)) issues.push({ file: FILES.assets, path: `/images/${img.id}/replace/${fmt}`, message: `image de remplacement inconnue « ${rep} »` });
    }
  }
  if (!fs.existsSync(path.join(dir, ...project!.audio.master.split('/')))) {
    issues.push({ file: FILES.project, path: '/audio/master', message: `fichier audio absent : ${project!.audio.master}` });
  }
  const sectionIds = lyrics!.sections.map((s) => s.id);
  for (const d of dup(sectionIds)) issues.push({ file: project!.lyrics, path: '/sections', message: `section dupliquée « ${d} »` });
  const lineIds: string[] = [];
  for (const s of lyrics!.sections) {
    for (const l of s.lines) {
      lineIds.push(l.id);
      if (!l.id.startsWith(`${s.id}.l`)) issues.push({ file: project!.lyrics, path: `/sections/${s.id}`, message: `la ligne « ${l.id} » doit commencer par « ${s.id}.l »` });
    }
  }
  for (const d of dup(lineIds)) issues.push({ file: project!.lyrics, path: '/sections', message: `ligne dupliquée « ${d} »` });

  if (timeline) {
    const sceneIds = timeline.scenes.map((s) => s.id);
    for (const d of dup(sceneIds)) issues.push({ file: FILES.timeline, path: '/scenes', message: `scène dupliquée « ${d} »` });
    const checkAnchor = (a: TimeAnchor, where: string) => {
      if ('section' in a && !sectionIds.includes(a.section)) issues.push({ file: FILES.timeline, path: where, message: `section inconnue « ${a.section} »` });
      if ('line' in a && !lineIds.includes(a.line)) issues.push({ file: FILES.timeline, path: where, message: `ligne inconnue « ${a.line} »` });
      if ('word' in a && !lineIds.includes(a.word.replace(/\.w\d+$/, ''))) issues.push({ file: FILES.timeline, path: where, message: `mot inconnu « ${a.word} »` });
    };
    for (const sc of timeline.scenes) {
      checkAnchor(sc.span.from, `/scenes/${sc.id}/span/from`);
      checkAnchor(sc.span.to, `/scenes/${sc.id}/span/to`);
      const ills = [...sc.illustrations, ...Object.values(sc.formats ?? {}).flatMap((f) => f.illustrations ?? [])];
      for (const il of ills) {
        if (!imageIds.includes(il.asset)) issues.push({ file: FILES.timeline, path: `/scenes/${sc.id}`, message: `illustration inconnue « ${il.asset} »` });
        if (il.foreground && !imageIds.includes(il.foreground)) issues.push({ file: FILES.timeline, path: `/scenes/${sc.id}`, message: `premier plan inconnu « ${il.foreground} »` });
        if (il.until) checkAnchor(il.until, `/scenes/${sc.id}/illustrations/until`);
      }
      for (const fmt of Object.keys(sc.formats ?? {})) {
        if (!project!.formats[fmt]) issues.push({ file: FILES.timeline, path: `/scenes/${sc.id}/formats`, message: `format « ${fmt} » absent de project.json` });
      }
    }
  }
  if (timeline?.credits) {
    // Générique commun : modèle valide, médias résolus, enchaînement sans trou avec la dernière scène.
    const last = timeline.scenes[timeline.scenes.length - 1];
    if (JSON.stringify(last.span.to) !== JSON.stringify(timeline.credits.from)) {
      issues.push({ file: FILES.timeline, path: '/credits/from', message: `doit être identique à la fin de la dernière scène (${last.id})` });
    }
    try {
      withCredits(dir, timeline, assets!);
    } catch (e) {
      issues.push({ file: FILES.timeline, path: '/credits', message: (e as Error).message });
    }
  }
  if (!Object.keys(project!.formats).every((f) => /^\d+x\d+$/.test(f))) {
    issues.push({ file: FILES.project, path: '/formats', message: 'identifiant de format invalide' });
  }
  if (!ID_RE.test(project!.id)) issues.push({ file: FILES.project, path: '/id', message: 'identifiant invalide' });
  return issues;
}

export function allLines(l: LyricsFile): (LyricsLine & { sectionId: string })[] {
  return l.sections.flatMap((s) => s.lines.map((line) => ({ ...line, sectionId: s.id })));
}

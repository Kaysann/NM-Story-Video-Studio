import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NmsvsError } from '../../core/errors';
import { backupFile, ensureDir, readJson, readJsonIfExists, writeFileAtomic, writeJsonAtomic } from '../../core/fsx';
import { hashFileSync, hashObject } from '../../core/hash';
import { ffmpeg } from '../../core/tools';
import type { RunContext } from '../../core/context';
import { FILES, projectPath, allLines, type ProjectBundle } from '../../model/project';
import { assertValid } from '../../model/schemas';
import type { AudioAnalysis, SyncAuto, SyncOverridesFile, SyncResolved, TimedLine } from '../../model/types';
import { runStep } from '../../pipeline/step';
import { callPython } from '../python/bridge';
import { analyzeAudio } from '../analysis/analyze';
import { addDecision } from '../project/init';
import { parseLineSelection, resolveSync, uniformLines } from './merge';
import { toLrc, toSrt, toVtt } from './subtitles';

export const syncAutoFile = (dir: string) => path.join(dir, 'analysis', 'sync.auto.json');
export const syncResolvedFile = (dir: string) => path.join(dir, 'build', 'sync.resolved.json');
export const shortsSyncResolvedFile = (dir: string) => path.join(dir, 'build', 'sync.shorts.resolved.json');
const staleFile = (dir: string) => path.join(dir, 'analysis', 'stale-overrides.json');

export function lyricsHash(b: ProjectBundle) {
  return hashObject(allLines(b.lyrics).map((l) => [l.id, l.text, !!l.skipAlign]));
}

/** Pré-traitement « vocal-focus » (DSP, sans poids appris — voir CHANGELOG C-01) → WAV 16 kHz mono. */
export async function preprocessVocals(b: ProjectBundle, mode: 'vocal-focus' | 'none'): Promise<string> {
  const master = projectPath(b, b.project.audio.master);
  const sha = hashFileSync(master);
  const out = path.join(b.dir, 'build', 'analysis', `voice-${mode}-${sha.slice(0, 12)}.wav`);
  if (fs.existsSync(out)) return out;
  ensureDir(path.dirname(out));
  // Canal central (voix généralement centrée) + passe-bande voix + compression douce.
  const af = mode === 'vocal-focus'
    ? 'pan=mono|c0=0.5*c0+0.5*c1,highpass=f=150,lowpass=f=5000,acompressor=threshold=0.1:ratio=3:attack=10:release=200,aresample=16000'
    : 'pan=mono|c0=0.5*c0+0.5*c1,aresample=16000';
  const tmp = out.replace(/\.wav$/, '.tmp.wav');
  await ffmpeg(['-i', master, '-vn', '-af', af, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', tmp]);
  fs.renameSync(tmp, out);
  return out;
}

export interface SyncOptions { engine?: 'whisperx' | 'stable-ts' | 'uniform'; lines?: string; force?: boolean }

export async function runSync(ctx: RunContext, b: ProjectBundle, opts: SyncOptions = {}): Promise<SyncResolved> {
  const analysis = await analyzeAudio(ctx, b);
  const settings = { engine: 'whisperx', preprocess: 'vocal-focus', asrModel: 'large-v3', alignModel: 'jonatasgrosman/wav2vec2-large-xlsr-53-french', ...b.project.sync };
  const engine = opts.engine ?? settings.engine;
  const audioSha = analysis.audioSha256;
  const order = allLines(b.lyrics).map((l) => l.id);
  const prevAuto = readJsonIfExists<SyncAuto>(syncAutoFile(b.dir));
  const prevResolved = readJsonIfExists<SyncResolved>(syncResolvedFile(b.dir));

  // Corrections antérieures devenues douteuses si l'audio maître a changé.
  const overrideKeys = [...Object.keys(b.overrides.lines ?? {}), ...Object.keys(b.overrides.words ?? {})];
  if (prevAuto && prevAuto.audioSha256 !== audioSha && overrideKeys.length) {
    writeJsonAtomic(staleFile(b.dir), overrideKeys);
    ctx.warn('W_SYNC_STALE', `L’audio maître a changé : ${overrideKeys.length} correction(s) conservée(s) mais à revalider.`);
  }

  // Lignes verrouillées = ancres fixes (jamais recalculées).
  const locked = new Set(Object.entries(b.overrides.lines ?? {}).filter(([, o]) => o.lock).map(([id]) => id));
  const skip = new Set(allLines(b.lyrics).filter((l) => l.skipAlign).map((l) => l.id));
  let targets = order.filter((id) => !locked.has(id) && !skip.has(id));
  if (opts.lines) {
    let sel: string[];
    try { sel = parseLineSelection(opts.lines, order); } catch (e) { throw new NmsvsError('E_ARGS', (e as Error).message); }
    targets = targets.filter((id) => sel.includes(id));
  }
  const reuse = opts.lines && prevAuto && prevAuto.audioSha256 === audioSha && prevAuto.engine === engine;
  if (!reuse) targets = order.filter((id) => !skip.has(id) && !(locked.has(id) && prevResolved?.lines.some((l) => l.id === id)));
  const anchors = (prevResolved?.lines ?? []).filter((l) => locked.has(l.id) || (reuse && !targets.includes(l.id))).map((l) => ({ id: l.id, start: l.start, end: l.end }));

  const outFile = syncAutoFile(b.dir);
  const lhash = lyricsHash(b);
  const { value: auto } = await runStep(ctx, b.dir, {
    id: 'sync-auto',
    version: 2,
    inputs: { audioSha, lhash, engine, settings: engine === 'uniform' ? null : settings, targets, anchors },
    outputs: [outFile],
    load: () => readJson<SyncAuto>(outFile),
    run: async () => {
      let lines: TimedLine[];
      let textDiff: SyncAuto['textDiff'] = [];
      let metrics: Record<string, number> = {};
      if (engine === 'uniform') {
        lines = uniformLines(b.lyrics, analysis.durationSec);
      } else {
        const voice = await preprocessVocals(b, settings.preprocess as 'vocal-focus' | 'none');
        const transcript = await transcribeCached(ctx, b, voice, settings.asrModel!);
        const lyr = allLines(b.lyrics).filter((l) => targets.includes(l.id)).map((l) => ({ id: l.id, text: l.text }));
        const res = await ctx.log.time('sync', `Alignement (${engine}, ${lyr.length} lignes)`, () =>
          callPython<{ lines: TimedLine[]; textDiff: SyncAuto['textDiff'] }>(ctx, 'align', { audio: voice, lines: lyr, anchors, transcript },
            { engine, asrModel: settings.asrModel, alignModel: settings.alignModel, language: b.lyrics.language, threads: Math.max(1, os.cpus().length >> 1) },
            path.join(b.dir, 'build')),
        );
        lines = res.outputs.lines;
        textDiff = res.outputs.textDiff;
        metrics = res.metrics ?? {};
        if (reuse && prevAuto) {
          const keep = prevAuto.lines.filter((l) => !targets.includes(l.id));
          lines = [...keep, ...lines].sort((a, c) => order.indexOf(a.id) - order.indexOf(c.id));
          textDiff = [...(prevAuto.textDiff ?? []).filter((d) => !targets.includes(d.lineId)), ...(textDiff ?? [])];
        }
      }
      const out: SyncAuto = { version: 1, engine, audioSha256: audioSha, lyricsHash: lhash, lines, textDiff, metrics };
      assertValid('sync-auto', out, outFile);
      writeJsonAtomic(outFile, out);
      return out;
    },
  }, opts.force);
  return resolveAndWrite(ctx, b, auto, analysis);
}

async function transcribeCached(ctx: RunContext, b: ProjectBundle, voice: string, asrModel: string) {
  const file = path.join(b.dir, 'analysis', 'transcript.json');
  const { value } = await runStep(ctx, b.dir, {
    id: 'transcribe',
    version: 1,
    inputs: { voice: hashFileSync(voice), asrModel },
    outputs: [file],
    load: () => readJson<any[]>(file),
    run: async () => {
      const res = await ctx.log.time('transcribe', `Transcription grossière (faster-whisper ${asrModel}, CPU)`, () =>
        callPython<{ words: any[] }>(ctx, 'transcribe', { audio: voice }, { asrModel, language: b.lyrics.language, threads: Math.max(1, os.cpus().length >> 1) }, path.join(b.dir, 'build')),
      );
      writeJsonAtomic(file, res.outputs.words);
      return res.outputs.words;
    },
  });
  return value;
}

export function resolveAndWrite(ctx: RunContext, b: ProjectBundle, auto?: SyncAuto, analysis?: AudioAnalysis): SyncResolved {
  auto ??= readJsonIfExists<SyncAuto>(syncAutoFile(b.dir));
  if (!auto) throw new NmsvsError('E_SYNC_MISSING', 'Aucune synchronisation calculée.', 'Lancer `nmsvs sync`.');
  analysis ??= readJson<AudioAnalysis>(path.join(b.dir, 'analysis', 'audio.json'));
  const stale = readJsonIfExists<string[]>(staleFile(b.dir)) ?? [];
  const resolved = resolveSync(auto, b.overrides, b.lyrics, analysis.durationSec, stale);
  writeJsonAtomic(syncResolvedFile(b.dir), resolved);
  // Sous-titres
  const subDir = path.join(b.dir, 'exports');
  ensureDir(subDir);
  writeFileAtomic(path.join(subDir, `${b.project.id}.srt`), toSrt(resolved, b.lyrics));
  writeFileAtomic(path.join(subDir, `${b.project.id}.vtt`), toVtt(resolved, b.lyrics));
  writeFileAtomic(path.join(subDir, `${b.project.id}.lrc`), toLrc(resolved, b.project.title));
  return resolved;
}

export function loadResolvedSync(ctx: RunContext, b: ProjectBundle): SyncResolved {
  // Toujours recalculée depuis auto + overrides (peu coûteux) : les corrections récentes sont prises en compte.
  return resolveAndWrite(ctx, b);
}

// ───────────── couche de corrections propre aux Shorts (reels.json → params.syncOverrides) ─────────────

/** Fichier des corrections propres aux Shorts (chemin absolu) ou undefined s'il n'est pas déclaré. */
export function shortsOverridesPath(b: ProjectBundle): string | undefined {
  const rel = b.reels?.params?.syncOverrides;
  return rel ? (path.isAbsolute(rel) ? rel : path.join(b.dir, rel)) : undefined;
}

/** Superposition : une entrée (ligne ou mot) des Shorts remplace celle du clip pour le même identifiant. */
export function mergeOverrides(base: SyncOverridesFile, extra: SyncOverridesFile): SyncOverridesFile {
  return {
    ...base,
    globalOffsetSec: extra.globalOffsetSec ?? base.globalOffsetSec,
    lines: { ...(base.lines ?? {}), ...(extra.lines ?? {}) },
    words: { ...(base.words ?? {}), ...(extra.words ?? {}) },
  };
}

/**
 * Synchronisation des Shorts : auto + corrections du clip + corrections des Shorts. N'écrit ni la synchronisation
 * résolue du clip ni ses sous-titres (le clip YouTube n'est jamais affecté) ; trace dans build/sync.shorts.resolved.json.
 */
export function resolveShortsSync(ctx: RunContext, b: ProjectBundle): SyncResolved {
  const file = shortsOverridesPath(b);
  if (!file || !fs.existsSync(file)) return loadResolvedSync(ctx, b);
  const extra = readJson<SyncOverridesFile>(file);
  assertValid('sync-overrides', extra, file);
  const auto = readJsonIfExists<SyncAuto>(syncAutoFile(b.dir));
  if (!auto) throw new NmsvsError('E_SYNC_MISSING', 'Aucune synchronisation calculée.', 'Lancer `nmsvs sync`.');
  const analysis = readJson<AudioAnalysis>(path.join(b.dir, 'analysis', 'audio.json'));
  const stale = readJsonIfExists<string[]>(staleFile(b.dir)) ?? [];
  const resolved = resolveSync(auto, mergeOverrides(b.overrides, extra), b.lyrics, analysis.durationSec, stale);
  writeJsonAtomic(shortsSyncResolvedFile(b.dir), resolved);
  ctx.log.info(`Synchronisation des Shorts : ${path.relative(b.dir, file)} (${Object.keys(extra.lines ?? {}).length} ligne(s) corrigée(s))`);
  return resolved;
}

// ───────────── corrections ciblées (fichier humain sync.overrides.json) ─────────────

/** Cible des corrections : le clip (sync.overrides.json) ou les seuls Shorts (reels.json → params.syncOverrides). */
export type OverridesTarget = 'clip' | 'shorts';

function targetFile(b: ProjectBundle, target: OverridesTarget): string {
  if (target === 'clip') return path.join(b.dir, FILES.overrides);
  const f = shortsOverridesPath(b);
  if (!f) throw new NmsvsError('E_ARGS', 'Aucun fichier de corrections propre aux Shorts.', 'Déclarer reels.json → params.syncOverrides (ex. "sync.overrides.shorts.json") puis `nmsvs validate`.');
  return f;
}

function editOverrides(b: ProjectBundle, fn: (o: SyncOverridesFile) => void, decision: string, target: OverridesTarget = 'clip') {
  const file = targetFile(b, target);
  const o: SyncOverridesFile = readJsonIfExists<SyncOverridesFile>(file) ?? { schemaVersion: 1 };
  fn(o);
  assertValid('sync-overrides', o, file);
  backupFile(file);
  writeJsonAtomic(file, o);
  if (target === 'clip') b.overrides = o;
  addDecision(b.dir, { by: 'user', via: 'nmsvs sync', scope: target === 'clip' ? 'sync' : 'sync-shorts', decision: target === 'clip' ? decision : `[Shorts] ${decision}` });
  // Une correction explicite lève l'éventuel marquage « à revalider ».
  const stale = readJsonIfExists<string[]>(staleFile(b.dir));
  if (stale) writeJsonAtomic(staleFile(b.dir), stale.filter((k) => !decision.includes(k)));
}

function checkTarget(b: ProjectBundle, id: string) {
  const ids = allLines(b.lyrics).map((l) => l.id);
  const lineId = id.replace(/\.w\d+$/, '');
  if (!ids.includes(lineId)) throw new NmsvsError('E_ARGS', `Ligne inconnue : ${lineId}`, `Exemples : ${ids.slice(0, 3).join(', ')}`);
}

export function syncFix(b: ProjectBundle, id: string, v: { start?: number; end?: number; lock?: boolean }, target: OverridesTarget = 'clip') {
  checkTarget(b, id);
  if (v.start === undefined && v.end === undefined && v.lock === undefined) throw new NmsvsError('E_ARGS', 'Préciser --start, --end et/ou --lock.');
  const isWord = /\.w\d+$/.test(id);
  editOverrides(b, (o) => {
    const bag = isWord ? (o.words ??= {}) : (o.lines ??= {});
    const cur = (bag as any)[id] ?? {};
    if (v.start !== undefined) cur.start = v.start;
    if (v.end !== undefined) cur.end = v.end;
    if (v.lock !== undefined) cur.lock = v.lock;
    (bag as any)[id] = cur;
  }, `Correction ${id}${v.start !== undefined ? ` début=${v.start}` : ''}${v.end !== undefined ? ` fin=${v.end}` : ''}${v.lock ? ' (verrouillée)' : ''}`, target);
}

/**
 * Corrections par lot depuis un fichier JSON { lines: { id: { start, end } }, words: { … } } (même forme que
 * sync.overrides.json) : une seule sauvegarde, une seule décision. Les entrées appliquées sont verrouillées.
 */
export function syncApply(b: ProjectBundle, file: string, reason: string | undefined, target: OverridesTarget = 'clip') {
  const batch = readJson<Pick<SyncOverridesFile, 'lines' | 'words'>>(file);
  const nl = Object.keys(batch.lines ?? {}).length;
  const nw = Object.keys(batch.words ?? {}).length;
  if (!nl && !nw) throw new NmsvsError('E_ARGS', `Aucune correction dans ${file}.`, 'Attendu : { "lines": { "<id>": { "start": s, "end": s } }, "words": { … } }');
  for (const id of [...Object.keys(batch.lines ?? {}), ...Object.keys(batch.words ?? {})]) checkTarget(b, id);
  editOverrides(b, (o) => {
    for (const [id, v] of Object.entries(batch.lines ?? {})) (o.lines ??= {})[id] = { ...v, lock: true };
    for (const [id, v] of Object.entries(batch.words ?? {})) (o.words ??= {})[id] = { ...v, lock: true };
  }, `Corrections par lot (${nl} ligne(s), ${nw} mot(s)) depuis ${path.basename(file)}${reason ? ` — ${reason}` : ''}`, target);
  return { lines: nl, words: nw, file: targetFile(b, target) };
}

export function syncShift(b: ProjectBundle, id: string, delta: number, target: OverridesTarget = 'clip') {
  checkTarget(b, id);
  editOverrides(b, (o) => {
    const cur = (o.lines ??= {})[id] ?? {};
    if (cur.start !== undefined || cur.end !== undefined) {
      if (cur.start !== undefined) cur.start = Math.round((cur.start + delta) * 1000) / 1000;
      if (cur.end !== undefined) cur.end = Math.round((cur.end + delta) * 1000) / 1000;
    } else cur.shift = Math.round(((cur.shift ?? 0) + delta) * 1000) / 1000;
    o.lines![id] = cur;
  }, `Décalage ${id} de ${delta > 0 ? '+' : ''}${delta} s`, target);
}

export function syncOffset(b: ProjectBundle, sec: number) {
  editOverrides(b, (o) => { o.globalOffsetSec = sec; }, `Décalage global ${sec} s`);
}

export function syncUnlock(b: ProjectBundle, id: string, clear: boolean, target: OverridesTarget = 'clip') {
  checkTarget(b, id);
  editOverrides(b, (o) => {
    if (clear) {
      delete o.lines?.[id];
      for (const k of Object.keys(o.words ?? {})) if (k.startsWith(`${id}.w`)) delete o.words![k];
    } else if (o.lines?.[id]) o.lines[id].lock = false;
  }, `${clear ? 'Suppression des corrections' : 'Déverrouillage'} ${id}`, target);
}

// ───────────── rapport et évaluation ─────────────

export function syncReport(b: ProjectBundle, r: SyncResolved, auto?: SyncAuto): { markdown: string; stats: Record<string, number> } {
  const texts = new Map(allLines(b.lyrics).map((l) => [l.id, l.text]));
  const low = r.lines.filter((l) => l.confidence < 0.5 && l.source !== 'override');
  const interpolated = r.lines.flatMap((l) => l.words.filter((w) => w.source === 'interpolated').map((w) => `${w.id} « ${w.text} »`));
  const short = r.lines.filter((l) => l.end - l.start < 1.0 || (texts.get(l.id)!.length / Math.max(0.01, l.end - l.start)) > 17);
  const stats = {
    lines: r.lines.length,
    lowConfidence: low.length,
    interpolatedWords: interpolated.length,
    shortLines: short.length,
    overrides: r.lines.filter((l) => l.source === 'override').length,
    meanConfidence: Math.round((r.lines.reduce((a, l) => a + l.confidence, 0) / Math.max(1, r.lines.length)) * 1000) / 1000,
  };
  const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
  let md = `# Rapport de synchronisation — ${b.project.title}\n\nMoteur : **${r.engine}** · lignes : ${stats.lines} · confiance moyenne : ${stats.meanConfidence} · corrections humaines : ${stats.overrides}\n\n`;
  if (r.engine === 'uniform') md += '> ⚠ Moteur **uniforme** : répartition proportionnelle au texte, sans écoute de l’audio. Ne convient pas à une production réelle.\n\n';
  if (r.staleOverrides.length) md += `> ⚠ Corrections à revalider (audio maître modifié) : ${r.staleOverrides.join(', ')}\n\n`;
  md += `## Lignes à vérifier en priorité (confiance < 0,5) — ${low.length}\n\n`;
  md += low.length ? '| Ligne | Début | Fin | Confiance | Texte |\n|---|---|---|---|---|\n' + low.sort((a, c) => a.confidence - c.confidence).map((l) => `| ${l.id} | ${fmt(l.start)} | ${fmt(l.end)} | ${l.confidence} | ${texts.get(l.id)} |`).join('\n') + '\n\n' : 'Aucune.\n\n';
  md += `## Durées de lecture insuffisantes (< 1 s ou > 17 car./s) — ${short.length}\n\n${short.map((l) => `- ${l.id} (${(l.end - l.start).toFixed(2)} s)`).join('\n') || 'Aucune.'}\n\n`;
  md += `## Mots sans horodatage (interpolés) — ${interpolated.length}\n\n${interpolated.slice(0, 50).join(', ') || 'Aucun.'}\n\n`;
  if (auto?.textDiff?.length) {
    md += `## Écarts texte / chant entendu — ${auto.textDiff.length}\n\n| Ligne | Attendu | Entendu |\n|---|---|---|\n${auto.textDiff.map((d) => `| ${d.lineId} | ${d.expected} | ${d.heard || '—'} |`).join('\n')}\n\n`;
  }
  md += `## Correction\n\n\`nmsvs sync shift <ligne> +0.15\` · \`nmsvs sync fix <ligne> --start 63.42 --end 66.10 --lock\` · \`nmsvs sync --lines <plage>\` · \`nmsvs preview draft --from <section>\`\n`;
  return { markdown: md, stats };
}

export function referenceTemplate(b: ProjectBundle) {
  const file = path.join(b.dir, FILES.references);
  if (fs.existsSync(file)) throw new NmsvsError('E_LOCKED_FILE', `${FILES.references} existe déjà.`, 'Le compléter directement.');
  const ids = allLines(b.lyrics).map((l) => l.id);
  const pick = ids.length <= 20 ? ids : Array.from({ length: 20 }, (_, i) => ids[Math.round((i * (ids.length - 1)) / 19)]);
  const lines: Record<string, number | null> = {};
  for (const id of pick) lines[id] = null;
  writeJsonAtomic(file, {
    schemaVersion: 1,
    instructions: 'Écouter le master et noter, en secondes (ex. 63.42), l’instant où le chant de chaque ligne commence. Ne pas utiliser les valeurs calculées par NMSVS. Laisser null si incertain.',
    texts: Object.fromEntries(pick.map((id) => [id, allLines(b.lyrics).find((l) => l.id === id)!.text])),
    lines,
  });
  return { file, count: pick.length };
}

/** Écart entre la synchronisation et les repères humains (D-08). */
export function evaluateAgainstReference(b: ProjectBundle, lines: TimedLine[]) {
  const file = path.join(b.dir, FILES.references);
  const ref = readJsonIfExists<{ lines: Record<string, number | null> }>(file);
  if (!ref) throw new NmsvsError('E_ASSET_MISSING', `${FILES.references} absent.`, 'Créer le modèle : `nmsvs sync reference-template`, puis le compléter à l’oreille.');
  const errs: { id: string; err: number }[] = [];
  for (const [id, t] of Object.entries(ref.lines)) {
    if (typeof t !== 'number') continue;
    const l = lines.find((x) => x.id === id);
    if (l) errs.push({ id, err: Math.abs(l.start - t) });
  }
  if (!errs.length) throw new NmsvsError('E_ASSET_MISSING', 'Aucun repère renseigné dans reference.timings.json.');
  const sorted = errs.map((e) => e.err).sort((a, c) => a - c);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return { n: errs.length, medianSec: q(0.5), p90Sec: q(0.9), over500ms: errs.filter((e) => e.err > 0.5).length, errors: errs };
}

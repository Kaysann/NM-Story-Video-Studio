import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { RunContext } from '../core/context';
import { asNmsvsError, EXIT_CODES, NmsvsError } from '../core/errors';
import { killChildren } from '../core/exec';
import { readJsonIfExists, writeJsonAtomic, writeFileAtomic, backupFile } from '../core/fsx';
import { ID_RE, ROOT } from '../core/paths';
import { FILES, findProjectDir, loadProject, validateProjectFiles } from '../model/project';
import { listPresets } from '../model/presets';
import { gcSegments, loadManifest, updateManifest } from '../pipeline/manifest';
import { initProject, addDecision } from '../modules/project/init';
import { importAudio, importImages, importLyrics, refreshAssets } from '../modules/project/import';
import { analyzeAudio } from '../modules/analysis/analyze';
import { evaluateAgainstReference, loadResolvedSync, referenceTemplate, resolveShortsSync, runSync, syncApply, syncAutoFile, syncFix, syncOffset, syncReport, syncShift, syncUnlock } from '../modules/sync/sync';
import { composeTimeline } from '../modules/timeline/compose';
import { buildTimeline } from '../modules/timeline/build';
import { renderSegments, renderSettings } from '../modules/render/render';
import { cleanProject } from '../modules/project/clean';
import { previewContact, previewDraft, previewStill, previewStudio } from '../modules/render/preview';
import { exportProfile, loadProfile } from '../modules/export/export';
import { qcMarkdown, runQc } from '../modules/qc/qc';
import { analyzeReels, buildReels, tryReel, selectReels } from '../modules/reels/reels';
import { writeRunReport } from '../modules/report/report';
import { doctor } from '../modules/doctor/doctor';
import type { SyncAuto } from '../model/types';

const program = new Command();
program.name('nmsvs').description('NM Story Video Studio — moteur de production audiovisuelle piloté par Codex').version('1.0.0')
  .option('-p, --project <slug|chemin>', 'projet visé (défaut : dossier courant ou NMSVS_PROJECT)')
  .option('--json', 'sortie JSON sur stdout (pour Codex)')
  .option('-q, --quiet', 'pas de journal sur stderr');

let activeCtx: RunContext | null = null;
let activeArgv: string[] = [];

process.on('SIGINT', () => {
  killChildren();
  if (activeCtx?.projectDir) {
    try { updateManifest(activeCtx.projectDir, (m) => { if (m.lastCommand) m.lastCommand.status = 'interrupted'; }); } catch { /* best effort */ }
  }
  process.stderr.write('\nInterrompu. Reprendre avec `nmsvs resume`.\n');
  process.exit(130);
});

interface Opts { project?: string; json?: boolean; quiet?: boolean }
const g = (): Opts => program.opts<Opts>();

/**
 * Exécute une action : contexte, journal, rapport, sortie humaine ou JSON, code de sortie.
 * `persist` : écrit un dossier de rapport ; `resumable` : mémorise la commande pour `nmsvs resume`.
 */
async function act<T>(name: string, fn: (ctx: RunContext) => Promise<T>, o: { needsProject?: boolean; persist?: boolean; resumable?: boolean; human?: (r: T) => string } = {}) {
  const opts = g();
  let projectDir: string | undefined;
  if (o.needsProject !== false) {
    try { projectDir = findProjectDir(opts.project); } catch (e) { if (o.needsProject) return finish(null, name, undefined, e); }
  }
  const ctx = new RunContext(name, projectDir, opts.quiet || opts.json);
  activeCtx = ctx;
  if (o.persist) ctx.persist();
  if (o.resumable && projectDir) updateManifest(projectDir, (m) => { m.lastCommand = { argv: activeArgv, at: new Date().toISOString(), status: 'running' }; });
  try {
    const result = await fn(ctx);
    if (o.resumable && projectDir) updateManifest(projectDir, (m) => { if (m.lastCommand) m.lastCommand.status = 'done'; });
    let report: string | undefined;
    if (o.persist || ctx.artifacts.length) report = await writeRunReport(ctx, 'ok', result);
    return finish(ctx, name, { result, report, human: o.human?.(result) });
  } catch (e) {
    if (o.resumable && projectDir) updateManifest(projectDir, (m) => { if (m.lastCommand) m.lastCommand.status = 'failed'; });
    const err = asNmsvsError(e);
    if (o.persist || ctx.artifacts.length) await writeRunReport(ctx, 'error', null, err.toJSON());
    return finish(ctx, name, undefined, err);
  }
}

function finish(ctx: RunContext | null, name: string, ok?: { result: unknown; report?: string; human?: string }, e?: unknown) {
  const opts = g();
  if (ok) {
    if (opts.json) process.stdout.write(JSON.stringify({ ok: true, command: name, result: ok.result, warnings: ctx?.warnings ?? [], report: ok.report, artifacts: ctx?.artifacts ?? [] }, null, 2) + '\n');
    else {
      if (ok.human) process.stdout.write(ok.human.endsWith('\n') ? ok.human : ok.human + '\n');
      if (ok.report) process.stdout.write(`Rapport : ${ok.report}\n`);
    }
    process.exitCode = 0;
  } else {
    const err = asNmsvsError(e);
    if (opts.json) process.stdout.write(JSON.stringify({ ok: false, command: name, error: err.toJSON(), warnings: ctx?.warnings ?? [] }, null, 2) + '\n');
    else process.stderr.write(`✖ [${err.code}] ${err.message}${err.action ? `\n  → ${err.action}` : ''}\n`);
    process.exitCode = EXIT_CODES[err.code] ?? 1;
  }
}

const P = (ctx: RunContext) => loadProject(ctx.projectDir!);
const num = (v: string) => {
  const n = Number(v);
  if (Number.isNaN(n)) throw new NmsvsError('E_ARGS', `Nombre attendu : ${v}`);
  return n;
};

// ───────────── environnement et projet ─────────────
program.command('doctor').description('vérifie l’environnement').action(() => act('doctor', async (ctx) => {
  const r = await doctor(ctx);
  if (!r.ok) throw new NmsvsError('E_DEP_MISSING', `Environnement incomplet : ${r.checks.filter((c) => c.required && !c.ok).map((c) => c.id).join(', ')}`, 'Voir docs/GUIDE_DEVELOPPEUR.md §Installation', r);
  return r;
}, { needsProject: false, human: (r) => r.checks.map((c) => `${c.ok ? '✔' : c.required ? '✖' : '⚠'} ${c.id.padEnd(22)} ${c.detail}`).join('\n') }));

program.command('init <slug>').description('crée un projet').option('--title <titre>').option('--formats <liste>', 'formats', '16x9,9x16')
  .action((slug, o) => act('init', async () => ({ dir: initProject(slug, { title: o.title, formats: o.formats.split(',') }) }), { needsProject: false, human: (r) => `Projet créé : ${r.dir}` }));

const imp = program.command('import').description('importe des médias (les originaux ne sont jamais modifiés)');
imp.command('audio <fichier>').action((f) => act('import-audio', (ctx) => importAudio(ctx, ctx.projectDir!, f), { needsProject: true, human: (r) => `Audio maître : ${r.path} (${r.durationSec.toFixed(2)} s, ${r.sampleRate} Hz, ${r.codec})` }));
imp.command('lyrics <fichier>').option('--force', 'remplace lyrics.json (sauvegarde .bak)').option('--language <code>', 'langue', 'fr')
  .action((f, o) => act('import-lyrics', async (ctx) => importLyrics(ctx, ctx.projectDir!, f, o), { needsProject: true, human: (r) => r.sections.map((s) => `${s.id.padEnd(14)} ${s.kind.padEnd(12)} ${s.lines} ligne(s)${s.repeatOf ? ` = ${s.repeatOf}` : ''}`).join('\n') }));
imp.command('images <fichiers...>').action((f) => act('import-images', (ctx) => importImages(ctx, ctx.projectDir!, f), { needsProject: true, human: (r) => r.map((i) => `${i.id.padEnd(28)} ${i.size.w}×${i.size.h}${i.warnings.length ? `  ⚠ ${i.warnings.join(' ; ')}` : ''}`).join('\n') }));
imp.command('textures <fichiers...>').action((f) => act('import-textures', (ctx) => importImages(ctx, ctx.projectDir!, f, 'textures'), { needsProject: true, human: (r) => r.map((i) => i.id).join('\n') }));

program.command('validate').description('valide les fichiers du projet (schémas + cohérence)').option('--refresh', 'met à jour sha256/size des images')
  .action((o) => act('validate', async (ctx) => {
    if (o.refresh) await refreshAssets(ctx.projectDir!);
    const issues = validateProjectFiles(ctx.projectDir!);
    if (issues.length) throw new NmsvsError('E_SCHEMA', `${issues.length} problème(s) :\n${issues.map((i) => `  ${i.file} ${i.path} : ${i.message}`).join('\n')}`, 'Corriger puis relancer.', issues);
    return { valid: true };
  }, { needsProject: true, human: () => '✔ Projet valide' }));

program.command('decide <texte>').description('consigne une décision artistique').option('--scope <portée>').option('--reason <raison>').option('--ref <ref...>')
  .action((t, o) => act('decide', async (ctx) => addDecision(ctx.projectDir!, { by: 'user', via: 'codex', scope: o.scope, decision: t, reason: o.reason, refs: o.ref }), { needsProject: true, human: () => 'Décision consignée.' }));

program.command('status').description('état du projet').action(() => act('status', async (ctx) => {
  const m = loadManifest(ctx.projectDir!);
  const issues = validateProjectFiles(ctx.projectDir!);
  return { valid: issues.length === 0, issues: issues.length, steps: m.steps, exports: m.exports, lastCommand: m.lastCommand, hasTimeline: fs.existsSync(path.join(ctx.projectDir!, FILES.timeline)) };
}, { needsProject: true, human: (r) => `Validité : ${r.valid ? 'OK' : `${r.issues} problème(s)`}\nTimeline : ${r.hasTimeline ? 'présente' : 'absente'}\nÉtapes :\n${Object.entries(r.steps).map(([k, s]) => `  ${k.padEnd(28)} ${s.status} ${s.finishedAt ?? ''}`).join('\n')}\nExports :\n${r.exports.map((e) => `  ${path.basename(e.file)} (${e.profile}, QC ${e.qc}) ${e.at}`).join('\n') || '  aucun'}${r.lastCommand ? `\nDernière commande : ${r.lastCommand.argv.join(' ')} — ${r.lastCommand.status}` : ''}` }));

program.command('resume').description('relance la dernière commande longue interrompue ou en échec').action(() => act('resume', async (ctx) => {
  const lc = loadManifest(ctx.projectDir!).lastCommand;
  if (!lc) throw new NmsvsError('E_ARGS', 'Aucune commande à reprendre.');
  if (lc.status === 'done') return { message: 'La dernière commande est déjà terminée.', argv: lc.argv };
  ctx.log.info(`Reprise : nmsvs ${lc.argv.join(' ')}`);
  // En mode --json, stdout reste réservé à la réponse JSON de `resume`.
  const quiet = !!g().json || !!g().quiet;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'nmsvs.mjs'), ...(quiet ? ['-q'] : []), '--project', ctx.projectDir!, ...lc.argv], { stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit' });
  if (r.status !== 0) throw new NmsvsError('E_RENDER_FAILED', `La reprise a échoué (code ${r.status}).`);
  return { resumed: lc.argv };
}, { needsProject: true }));

const cache = program.command('cache').description('cache');
cache.command('gc').description('supprime les segments hors des 3 derniers plans').action(() => act('cache-gc', async (ctx) => gcSegments(ctx.projectDir!), { needsProject: true, human: (r) => `${r.removed.length} fichier(s) supprimé(s), ${(r.bytes / 2 ** 20).toFixed(1)} Mo libérés` }));

// ───────────── analyse et synchronisation ─────────────
program.command('analyze').description('analyse musicale').option('--force').action((o) => act('analyze', async (ctx) => {
  const a = await analyzeAudio(ctx, P(ctx), o.force);
  return { tempo: a.tempo, beats: a.beats.length, meter: a.meter, segments: a.segments, loudness: a.loudness, durationSec: a.durationSec };
}, { needsProject: true, persist: true, resumable: true, human: (r) => `Tempo ${r.tempo.bpm} BPM · ${r.beats} battements · mesure ${r.meter} · ${r.segments.length} segments (${r.segments.map((s: any) => s.label).join('')}) · ${r.loudness?.integratedLUFS} LUFS` }));

const sync = program.command('sync').description('synchronisation des paroles (alignement forcé)').option('--engine <moteur>', 'whisperx | stable-ts | uniform').option('--lines <sélection>', 'réaligne seulement ces lignes (ex. verse-2.l1-verse-2.l4)').option('--force')
  .action((o) => act('sync', async (ctx) => {
    const b = P(ctx);
    const r = await runSync(ctx, b, { engine: o.engine, lines: o.lines, force: o.force });
    const rep = syncReport(b, r, readJsonIfExists<SyncAuto>(syncAutoFile(b.dir)));
    writeFileAtomic(path.join(ctx.dir, 'sync-report.md'), rep.markdown);
    ctx.artifacts.push(path.join(ctx.dir, 'sync-report.md'));
    return rep.stats;
  }, { needsProject: true, persist: true, resumable: true, human: (s) => `${s.lines} lignes · confiance moyenne ${s.meanConfidence} · ${s.lowConfidence} à vérifier · ${s.interpolatedWords} mot(s) interpolé(s) · ${s.overrides} correction(s)` }));
// --shorts : la correction ne vaut que pour les Shorts (fichier déclaré dans reels.json → params.syncOverrides).
const syncOf = (ctx: RunContext, b: ReturnType<typeof P>, shorts: boolean) => (shorts ? resolveShortsSync(ctx, b) : loadResolvedSync(ctx, b));
sync.command('fix <id>').description('fixe début/fin d’une ligne ou d’un mot').option('--start <s>').option('--end <s>').option('--lock').option('--unlock').option('--shorts', 'corrections propres aux Shorts (reels.json → params.syncOverrides) ; le clip n’est pas modifié')
  .action((id, o) => act('sync-fix', async (ctx) => {
    const b = P(ctx);
    syncFix(b, id, { start: o.start !== undefined ? num(o.start) : undefined, end: o.end !== undefined ? num(o.end) : undefined, lock: o.lock ? true : o.unlock ? false : undefined }, o.shorts ? 'shorts' : 'clip');
    return { line: syncOf(ctx, b, !!o.shorts).lines.find((l) => l.id === id.replace(/\.w\d+$/, '')) };
  }, { needsProject: true, human: (r) => `→ ${r.line?.id} : ${r.line?.start.toFixed(3)} → ${r.line?.end.toFixed(3)} s` }));
sync.command('shift <id> <delta>').description('décale une ligne (secondes, ex. +0.15)').option('--shorts', 'corrections propres aux Shorts (reels.json → params.syncOverrides) ; le clip n’est pas modifié').action((id, d, o) => act('sync-shift', async (ctx) => {
  const b = P(ctx);
  syncShift(b, id, num(d), o.shorts ? 'shorts' : 'clip');
  return { line: syncOf(ctx, b, !!o.shorts).lines.find((l) => l.id === id) };
}, { needsProject: true, human: (r) => `→ ${r.line?.id} : ${r.line?.start.toFixed(3)} → ${r.line?.end.toFixed(3)} s` }));
sync.command('offset <sec>').description('décalage global').action((s) => act('sync-offset', async (ctx) => { const b = P(ctx); syncOffset(b, num(s)); loadResolvedSync(ctx, b); return { globalOffsetSec: num(s) }; }, { needsProject: true }));
sync.command('unlock <id>').description('déverrouille (ou --clear : supprime les corrections)').option('--clear').option('--shorts', 'corrections propres aux Shorts (reels.json → params.syncOverrides) ; le clip n’est pas modifié').action((id, o) => act('sync-unlock', async (ctx) => { const b = P(ctx); syncUnlock(b, id, !!o.clear, o.shorts ? 'shorts' : 'clip'); syncOf(ctx, b, !!o.shorts); return { id }; }, { needsProject: true }));
sync.command('apply <fichier>').description('corrections par lot (JSON { lines, words }), verrouillées ; une seule décision').option('--reason <texte>').option('--shorts', 'corrections propres aux Shorts (reels.json → params.syncOverrides) ; le clip n’est pas modifié')
  .action((f, o) => act('sync-apply', async (ctx) => {
    const b = P(ctx);
    const r = syncApply(b, path.resolve(f), o.reason, o.shorts ? 'shorts' : 'clip');
    syncOf(ctx, b, !!o.shorts);
    return r;
  }, { needsProject: true, human: (r) => `${r.lines} ligne(s), ${r.words} mot(s) → ${r.file}` }));
sync.command('report').description('rapport de synchronisation').action(() => act('sync-report', async (ctx) => {
  const b = P(ctx);
  const rep = syncReport(b, loadResolvedSync(ctx, b), readJsonIfExists<SyncAuto>(syncAutoFile(b.dir)));
  writeFileAtomic(path.join(ctx.dir, 'sync-report.md'), rep.markdown);
  ctx.artifacts.push(path.join(ctx.dir, 'sync-report.md'));
  return rep.stats;
}, { needsProject: true, persist: true }));
sync.command('reference-template').description('crée reference.timings.json à compléter à l’oreille (D-08)').action(() => act('sync-reference', async (ctx) => referenceTemplate(P(ctx)), { needsProject: true, human: (r) => `${r.count} repères à compléter dans ${r.file}` }));
sync.command('evaluate').description('écart entre la synchronisation et les repères humains').option('--auto', 'évalue la synchro automatique (sans corrections)')
  .action((o) => act('sync-evaluate', async (ctx) => {
    const b = P(ctx);
    const lines = o.auto ? readJsonIfExists<SyncAuto>(syncAutoFile(b.dir))?.lines ?? [] : loadResolvedSync(ctx, b).lines;
    return evaluateAgainstReference(b, lines);
  }, { needsProject: true, human: (r) => `${r.n} repères · erreur médiane ${(r.medianSec * 1000).toFixed(0)} ms · P90 ${(r.p90Sec * 1000).toFixed(0)} ms · ${r.over500ms} > 500 ms` }));

// ───────────── composition, prévisualisation, rendu, export ─────────────
program.command('compose').description('propose une timeline.json (composition automatique)').option('--overwrite', 'remplace la timeline existante (sauvegarde .bak)')
  .action((o) => act('compose', async (ctx) => {
    const b = P(ctx);
    const file = path.join(b.dir, FILES.timeline);
    if (fs.existsSync(file) && !o.overwrite) throw new NmsvsError('E_LOCKED_FILE', 'timeline.json existe déjà (fichier humain).', 'Relancer avec --overwrite (une sauvegarde .bak sera créée).');
    const analysis = await analyzeAudio(ctx, b);
    const s = loadResolvedSync(ctx, b);
    const { timeline, rationale } = composeTimeline(b, s, analysis);
    backupFile(file);
    writeJsonAtomic(file, timeline);
    addDecision(b.dir, { by: 'engine', via: 'nmsvs compose', decision: `Proposition de composition (${timeline.scenes.length} scènes)`, reason: rationale.join(' ') });
    const v = validateProjectFiles(b.dir);
    if (v.length) throw new NmsvsError('E_SCHEMA', `Timeline générée invalide : ${v[0].message}`);
    writeFileAtomic(path.join(ctx.dir, 'compose.md'), `# Composition automatique\n\n${rationale.map((r) => `- ${r}`).join('\n')}\n\n## Scènes\n\n${timeline.scenes.map((s) => `- **${s.id}** : ${s.note}`).join('\n')}\n`);
    ctx.artifacts.push(file);
    return { scenes: timeline.scenes.length, rationale };
  }, { needsProject: true, persist: true, human: (r) => `${r.scenes} scènes proposées.\n${r.rationale.join('\n')}` }));

program.command('timeline').description('compile la timeline résolue (sans rendu)').option('-f, --format <fmt>', 'format', '16x9')
  .action((o) => act('timeline', async (ctx) => {
    const r = await buildTimeline(ctx, P(ctx), o.format);
    return { file: r.file, shots: r.timeline.shots.length, lyrics: r.timeline.lyrics.length, frames: r.timeline.durationInFrames, warnings: r.warnings.length };
  }, { needsProject: true, human: (r) => `${r.file}\n${r.shots} plans · ${r.lyrics} blocs de paroles · ${r.frames} images · ${r.warnings} alerte(s)` }));

const prev = program.command('preview').description('prévisualisations');
prev.command('studio').option('-f, --format <fmt>', 'format', '16x9').option('--safe', 'affiche les zones de sécurité').option('--port <n>').option('--no-open', 'n’ouvre pas le navigateur')
  .action((o) => act('preview-studio', async (ctx) => previewStudio(ctx, P(ctx), o.format, { safe: o.safe, port: o.port ? num(o.port) : undefined, open: o.open }), { needsProject: true }));
prev.command('still <temps>').option('-f, --format <fmt>', 'format', '16x9').option('--safe')
  .action((t, o) => act('preview-still', async (ctx) => ({ file: await previewStill(ctx, P(ctx), o.format, num(t), !!o.safe) }), { needsProject: true, human: (r) => r.file }));
prev.command('contact').option('-f, --format <fmt>', 'format', '16x9')
  .action((o) => act('preview-contact', async (ctx) => ({ file: await previewContact(ctx, P(ctx), o.format) }), { needsProject: true, persist: true, human: (r) => r.file }));
prev.command('draft').option('-f, --format <fmt>', 'format', '16x9').option('--from <repère>').option('--to <repère>')
  .action((o) => act('preview-draft', async (ctx) => { const r = await previewDraft(ctx, P(ctx), o.format, { from: o.from, to: o.to }); return { file: r.file, qc: r.qc.blocking ? 'bloquant' : 'ok' }; }, { needsProject: true, persist: true, resumable: true, human: (r) => r.file }));

program.command('render').description('rend les segments manquants (sans encodage final)').option('-f, --format <fmt>', 'format', '16x9').option('--concurrency <n>').option('--gl <gl>')
  .action((o) => act('render', async (ctx) => {
    const b = P(ctx);
    const { timeline } = await buildTimeline(ctx, b, o.format);
    const r = await renderSegments(ctx, b, timeline, renderSettings({ concurrency: o.concurrency ? num(o.concurrency) : undefined, gl: o.gl }));
    return { segments: r.segments.length, rendered: r.rendered, cached: r.cachedCount, renderSec: r.renderSec, fps: r.framesRendered / Math.max(0.001, r.renderSec) };
  }, { needsProject: true, persist: true, resumable: true, human: (r) => `${r.segments} segments (${r.rendered} rendus, ${r.cached} en cache) en ${r.renderSec.toFixed(1)} s${r.rendered ? ` — ${r.fps.toFixed(2)} i/s` : ''}` }));

program.command('export').description('export final selon un ou plusieurs profils').option('--profile <id...>', 'profils (défaut : project.exportProfiles)').option('--concurrency <n>').option('--gl <gl>').option('--vmaf', 'mesure VMAF dans le QC').option('--replace', 'autorise explicitement le remplacement d’un export existant (aucune archive automatique)').option('--label <version>', 'suffixe de version du nom de fichier (nouvelle version, l’export existant est conservé)')
  .action((o) => act('export', async (ctx) => {
    const b = P(ctx);
    if (o.label !== undefined && !ID_RE.test(o.label)) throw new NmsvsError('E_ARGS', `Libellé de version invalide « ${o.label} ».`, 'Minuscules, chiffres et tirets (ex. v2).');
    const ids: string[] = o.profile ?? b.project.exportProfiles ?? ['youtube-4k-master'];
    const out = [];
    for (const id of ids) {
      const r = await exportProfile(ctx, b, id, { render: { concurrency: o.concurrency ? num(o.concurrency) : undefined, gl: o.gl }, vmaf: o.vmaf, replace: !!o.replace, versionLabel: o.label });
      out.push({ file: r.file, profile: id, cached: r.cached, renderSec: r.renderSec, encodeSec: r.encodeSec, segments: r.segments, qc: { blocking: r.qc.blocking, major: r.qc.major, minor: r.qc.minor } });
    }
    return out;
  }, { needsProject: true, persist: true, resumable: true, human: (rs) => rs.map((r) => `${r.file}\n  ${r.segments.rendered}/${r.segments.total} segments rendus${r.cached ? ' · encodage en cache' : ''} · QC : ${r.qc.blocking ? 'BLOQUANT' : r.qc.major ? `${r.qc.major} majeur(s)` : 'OK'}${r.qc.minor ? `, ${r.qc.minor} mineur(s)` : ''}`).join('\n') }));

program.command('qc <fichier>').description('contrôle qualité d’un export').requiredOption('--profile <id>')
  .action((f, o) => act('qc', async (ctx) => {
    const b = P(ctx);
    const p = loadProfile(o.profile);
    const built = await buildTimeline(ctx, b, p.format);
    const sc = p.scale ?? 1;
    const file = fs.existsSync(path.resolve(f)) ? path.resolve(f) : path.join(b.dir, f);
    const qc = await runQc({ file, timeline: built.timeline, warnings: built.warnings, sync: loadResolvedSync(ctx, b),
      expected: { width: Math.round(built.timeline.width * sc), height: Math.round(built.timeline.height * sc), fps: built.timeline.fps, videoCodec: p.video.encoder.includes('265') || p.video.encoder.startsWith('hevc') ? 'hevc' : 'h264', pixFmt: p.video.pixFmt ?? 'yuv420p', audioCodec: p.audio.codec, sampleRate: p.audio.sampleRate ?? 48000, durationSec: built.timeline.durationInFrames / built.timeline.fps } });
    writeFileAtomic(path.join(ctx.dir, 'qc.md'), qcMarkdown(qc));
    ctx.artifacts.push(path.join(ctx.dir, 'qc.md'));
    return qc;
  }, { needsProject: true, persist: true, human: (r) => qcMarkdown(r) }));

// ───────────── Reels ─────────────
const reels = program.command('reels').description('extraits pour Reels / Shorts');
reels.command('analyze').description('propose 5 extraits classés et justifiés (aucun Short produit)').option('--audio', 'produit aussi les extraits audio d’écoute').action((o) => act('reels-analyze', async (ctx) => {
  const r = await analyzeReels(ctx, P(ctx), { audio: !!o.audio });
  return { poolSize: r.poolSize, candidates: r.candidates.map((c) => ({ id: c.id, start: c.start, end: c.end, duration: c.duration, score: c.score, sections: c.sections, justification: c.justification })) };
}, { needsProject: true, persist: true, human: (r) => r.candidates.map((c) => `${c.id}  ${c.start.toFixed(1)}→${c.end.toFixed(1)} s  score ${c.score.toFixed(2)}\n   ${c.justification}`).join('\n') }));
reels.command('select <ids...>').description('sélection humaine (ex. cand-3 cand-1)').option('--name <id=nom...>').option('--adjust-start <id=sec...>').option('--adjust-end <id=sec...>').option('--no-snap')
  .action((ids, o) => act('reels-select', async (ctx) => {
    const kv = (xs?: string[]) => Object.fromEntries((xs ?? []).map((x) => { const [k, v] = x.split('='); return [k, v]; }));
    const names = kv(o.name);
    const adj: Record<string, { startSec?: number; endSec?: number }> = {};
    for (const [k, v] of Object.entries(kv(o.adjustStart))) (adj[k] ??= {}).startSec = num(v as string);
    for (const [k, v] of Object.entries(kv(o.adjustEnd))) (adj[k] ??= {}).endSec = num(v as string);
    return selectReels(P(ctx), ids, names as Record<string, string>, adj, o.snap === false);
  }, { needsProject: true, human: (r) => `Sélection enregistrée : ${r.map((s) => s.name ?? s.candidate).join(', ')}` }));
reels.command('build').description('produit les Reels sélectionnés (ou un essai technique : --try <candidat>)').option('--profile <id>').option('--only <ids...>')
  .option('--try <candidat>', 'essai technique sur un candidat, sans sélection (reels.json inchangé)').option('--timeline <fichier>', 'timeline des Shorts pour cet essai')
  .option('--from <sec>', 'essai : début (temps chanson)').option('--to <sec>', 'essai : fin (temps chanson)').option('--label <nom>', 'essai : suffixe du fichier')
  .option('--replace', 'autorise explicitement le remplacement d’un export existant')
  .action((o) => act('reels-build', async (ctx) => (o.try
    ? [await tryReel(ctx, P(ctx), o.try, { profile: o.profile, timeline: o.timeline, label: o.label, replace: !!o.replace, window: { from: o.from !== undefined ? num(o.from) : undefined, to: o.to !== undefined ? num(o.to) : undefined } })]
    : await buildReels(ctx, P(ctx), { profile: o.profile, only: o.only, replace: !!o.replace })).map((r) => ({ file: r.file, qc: r.qc.blocking ? 'bloquant' : r.qc.major ? 'majeur' : 'ok', major: r.qc.major, minor: r.qc.minor, renderSec: r.renderSec, encodeSec: r.encodeSec })), { needsProject: true, persist: true, resumable: true, human: (r) => r.map((x) => `${x.file} (QC ${x.qc})`).join('\n') }));

program.command('clean').description('nettoyage sûr des intermédiaires de rendu régénérables (liste blanche) ; à blanc sans --apply')
  .option('--apply', 'supprime réellement (sinon : liste seulement)')
  .action((o) => act('clean', async (ctx) => {
    const r = await cleanProject(ctx.projectDir!, { apply: !!o.apply });
    writeJsonAtomic(path.join(ctx.dir, 'clean.json'), r);
    ctx.artifacts.push(path.join(ctx.dir, 'clean.json'));
    return { applied: r.applied, files: r.removed.length, mb: Math.round(r.bytes / 2 ** 20), verifiedExports: r.verifiedExports.length, outOfScope: r.outOfScope };
  }, { needsProject: true, persist: true, human: (r) => `${r.applied ? 'Supprimés' : 'À supprimer (à blanc, --apply pour exécuter)'} : ${r.files} fichier(s), ${r.mb} Mo · ${r.verifiedExports} MP4 final(aux) vérifié(s)${r.outOfScope.length ? `
Hors périmètre (conservés, autorisation distincte requise) : ${r.outOfScope.join(', ')}` : ''}` }));

program.command('presets [famille]').description('liste les presets').action((fam) => act('presets', async () => {
  const fams = fam ? [fam] : ['motion', 'transition', 'lyrics', 'title', 'safe', 'export', 'reels-weights'];
  return Object.fromEntries(fams.map((f) => [f, listPresets(f as any)]));
}, { needsProject: false, human: (r) => Object.entries(r).map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`).join('\n') }));

activeArgv = process.argv.slice(2).filter((a, i, arr) => !['--json', '-q', '--quiet'].includes(a) && !(['-p', '--project'].includes(a) || ['-p', '--project'].includes(arr[i - 1])));
program.parseAsync(process.argv).catch((e) => finish(activeCtx, 'nmsvs', undefined, e));
void writeJsonAtomic;

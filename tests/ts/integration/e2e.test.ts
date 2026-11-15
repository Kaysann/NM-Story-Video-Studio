// Bout en bout sur projet SYNTHÉTIQUE (aucun média réel) : CLI réelle, Remotion réel, FFmpeg réel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeSources } from '../../fixtures/make-fixture';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nmsvs e2e - '));
const PROJECTS = path.join(TMP, 'projets');
const SRC = path.join(TMP, 'sources');
const P = path.join(PROJECTS, 'essai');
const env = { ...process.env, NMSVS_PROJECTS: PROJECTS };

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'nmsvs.mjs'), '--json', '-p', P, ...args], { env, encoding: 'utf8', maxBuffer: 64 << 20 });
  let json: any;
  try { json = JSON.parse(r.stdout); } catch { throw new Error(`Sortie non JSON (${r.status}) : ${r.stdout}\n${r.stderr}`); }
  return { code: r.status, json };
}
const ok = (...args: string[]) => {
  const r = cli(...args);
  if (!r.json.ok) throw new Error(`${args.join(' ')} : ${JSON.stringify(r.json.error)}`);
  return r.json.result;
};
const editJson = (file: string, fn: (j: any) => void) => {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(j);
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
};

beforeAll(() => {
  makeSources(SRC, { durationSec: 24 });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'nmsvs.mjs'), '--json', 'init', 'essai', '--title', 'Essai NMSVS'], { env, encoding: 'utf8' });
  expect(JSON.parse(r.stdout).ok).toBe(true);
  editJson(path.join(P, 'project.json'), (j) => {
    // Règle de production V1.1 : export YouTube en 3840 × 2160 direct (images synthétiques 1920 × 1080 : agrandissement toléré).
    j.formats['16x9'] = { width: 3840, height: 2160, safeZone: 'preset:safe-16x9-default' };
    j.art.maxUpscale = 3;
    j.formats['9x16'] = { width: 360, height: 640, safeZone: 'preset:safe-9x16-social' };
    j.sync.engine = 'uniform';
  });
  editJson(path.join(P, 'reels.json'), (j) => { j.params.durations = [6, 8]; j.params.count = 3; });
});

describe('chaîne complète (projet synthétique)', () => {
  it('import des médias sans modifier les originaux', () => {
    const before = fs.statSync(path.join(SRC, 'master.wav')).mtimeMs;
    ok('import', 'audio', path.join(SRC, 'master.wav'));
    ok('import', 'lyrics', path.join(SRC, 'paroles.txt'));
    const imgs = ok('import', 'images', ...['foret', 'chateau', 'phare', 'gardien'].map((n) => path.join(SRC, `${n}.png`)));
    ok('import', 'textures', path.join(SRC, 'parchemin.png'));
    expect(imgs).toHaveLength(4);
    expect(fs.statSync(path.join(SRC, 'master.wav')).mtimeMs).toBe(before);
    expect(ok('validate').valid).toBe(true);
  });
  it('import de paroles refusé sans --force (fichier humain protégé)', () => {
    const r = cli('import', 'lyrics', path.join(SRC, 'paroles.txt'));
    expect(r.json.ok).toBe(false);
    expect(r.json.error.code).toBe('E_LOCKED_FILE');
  });
  it('analyse, synchronisation, composition', () => {
    expect(ok('analyze').durationSec).toBeCloseTo(24, 1);
    expect(ok('sync').lines).toBe(8);
    expect(ok('compose').scenes).toBeGreaterThanOrEqual(4);
    expect(cli('compose').json.error.code).toBe('E_LOCKED_FILE');
  });
  it('corrections ciblées : shift, fix + verrou, offset, unlock --clear', () => {
    const l = ok('sync', 'shift', 'verse-1.l2', '+0.2').line;
    const f = ok('sync', 'fix', 'chorus-1.l1', '--start', '9.0', '--lock').line;
    expect(f.start).toBe(9);
    const ov = JSON.parse(fs.readFileSync(path.join(P, 'sync.overrides.json'), 'utf8'));
    expect(ov.lines['chorus-1.l1']).toEqual({ start: 9, lock: true });
    expect(ov.lines['verse-1.l2'].shift).toBe(0.2);
    expect(l.source).toBe('override');
    // Un recalcul complet ne touche pas aux corrections
    ok('sync', '--force');
    expect(JSON.parse(fs.readFileSync(path.join(P, 'sync.overrides.json'), 'utf8')).lines['chorus-1.l1'].lock).toBe(true);
    ok('sync', 'unlock', 'verse-1.l2', '--clear');
    expect(JSON.parse(fs.readFileSync(path.join(P, 'sync.overrides.json'), 'utf8')).lines['verse-1.l2']).toBeUndefined();
    const decisions = fs.readFileSync(path.join(P, 'decisions.jsonl'), 'utf8').trim().split('\n');
    expect(decisions.length).toBeGreaterThanOrEqual(6);
    expect(fs.existsSync(path.join(P, 'exports', 'essai.srt'))).toBe(true);
  });
  it('styles variés puis export 16:9 conforme', () => {
    editJson(path.join(P, 'timeline.json'), (t) => {
      t.scenes[0].lyrics = { style: 'preset:lyrics-parchment-default' };
      t.scenes[1].lyrics = { style: 'preset:lyrics-text-on-image-default', karaoke: 'word' };
      t.scenes[1].transitionIn = 'preset:wipe-linear';
      t.scenes[2].transitionIn = 'preset:zoom-through';
    });
    const [r] = ok('export', '--profile', 'youtube-4k-master');
    expect(r.qc.blocking).toBe(false);
    expect(r.qc.major).toBe(0);
    expect(fs.existsSync(r.file)).toBe(true);
    // Production 4K directe : MP4 3840 × 2160, aucun brouillon basse résolution produit au passage.
    const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', r.file], { encoding: 'utf8' }).stdout);
    const v = probe.streams.find((x: any) => x.codec_type === 'video');
    expect([v.width, v.height]).toEqual([3840, 2160]);
    expect(probe.format.format_name).toMatch(/mp4/);
    expect(fs.readdirSync(path.join(P, 'exports')).filter((f) => /draft/i.test(f))).toEqual([]);
  });
  it('export YouTube refusé si le projet n’est pas en 3840 × 2160 (aucun rendu)', () => {
    editJson(path.join(P, 'project.json'), (j) => { j.formats['16x9'].width = 1920; j.formats['16x9'].height = 1080; });
    const r = cli('export', '--profile', 'youtube-4k-master');
    editJson(path.join(P, 'project.json'), (j) => { j.formats['16x9'].width = 3840; j.formats['16x9'].height = 2160; });
    expect(r.json.ok).toBe(false);
    expect(r.json.error.code).toBe('E_PROFILE');
  });
  it('ré-export sans changement : 0 segment rendu, encodage en cache', () => {
    const [r] = ok('export', '--profile', 'youtube-4k-master');
    expect(r.segments.rendered).toBe(0);
    expect(r.cached).toBe(true);
  });
  it('modification d’une scène : refus d’écraser sans --replace ; avec --replace seuls ses segments sont re-rendus, sans archive', () => {
    editJson(path.join(P, 'timeline.json'), (t) => { t.scenes[t.scenes.length - 1].lyrics = { style: 'preset:lyrics-fast' }; });
    const refused = cli('export', '--profile', 'youtube-4k-master');
    expect(refused.json.ok).toBe(false);
    expect(refused.json.error.code).toBe('E_EXPORT_EXISTS');
    const [r] = ok('export', '--profile', 'youtube-4k-master', '--replace');
    expect(r.segments.rendered).toBe(0); // segments rendus lors de la tentative refusée, réutilisés
    expect(r.cached).toBe(false);
    expect(fs.existsSync(path.join(P, 'exports', 'archive'))).toBe(false);
  });
  it('interruption pendant le rendu puis reprise : les segments terminés sont conservés', async () => {
    editJson(path.join(P, 'project.json'), (j) => { j.art.vignette = 0.3; }); // invalide tous les segments 9:16
    const segDir = path.join(P, 'build', '9x16', 'segments');
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'nmsvs.mjs'), '-q', '-p', P, 'export', '--profile', 'reel-1080-h264'], { env });
    const t0 = Date.now();
    await new Promise<void>((resolve, reject) => {
      const iv = setInterval(() => {
        const done = fs.existsSync(segDir) ? fs.readdirSync(segDir).filter((f) => f.endsWith('.mp4') && !f.includes('.tmp')) : [];
        if (done.length >= 1) { clearInterval(iv); child.kill(); resolve(); }
        if (Date.now() - t0 > 240_000) { clearInterval(iv); child.kill(); reject(new Error('aucun segment terminé')); }
      }, 100);
    });
    await new Promise((r) => child.on('close', r));
    const st = ok('status');
    expect(['running', 'interrupted']).toContain(st.lastCommand.status);
    const res = ok('resume');
    expect(res.resumed).toEqual(['export', '--profile', 'reel-1080-h264']);
    const [again] = ok('export', '--profile', 'reel-1080-h264');
    expect(again.segments.rendered).toBe(0);
    expect(again.qc.blocking).toBe(false);
    expect(fs.readdirSync(segDir).some((f) => f.includes('.tmp'))).toBe(false);
  });
  it('Reels : propositions justifiées, sélection humaine, production', () => {
    const a = ok('reels', 'analyze');
    expect(a.candidates.length).toBeGreaterThanOrEqual(2);
    expect(a.candidates[0].justification).toMatch(/Points forts/);
    expect(cli('reels', 'build').json.error.code).toBe('E_REELS'); // rien de sélectionné : pas de choix à la place de l'utilisateur
    ok('reels', 'select', 'cand-1', '--name', 'cand-1=essai-refrain');
    const built = ok('reels', 'build');
    expect(built).toHaveLength(1);
    expect(built[0].qc).toBe('ok');
    const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', built[0].file], { encoding: 'utf8' }).stdout);
    expect(probe.streams[0].width).toBe(360);
  });
  it('erreur explicite et code de sortie sur projet invalide', () => {
    editJson(path.join(P, 'timeline.json'), (t) => { t.scenes[0].illustrations[0].asset = 'img-inexistante'; });
    const r = cli('validate');
    expect(r.code).toBe(2);
    expect(r.json.error.code).toBe('E_SCHEMA');
    expect(r.json.error.message).toContain('illustration inconnue « img-inexistante »');
  });
});

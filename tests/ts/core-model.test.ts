import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, hashObject, hashFileSync } from '../../src/core/hash';
import { slugify } from '../../src/core/paths';
import { writeFileAtomic, backupFile } from '../../src/core/fsx';
import { validate } from '../../src/model/schemas';
import { listPresets, loadPreset, resolveRef, deepMerge } from '../../src/model/presets';
import { defaultProject, initProject } from '../../src/modules/project/init';
import { parseLyricsText } from '../../src/modules/lyrics/parse';
import { validateProjectFiles } from '../../src/model/project';
import { LYRICS, TIMELINE } from './helpers';

describe('core', () => {
  it('JSON canonique indépendant de l’ordre des clés', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
    expect(hashObject({ a: 1, b: 2 })).toBe(hashObject({ b: 2, a: 1 }));
  });
  it('slugify retire accents et ponctuation', () => {
    expect(slugify('Forêt d’Émeraude (v2).png')).toBe('foret-d-emeraude-v2-png');
  });
  it('écriture atomique et sauvegarde dans un chemin avec espaces, tirets et accents', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmsvs test - é '));
    const f = path.join(dir, 'sous dossier - x', 'fichier é.json');
    writeFileAtomic(f, 'un');
    writeFileAtomic(f, 'deux');
    expect(fs.readFileSync(f, 'utf8')).toBe('deux');
    const bak = backupFile(f)!;
    expect(fs.readFileSync(bak, 'utf8')).toBe('deux');
    expect(fs.readdirSync(path.dirname(f)).some((x) => x.endsWith('.tmp'))).toBe(false);
    expect(hashFileSync(f)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('schémas et presets', () => {
  it('tous les presets sont valides et résolvables', () => {
    for (const fam of ['motion', 'transition', 'lyrics', 'title', 'safe', 'export', 'reels-weights'] as const) {
      const ids = listPresets(fam);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(loadPreset(fam, id)).toBeTruthy();
    }
  });
  it('héritage de presets (extends) et fusion profonde', () => {
    const s = resolveRef<any>('lyrics', { type: 'cartouche', extends: 'preset:lyrics-cartouche-default', panel: { opacity: 0.8 } } as any);
    expect(s.panel.opacity).toBe(0.8);
    expect(s.panel.blur).toBe(12);
    expect(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
  });
  it('projet par défaut, paroles et timeline de test valides', () => {
    expect(validate('project', defaultProject('abc', 'Titre', ['16x9', '9x16']))).toEqual([]);
    expect(validate('lyrics', LYRICS)).toEqual([]);
    expect(validate('timeline', TIMELINE)).toEqual([]);
  });
  it('erreurs lisibles : propriété inconnue, valeur hors énumération', () => {
    const p: any = defaultProject('abc', 'T', ['16x9']);
    p.fsp = 30;
    p.fps = 29;
    const msgs = validate('project', p).map((i) => i.message).join('\n');
    expect(msgs).toContain('propriété inconnue « fsp »');
    expect(msgs).toContain('valeur non autorisée');
  });
  it('les exemples complets de docs/04 sont valides', () => {
    const md = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', '04_MODELE_DONNEES_JSON.md'), 'utf8');
    const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    const names = ['project', 'assets', 'lyrics', 'timeline', 'sync-overrides', 'reels', 'decision'];
    names.forEach((name, i) => {
      const data = JSON.parse(blocks[i].replace('"…"', `"${'0'.repeat(64)}"`));
      expect({ name, issues: validate(name, data) }).toEqual({ name, issues: [] });
    });
  });
});

describe('paroles', () => {
  it('sections, répétitions (x2), refrains identiques', () => {
    const { lyrics, warnings } = parseLyricsText('[Intro]\n[Couplet 1]\nUn deux\nTrois (x2)\n\n[Refrain]\nLa la\n[Couplet 2]\nQuatre\n[Refrain]\nLa la\n# commentaire\n[Pont] x2\nOh\n');
    expect(lyrics.sections.map((s) => s.id)).toEqual(['intro-1', 'verse-1', 'chorus-1', 'verse-2', 'chorus-2', 'bridge-1', 'bridge-2']);
    expect(lyrics.sections[1].lines.map((l) => l.id)).toEqual(['verse-1.l1', 'verse-1.l2', 'verse-1.l3']);
    expect(lyrics.sections[1].lines[2].text).toBe('Trois');
    expect(lyrics.sections[4].repeatOf).toBe('chorus-1');
    expect(lyrics.sections[6].repeatOf).toBe('bridge-1');
    expect(validate('lyrics', lyrics)).toEqual([]);
    expect(warnings.some((w) => w.message.includes('sans paroles'))).toBe(true); // [Intro] vide
  });
  it('en-têtes français : « Avant-refrain » = pré-refrain, « Refrain final » = refrain, « Couplets » = couplet', () => {
    const { lyrics } = parseLyricsText('[Couplets]\nA\n[Avant-refrain]\nB\n[Refrain]\nC\n[Refrain final]\nD\n[Outro]\nE\n');
    expect(lyrics.sections.map((s) => s.id)).toEqual(['verse-1', 'prechorus-1', 'chorus-1', 'chorus-2', 'outro-1']);
    expect(lyrics.sections[1].label).toBe('Avant-refrain');
  });
});

describe('projet sur disque', () => {
  it('init crée un projet ; validate signale les médias manquants sans planter', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nmsvs-proj '));
    const dir = initProject('essai', { root, title: 'Essai' });
    const issues = validateProjectFiles(dir);
    expect(issues.some((i) => i.file === 'lyrics.json' && i.message === 'fichier manquant')).toBe(true);
    expect(() => initProject('essai', { root })).toThrow(/existe déjà/);
    expect(() => initProject('Mauvais Id', { root })).toThrow(/invalide/);
  });
});

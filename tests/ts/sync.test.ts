import { describe, expect, it } from 'vitest';
import { parseLineSelection, resolveSync, uniformLines } from '../../src/modules/sync/merge';
import { toLrc, toSrt, toVtt } from '../../src/modules/sync/subtitles';
import { LYRICS, syncFor } from './helpers';
import type { SyncAuto } from '../../src/model/types';

const auto = (): SyncAuto => {
  const r = syncFor();
  return { version: 1, engine: 'test', audioSha256: r.audioSha256, lyricsHash: 'x', lines: r.lines };
};
const order = LYRICS.sections.flatMap((s) => s.lines.map((l) => l.id));

describe('moteur uniforme', () => {
  it('répartit toutes les lignes, dans l’ordre, dans la durée', () => {
    const lines = uniformLines(LYRICS, 90);
    expect(lines.map((l) => l.id)).toEqual(order);
    for (let i = 1; i < lines.length; i++) expect(lines[i].start).toBeGreaterThanOrEqual(lines[i - 1].end);
    expect(lines[lines.length - 1].end).toBeLessThanOrEqual(90);
    expect(lines.every((l) => l.words.length === l.words.filter((w) => w.source === 'uniform').length)).toBe(true);
  });
});

describe('fusion des corrections (sync.overrides.json)', () => {
  it('décalage global, shift, start/end, mot, verrou : seules les lignes visées changent', () => {
    const a = auto();
    const base = resolveSync(a, { schemaVersion: 1 }, LYRICS, 90);
    const r = resolveSync(a, {
      schemaVersion: 1,
      lines: { 'verse-1.l2': { shift: 0.2 }, 'chorus-1.l1': { start: 24.5, end: 27.5, lock: true } },
      words: { 'verse-2.l1.w3': { start: 40.95 } },
    }, LYRICS, 90);
    const get = (x: typeof r, id: string) => x.lines.find((l) => l.id === id)!;
    expect(get(r, 'verse-1.l2').start).toBeCloseTo(get(base, 'verse-1.l2').start + 0.2, 6);
    expect(get(r, 'verse-1.l2').source).toBe('override');
    expect(get(r, 'chorus-1.l1').start).toBe(24.5);
    expect(get(r, 'chorus-1.l1').end).toBe(27.45); // bornée au début de la ligne suivante (monotonie)
    expect(get(r, 'chorus-1.l1').words[0].start).toBe(24.5);
    expect(get(r, 'verse-2.l1').words[2].start).toBe(40.95);
    const unchanged = order.filter((id) => !['verse-1.l2', 'chorus-1.l1', 'verse-2.l1'].includes(id));
    for (const id of unchanged) expect(get(r, id)).toEqual(get(base, id));
    const off = resolveSync(a, { schemaVersion: 1, globalOffsetSec: -0.1 }, LYRICS, 90);
    expect(get(off, 'verse-1.l1').start).toBeCloseTo(get(base, 'verse-1.l1').start - 0.1, 6);
  });
  it('monotonie : une correction qui chevauche la ligne suivante est bornée', () => {
    const r = resolveSync(auto(), { schemaVersion: 1, lines: { 'verse-1.l1': { end: 30 } } }, LYRICS, 90);
    const l1 = r.lines.find((l) => l.id === 'verse-1.l1')!;
    const l2 = r.lines.find((l) => l.id === 'verse-1.l2')!;
    expect(l1.end).toBeLessThanOrEqual(l2.start);
  });
  it('sections : bornes = première/dernière ligne', () => {
    const r = resolveSync(auto(), { schemaVersion: 1 }, LYRICS, 90);
    expect(r.sections['verse-1'].start).toBe(r.lines[0].start);
    expect(r.sections['chorus-3'].end).toBe(r.lines[r.lines.length - 1].end);
  });
  it('ligne sans synchronisation automatique : interpolée entre ses voisines', () => {
    const a = auto();
    a.lines = a.lines.filter((l) => l.id !== 'verse-1.l3');
    const r = resolveSync(a, { schemaVersion: 1 }, LYRICS, 90);
    const l = r.lines.find((x) => x.id === 'verse-1.l3')!;
    expect(l.source).toBe('interpolated');
    expect(l.start).toBeGreaterThan(r.lines.find((x) => x.id === 'verse-1.l2')!.start);
  });
  it('sélection de lignes : plage, section, liste ; erreurs explicites', () => {
    expect(parseLineSelection('verse-1.l2-verse-1.l4', order)).toEqual(['verse-1.l2', 'verse-1.l3', 'verse-1.l4']);
    expect(parseLineSelection('chorus-1', order)).toEqual(['chorus-1.l1', 'chorus-1.l2']);
    expect(parseLineSelection('verse-2.l1,verse-1.l1', order)).toEqual(['verse-1.l1', 'verse-2.l1']);
    expect(() => parseLineSelection('nope', order)).toThrow(/inconnue/);
  });
});

describe('sous-titres', () => {
  it('SRT / VTT / LRC bien formés', () => {
    const r = resolveSync(auto(), { schemaVersion: 1 }, LYRICS, 90);
    const srt = toSrt(r, LYRICS);
    expect(srt.startsWith('1\n00:00:08,000 --> 00:00:')).toBe(true);
    expect(srt).toContain('Sous le phare des collines');
    expect(toVtt(r, LYRICS).startsWith('WEBVTT\n\n00:00:08.000 -->')).toBe(true);
    expect(toLrc(r, 'T').split('\n')[1]).toMatch(/^\[00:08\.00\]<00:08\.00>Sous <00:08\.45>le/);
  });
});

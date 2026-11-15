import type { LyricsFile, LyricsSection, SectionKind } from '../../model/types';

// Correspondance des en-têtes usuels (français / anglais) vers les types de section.
const KIND_RULES: [RegExp, SectionKind][] = [
  // « Avant-refrain » doit être testé avant la règle « refrain » (sinon classé refrain).
  [/pr[ée][- ]?refrain|pre[- ]?chorus|avant[- ]?refrain/i, 'prechorus'],
  [/refrain|chorus|chœur/i, 'chorus'],
  [/couplet|verse|strophe/i, 'verse'],
  [/pont|bridge/i, 'bridge'],
  [/intro/i, 'intro'],
  [/outro|final|coda/i, 'outro'],
  [/instrumental|solo|interlude/i, 'instrumental'],
  [/parl[ée]|spoken|récit/i, 'spoken'],
];

export function kindOf(header: string): SectionKind {
  for (const [re, k] of KIND_RULES) if (re.test(header)) return k;
  return 'other';
}

const REPEAT_RE = /\s*[([]\s*x\s*(\d+)\s*[)\]]\s*$/i;

export interface ParseWarning { line: number; message: string }

/**
 * Convertit un texte structuré en lyrics.json.
 * - `[Couplet 1]`, `[Refrain]`… ouvrent une section ;
 * - `(x2)` en fin de ligne répète la ligne, en fin d'en-tête répète la section ;
 * - `#` en début de ligne = commentaire ; lignes vides ignorées.
 */
export function parseLyricsText(src: string, language = 'fr'): { lyrics: LyricsFile; warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = [];
  const sections: (LyricsSection & { repeat: number })[] = [];
  const counters: Record<string, number> = {};
  let current: (LyricsSection & { repeat: number }) | null = null;

  const open = (label: string, repeat: number) => {
    const kind = kindOf(label);
    counters[kind] = (counters[kind] ?? 0) + 1;
    current = { id: `${kind === 'other' ? 'part' : kind}-${counters[kind]}`, kind, label, lines: [], repeat };
    sections.push(current);
  };

  src.replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const header = line.match(/^\[(.+?)\]\s*(.*)$/);
    if (header) {
      const rep = (header[1] + ' ' + header[2]).match(/x\s*(\d+)/i);
      open(header[1].replace(/\s*x\s*\d+\s*$/i, '').trim(), rep ? Number(rep[1]) : 1);
      return;
    }
    if (!current) open('Texte', 1);
    let text = line;
    let times = 1;
    const m = text.match(REPEAT_RE);
    if (m) {
      times = Number(m[1]);
      text = text.replace(REPEAT_RE, '');
    }
    text = text.replace(/\s+/g, ' ');
    if (text.length > 60) warnings.push({ line: i + 1, message: `ligne longue (${text.length} caractères) : lisibilité 9:16 à vérifier` });
    if (/[<>{}|\\]/.test(text)) warnings.push({ line: i + 1, message: 'caractères inhabituels' });
    for (let k = 0; k < times; k++) current!.lines.push({ id: '', text });
  });

  // Répétitions de sections, numérotation des lignes, détection des refrains identiques.
  const out: LyricsSection[] = [];
  const recount: Record<string, number> = {};
  for (const s of sections) {
    for (let r = 0; r < s.repeat; r++) {
      recount[s.kind] = (recount[s.kind] ?? 0) + 1;
      const id = `${s.kind === 'other' ? 'part' : s.kind}-${recount[s.kind]}`;
      const lines = s.lines.map((l, i) => ({ id: `${id}.l${i + 1}`, text: l.text }));
      const twin = out.find((o) => o.kind === s.kind && o.lines.map((l) => l.text).join('\n') === lines.map((l) => l.text).join('\n'));
      const label = s.repeat > 1 ? `${s.label} (${r + 1})` : s.label;
      out.push({ id, kind: s.kind, label, repeatOf: twin ? (twin.repeatOf ?? twin.id) : null, lines });
    }
  }
  for (const s of out) if (!s.lines.length && s.kind !== 'instrumental') warnings.push({ line: 0, message: `section « ${s.label} » sans paroles` });
  return { lyrics: { schemaVersion: 1, language, sections: out }, warnings };
}

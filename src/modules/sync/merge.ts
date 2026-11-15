import type { LyricsFile, SyncAuto, SyncOverridesFile, SyncResolved, TimedLine, TimedWord } from '../../model/types';

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Moteur « uniforme » : répartition proportionnelle au nombre de caractères (repli et tests). */
export function uniformLines(lyrics: LyricsFile, durationSec: number, opts: { leadSec?: number; tailSec?: number } = {}): TimedLine[] {
  const lead = opts.leadSec ?? Math.min(2, durationSec * 0.05);
  const tail = opts.tailSec ?? Math.min(2, durationSec * 0.05);
  const lines = lyrics.sections.flatMap((s) => s.lines);
  const gap = 0.4;
  const total = lines.reduce((a, l) => a + l.text.length, 0) || 1;
  const usable = Math.max(1, durationSec - lead - tail - gap * lines.length);
  let t = lead;
  return lines.map((l) => {
    const d = (usable * l.text.length) / total;
    const tokens = l.text.split(/\s+/).filter(Boolean);
    const chars = tokens.reduce((a, w) => a + w.length, 0) || 1;
    let wt = t;
    const words: TimedWord[] = tokens.map((w, i) => {
      const wd = (d * w.length) / chars;
      const word = { id: `${l.id}.w${i + 1}`, text: w, start: r3(wt), end: r3(wt + wd), confidence: 0, source: 'uniform' as const };
      wt += wd;
      return word;
    });
    const line: TimedLine = { id: l.id, start: r3(t), end: r3(t + d), confidence: 0, source: 'uniform', words };
    t += d + gap;
    return line;
  });
}

function rescale(line: TimedLine, s: number, e: number): TimedLine {
  const os = line.start;
  const oe = line.end;
  const k = oe > os ? (e - s) / (oe - os) : 0;
  return {
    ...line,
    start: r3(s),
    end: r3(e),
    words: line.words.map((w) => ({ ...w, start: r3(s + (w.start - os) * k), end: r3(s + (w.end - os) * k) })),
  };
}

/**
 * Fusion synchronisation automatique + corrections humaines → synchronisation résolue.
 * Ordre : décalage global → corrections de ligne (start/end/shift) → corrections de mot → monotonie.
 */
export function resolveSync(auto: SyncAuto, overrides: SyncOverridesFile, lyrics: LyricsFile, durationSec: number, stale: string[] = []): SyncResolved {
  const offset = overrides.globalOffsetSec ?? 0;
  const byId = new Map(auto.lines.map((l) => [l.id, l]));
  const order = lyrics.sections.flatMap((s) => s.lines.map((l) => l.id));
  let lines: TimedLine[] = [];
  const missing: string[] = [];
  for (const id of order) {
    const a = byId.get(id);
    if (!a) {
      missing.push(id);
      continue;
    }
    let line: TimedLine = {
      ...a,
      start: a.start + offset,
      end: a.end + offset,
      words: a.words.map((w) => ({ ...w, start: w.start + offset, end: w.end + offset })),
    };
    const o = overrides.lines?.[id];
    if (o) {
      if (o.shift) line = rescale(line, line.start + o.shift, line.end + o.shift);
      const s = o.start ?? line.start;
      const e = o.end ?? line.end;
      if (o.start !== undefined || o.end !== undefined) line = rescale(line, s, Math.max(e, s + 0.05));
      line.source = 'override';
    }
    for (let i = 0; i < line.words.length; i++) {
      const wo = overrides.words?.[line.words[i].id];
      if (!wo) continue;
      const w = { ...line.words[i], source: 'override' as const };
      if (wo.start !== undefined) w.start = wo.start;
      if (wo.end !== undefined) w.end = wo.end;
      if (w.end <= w.start) w.end = w.start + 0.05;
      line.words[i] = w;
      line.source = 'override';
    }
    // Cohérence interne de la ligne
    for (let i = 1; i < line.words.length; i++) {
      if (line.words[i].start < line.words[i - 1].start) line.words[i].start = line.words[i - 1].start;
      if (line.words[i - 1].end > line.words[i].start) line.words[i - 1].end = line.words[i].start;
    }
    if (line.words.length) {
      line.start = Math.min(line.start, line.words[0].start);
      line.end = Math.max(line.end, line.words[line.words.length - 1].end);
    }
    lines.push(line);
  }
  // Lignes sans synchronisation automatique (skipAlign) : interpolées entre voisines.
  for (const id of missing) {
    const idx = order.indexOf(id);
    const prev = lines.filter((l) => order.indexOf(l.id) < idx).pop();
    const next = lines.find((l) => order.indexOf(l.id) > idx);
    const o = overrides.lines?.[id];
    const s = o?.start ?? (prev ? prev.end + 0.1 : 0);
    const e = o?.end ?? (next ? Math.max(s + 0.5, next.start - 0.1) : Math.min(durationSec, s + 2));
    const text = lyrics.sections.flatMap((x) => x.lines).find((l) => l.id === id)!.text;
    const tokens = text.split(/\s+/).filter(Boolean);
    const step = (e - s) / Math.max(1, tokens.length);
    lines.push({
      id, start: r3(s), end: r3(e), confidence: 0, source: o ? 'override' : 'interpolated',
      words: tokens.map((t, i) => ({ id: `${id}.w${i + 1}`, text: t, start: r3(s + i * step), end: r3(s + (i + 1) * step), confidence: 0, source: 'interpolated' })),
    });
  }
  lines.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  // Bornes et monotonie entre lignes (l'ordre des paroles fait foi)
  lines = lines.map((l) => ({ ...l, start: r3(Math.max(0, Math.min(durationSec, l.start))), end: r3(Math.max(0, Math.min(durationSec, l.end))) }));
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].start < lines[i - 1].start) lines[i] = rescale(lines[i], lines[i - 1].end, Math.max(lines[i - 1].end + 0.2, lines[i].end));
    if (lines[i - 1].end > lines[i].start) {
      const prev = lines[i - 1];
      prev.end = lines[i].start;
      prev.words = prev.words.map((w) => ({ ...w, end: Math.min(w.end, prev.end), start: Math.min(w.start, prev.end) }));
    }
  }
  // Sections
  const sections: SyncResolved['sections'] = {};
  const ids = lyrics.sections.map((s) => s.id);
  for (const s of lyrics.sections) {
    const ls = lines.filter((l) => l.id.startsWith(`${s.id}.l`));
    if (ls.length) sections[s.id] = { start: ls[0].start, end: ls[ls.length - 1].end };
  }
  ids.forEach((id, i) => {
    if (sections[id]) return;
    const prev = ids.slice(0, i).reverse().find((x) => sections[x]);
    const next = ids.slice(i + 1).find((x) => sections[x]);
    sections[id] = { start: prev ? sections[prev].end : 0, end: next ? sections[next].start : durationSec };
  });
  return { version: 1, audioSha256: auto.audioSha256, engine: auto.engine, lines, sections, staleOverrides: stale };
}

/** Sélection de lignes : "verse-2.l1-verse-2.l4", "chorus-1", "verse-1.l2,verse-1.l3". */
export function parseLineSelection(sel: string, order: string[]): string[] {
  const out = new Set<string>();
  for (const part of sel.split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = part.match(/^([a-z0-9-]+\.l\d+)-([a-z0-9-]+\.l\d+)$/);
    if (range) {
      const a = order.indexOf(range[1]);
      const b = order.indexOf(range[2]);
      if (a < 0 || b < 0 || b < a) throw new Error(`Plage de lignes invalide : ${part}`);
      order.slice(a, b + 1).forEach((x) => out.add(x));
    } else if (order.includes(part)) out.add(part);
    else {
      const sec = order.filter((x) => x.startsWith(`${part}.l`));
      if (!sec.length) throw new Error(`Ligne ou section inconnue : ${part}`);
      sec.forEach((x) => out.add(x));
    }
  }
  return order.filter((x) => out.has(x));
}

import type { AudioAnalysis, Candidate, LyricsFile, SyncResolved } from '../../model/types';

export const CRITERIA = ['hook', 'energy', 'lift', 'vocal', 'completeness', 'lyric', 'loopability', 'uniqueness'] as const;
export type Criterion = (typeof CRITERIA)[number];

export const CRITERIA_LABELS: Record<Criterion, string> = {
  hook: 'C1 accroche', energy: 'C2 énergie', lift: 'C3 montée', vocal: 'C4 présence vocale',
  completeness: 'C5 complétude', lyric: 'C6 texte lisible', loopability: 'C7 bouclage', uniqueness: 'C8 singularité',
};

export interface ReelsInput {
  analysis: AudioAnalysis;
  sync: SyncResolved;
  lyrics: LyricsFile;
  title?: string;
  durations: number[];
  weights: Partial<Record<Criterion, number>>;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function seriesMean(s: { hopSec: number; values: number[] }, a: number, b: number): number {
  const i0 = Math.max(0, Math.floor(a / s.hopSec));
  const i1 = Math.min(s.values.length, Math.max(i0 + 1, Math.ceil(b / s.hopSec)));
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += s.values[i];
  return i1 > i0 ? sum / (i1 - i0) : 0;
}

function chromaMean(a: AudioAnalysis, t0: number, t1: number): number[] {
  const c = a.chroma;
  const i0 = Math.max(0, Math.floor(t0 / c.hopSec));
  const i1 = Math.min(c.values.length, Math.max(i0 + 1, Math.ceil(t1 / c.hopSec)));
  const m = new Array(12).fill(0);
  for (let i = i0; i < i1; i++) for (let k = 0; k < 12; k++) m[k] += c.values[i][k];
  return m;
}

const cosine = (x: number[], y: number[]) => {
  let d = 0, nx = 0, ny = 0;
  for (let i = 0; i < x.length; i++) { d += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; }
  return nx && ny ? d / Math.sqrt(nx * ny) : 0;
};

const nearestIn = (list: number[], t: number, tol: number) => list.some((x) => Math.abs(x - t) <= tol);

/** Tous les candidats admissibles, notés (avant diversification). */
export function generateCandidates(inp: ReelsInput): Candidate[] {
  const { analysis: A, sync, lyrics } = inp;
  const D = A.durationSec;
  const words = sync.lines.flatMap((l) => l.words);
  const lineText = new Map(lyrics.sections.flatMap((s) => s.lines).map((l) => [l.id, l.text]));
  const sectionOfLine = (id: string) => id.replace(/\.l\d+$/, '');
  const kindOf = new Map(lyrics.sections.map((s) => [s.id, s.kind]));

  // Accroches : ligne la plus répétée (texte normalisé), sinon lignes de refrain ; lignes contenant le titre.
  const counts = new Map<string, number>();
  for (const l of sync.lines) counts.set(norm(lineText.get(l.id) ?? ''), (counts.get(norm(lineText.get(l.id) ?? '')) ?? 0) + 1);
  const maxRep = Math.max(0, ...counts.values());
  const hookLines = sync.lines.filter((l) => maxRep >= 2 ? counts.get(norm(lineText.get(l.id) ?? '')) === maxRep : kindOf.get(sectionOfLine(l.id)) === 'chorus');
  const titleWords = norm(inp.title ?? lyrics.title ?? '').split(' ').filter((w) => w.length > 3);
  const titleLines = titleWords.length ? sync.lines.filter((l) => titleWords.every((w) => norm(lineText.get(l.id) ?? '').includes(w))) : [];

  const songRms = seriesMean(A.rms, 0, D) || 1e-9;
  const chorusStarts = Object.entries(sync.sections).filter(([id]) => kindOf.get(id) === 'chorus').map(([, s]) => s.start);
  const segLabelCount = new Map<string, number>();
  for (const s of A.segments) segLabelCount.set(s.label, (segLabelCount.get(s.label) ?? 0) + 1);

  // Points de départ et de fin admissibles, avec leur justification.
  // Marges autour des lignes bornées par la ligne voisine : quand deux lignes s'enchaînent, la borne se place
  // dans l'intervalle qui les sépare (jamais sur la ligne voisine), à 0,05 s de chacune au moins si possible.
  const starts: { t: number; why: string }[] = [];
  sync.lines.forEach((l, i) => {
    const prevEnd = i > 0 ? sync.lines[i - 1].end : 0;
    starts.push({ t: Math.max(0, Math.min(l.start - 0.05, Math.max(l.start - 0.25, prevEnd + 0.05))), why: `début de ligne ${l.id}` });
  });
  for (const [id, s] of Object.entries(sync.sections)) starts.push({ t: s.start, why: `début de section ${id}` });
  const barLen = A.downbeats.length > 1 ? (A.downbeats[A.downbeats.length - 1] - A.downbeats[0]) / (A.downbeats.length - 1) : 2;
  for (const c of chorusStarts) for (const k of [1, 2]) if (c - k * barLen > 0) starts.push({ t: c - k * barLen, why: `${k} mesure(s) avant un refrain` });
  A.downbeats.forEach((d, i) => { if (i % 4 === 0) starts.push({ t: d, why: 'temps fort (début de phrase musicale)' }); });
  const ends: { t: number; why: string }[] = [];
  sync.lines.forEach((l, i) => {
    const nextStart = i + 1 < sync.lines.length ? sync.lines[i + 1].start : D;
    ends.push({ t: Math.min(D, Math.max(l.end + 0.05, Math.min(l.end + 0.3, nextStart - 0.05))), why: `fin de ligne ${l.id}` });
  });
  for (const [id, s] of Object.entries(sync.sections)) ends.push({ t: Math.min(D, s.end + 0.3), why: `fin de section ${id}` });
  A.downbeats.forEach((d, i) => { if (i % 4 === 0 && i > 0) ends.push({ t: d, why: 'fin de phrase musicale (4 mesures)' }); });
  ends.push({ t: D, why: 'fin du morceau' });

  const dedupe = (xs: { t: number; why: string }[]) => {
    const out: { t: number; why: string }[] = [];
    for (const x of xs.sort((a, b) => a.t - b.t)) if (!out.length || x.t - out[out.length - 1].t > 0.1) out.push({ ...x, t: r3(x.t) });
    return out;
  };
  // Aucune borne au cœur d'un mot (tolérance : 50 ms d'attaque ou de chute, couvertes par les fondus du Short).
  const S = dedupe(starts).filter((s) => !words.some((w) => s.t > w.start + 0.02 && s.t < w.end - 0.05));
  const E = dedupe(ends).filter((e) => !words.some((w) => e.t > w.start + 0.05 && e.t < w.end - 0.02));

  const out: Candidate[] = [];
  for (const d of inp.durations) {
    for (const s of S) {
      for (const e of E) {
        const len = e.t - s.t;
        if (len < d * 0.85 || len > d * 1.15 || e.t > D) continue;
        const inLines = sync.lines.filter((l) => l.start >= s.t - 0.05 && l.end <= e.t + 0.35);
        const sung = words.filter((w) => w.end > s.t && w.start < e.t).reduce((a, w) => a + Math.min(e.t, w.end) - Math.max(s.t, w.start), 0);
        const vocal = clamp01(sung / len);
        const energyRatio = seriesMean(A.rms, s.t, e.t) / songRms;
        if (vocal < 0.1 && energyRatio < 0.6) continue; // passage creux : rejeté

        let hook = 0;
        for (const h of hookLines) if (inLines.includes(h)) hook = Math.max(hook, 0.7 + (h.start - s.t <= 5 ? 0.3 : 0));
        for (const h of titleLines) if (inLines.includes(h)) hook = Math.max(hook, 0.6 + (h.start - s.t <= 5 ? 0.2 : 0));
        const energy = clamp01((energyRatio - 0.6) / 0.8);
        const slope = (seriesMean(A.rms, s.t + 4, s.t + 8) - seriesMean(A.rms, s.t, s.t + 4)) / songRms;
        const lift = clamp01(0.5 + slope * 1.5 + (chorusStarts.some((c) => c >= s.t + 2 && c <= s.t + 12) ? 0.3 : 0));
        const startsOnLine = sync.lines.some((l) => Math.abs(l.start - 0.25 - s.t) < 0.3) || !words.some((w) => w.start <= s.t && w.end > s.t);
        const endsOnPhrase = sync.lines.some((l) => Math.abs(l.end + 0.3 - e.t) < 0.4) || !words.some((w) => w.start < e.t && w.end > e.t);
        const completeness = (startsOnLine ? 0.5 : 0) + (endsOnPhrase ? 0.5 : 0);
        const readable = inLines.filter((l) => l.end - l.start >= 1.2 && (lineText.get(l.id)?.length ?? 0) / (l.end - l.start) <= 17).length;
        const lyric = clamp01(readable / Math.max(3, len / 5));
        const loopability = clamp01((cosine(chromaMean(A, s.t, s.t + 2), chromaMean(A, e.t - 2, e.t)) - 0.5) / 0.5);
        const segs = A.segments.filter((g) => g.end > s.t && g.start < e.t);
        const main = segs.sort((a, b) => (Math.min(e.t, b.end) - Math.max(s.t, b.start)) - (Math.min(e.t, a.end) - Math.max(s.t, a.start)))[0];
        const uniqueness = main ? 1 / (segLabelCount.get(main.label) ?? 1) : 0;
        const crit: Record<Criterion, number> = { hook, energy, lift, vocal, completeness, lyric, loopability, uniqueness };
        let num = 0, den = 0;
        for (const c of CRITERIA) { const w = inp.weights[c] ?? 0; num += w * crit[c]; den += w; }
        const secs = [...new Set(sync.lines.filter((l) => l.end > s.t && l.start < e.t).map((l) => sectionOfLine(l.id)))];
        out.push({
          id: '', start: r3(s.t), end: r3(e.t), duration: r3(len), targetDuration: d, sections: secs,
          criteria: Object.fromEntries(CRITERIA.map((c) => [c, r3(crit[c])])), score: r3(den ? num / den : 0),
          strengths: [], weaknesses: [], justification: '', boundaries: { start: s.why, end: e.why },
        });
        // Détails pour la justification
        (out[out.length - 1] as any)._detail = { hookAt: [...hookLines, ...titleLines].filter((h) => inLines.includes(h)).map((h) => h.start - s.t).sort((a, b) => a - b)[0], energyRatio, vocal, readable, chorusIn: chorusStarts.find((c) => c >= s.t + 2 && c <= s.t + 12), loop: loopability, mainLabel: main?.label };
      }
    }
  }
  return out;
}

function similarity(a: Candidate, b: Candidate): number {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const iou = inter / (Math.max(a.end, b.end) - Math.min(a.start, b.start));
  const sameSection = a.sections[0] && a.sections[0] === b.sections[0] ? 0.5 : 0;
  return Math.max(iou, sameSection);
}

const overlapRatio = (a: Candidate, b: Candidate) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) / Math.min(a.duration, b.duration);

/**
 * Sélection diversifiée (MMR) : λ·score − (1−λ)·similarité maximale avec les extraits déjà retenus,
 * sous contraintes dures (recouvrement ≤ maxOverlap, ≥ 2 sections et ≥ 2 durées différentes).
 */
export function selectDiverse(all: Candidate[], count: number, maxOverlap: number, lambda: number, durations: number[]): Candidate[] {
  const pool = [...all].sort((a, b) => b.score - a.score || a.start - b.start);
  const picked: Candidate[] = [];
  while (picked.length < count) {
    const remaining = count - picked.length;
    const needSection = new Set(picked.map((p) => p.sections[0])).size < 2 && remaining === 1 && picked.length > 0;
    const needDuration = durations.length > 1 && new Set(picked.map((p) => p.targetDuration)).size < 2 && remaining === 1 && picked.length > 0;
    let best: Candidate | undefined;
    let bestVal = -Infinity;
    for (const c of pool) {
      if (picked.includes(c)) continue;
      if (picked.some((p) => overlapRatio(p, c) > maxOverlap)) continue;
      if (needSection && picked.every((p) => p.sections[0] === c.sections[0])) continue;
      if (needDuration && picked.every((p) => p.targetDuration === c.targetDuration)) continue;
      const sim = picked.length ? Math.max(...picked.map((p) => similarity(p, c))) : 0;
      const val = lambda * c.score - (1 - lambda) * sim;
      if (val > bestVal + 1e-12) { bestVal = val; best = c; }
    }
    if (!best) break;
    picked.push(best);
  }
  return picked.map((c, i) => justify({ ...c, id: `cand-${i + 1}`, rank: i + 1 }));
}

function justify(c: Candidate): Candidate {
  const d = (c as any)._detail ?? {};
  delete (c as any)._detail;
  const msg: Record<Criterion, (v: number) => string> = {
    hook: () => (d.hookAt !== undefined ? `accroche (ligne répétée ou titre) à ${d.hookAt.toFixed(1)} s` : 'pas d’accroche identifiée'),
    energy: () => `énergie ${(d.energyRatio ?? 0).toFixed(2)}× la moyenne du titre`,
    lift: () => (d.chorusIn !== undefined ? `entrée du refrain à ${(d.chorusIn - c.start).toFixed(1)} s` : 'dynamique d’ouverture'),
    vocal: () => `voix présente ${Math.round((d.vocal ?? 0) * 100)} % du temps`,
    completeness: (v) => (v >= 1 ? 'commence et finit sur des fins de phrase' : v > 0 ? 'une seule borne sur une fin de phrase' : 'bornes au milieu de phrases'),
    lyric: () => `${d.readable ?? 0} ligne(s) complète(s) lisible(s)`,
    loopability: () => `fin raccordable au début (similarité ${(d.loop ?? 0).toFixed(2)})`,
    uniqueness: (v) => (v >= 1 ? `seul passage de ce type (segment ${d.mainLabel})` : `passage récurrent (segment ${d.mainLabel ?? '?'})`),
  };
  const sorted = [...CRITERIA].sort((a, b) => c.criteria[b] - c.criteria[a]);
  c.strengths = sorted.slice(0, 3).filter((k) => c.criteria[k] >= 0.5).map((k) => `${CRITERIA_LABELS[k]} : ${msg[k](c.criteria[k])}`);
  c.weaknesses = sorted.slice(-2).filter((k) => c.criteria[k] < 0.5).map((k) => `${CRITERIA_LABELS[k]} : ${msg[k](c.criteria[k])}`);
  c.justification = `Extrait ${fmt(c.start)} → ${fmt(c.end)} (${c.duration.toFixed(1)} s, cible ${c.targetDuration} s) couvrant ${c.sections.join(', ') || 'un passage instrumental'}. `
    + `Points forts : ${c.strengths.join(' ; ') || 'aucun critère dominant'}. `
    + (c.weaknesses.length ? `Points faibles : ${c.weaknesses.join(' ; ')}. ` : '')
    + `Début : ${c.boundaries.start} ; fin : ${c.boundaries.end}.`;
  return c;
}

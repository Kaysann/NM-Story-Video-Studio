import fs from 'node:fs';
import path from 'node:path';
import type { ProjectBundle } from '../../model/project';
import type { AudioAnalysis, Candidate, ImageAsset, SyncResolved, TimelineFile } from '../../model/types';
import { resolveAnchor } from '../timeline/anchors';

/**
 * Fiche de proposition d'un Short (règles V1.1, B3) : de quoi décider AVANT toute production.
 * Construite à partir des paroles, de la synchronisation, de la timeline du clip (découpage et scènes de la vidéo
 * existante, plutôt qu'un recadrage mécanique) et des réglages verticaux des illustrations.
 */
export interface ProposalDetail {
  id: string;
  rank?: number;
  start: number;
  end: number;
  duration: number;
  lyrics: { id: string; text: string }[];
  musical: string;
  narrative: string;
  scenes: { id: string; from: number; to: number; illustrations: string[]; transitionIn?: string }[];
  vertical: { asset: string; plan: string }[];
  lyricStyle: string;
  limits: string[];
}

const END_OF_SENTENCE = /[.!?…]["»”)\s]*$/;

/** Plan de cadrage vertical (9:16) d'une illustration d'après assets.json. */
export function verticalPlan(img: ImageAsset | undefined, id: string): { plan: string; limit?: string } {
  if (!img) return { plan: `${id} : illustration inconnue`, limit: `${id} absente d'assets.json` };
  if (img.replace?.['9x16']) return { plan: `remplacée en 9:16 par ${img.replace['9x16']}` };
  if (img.crops?.['9x16']) return { plan: 'recadrage 9:16 dédié (crops)' };
  const fit = img.fits?.['9x16'] ?? img.fit ?? 'cover';
  if (fit !== 'cover') return { plan: fit === 'blurFill' ? 'image entière sur fond flouté (blurFill)' : 'image entière (contain)' };
  const f = img.focal ?? { x: 0.5, y: 0.5 };
  if (!img.size) return { plan: `recadrage sur le point focal (${f.x}, ${f.y})` };
  // Fraction de la largeur conservée par un recadrage 9:16 « cover » d'une image w × h.
  const kept = Math.min(1, (img.size.h * 9) / 16 / img.size.w);
  const plan = `recadrage sur le point focal (${f.x}, ${f.y}), ${Math.round(kept * 100)} % de la largeur conservée`;
  return kept < 0.4 ? { plan, limit: `${id} : recadrage vertical fort (${Math.round(kept * 100)} % de la largeur) — vérifier que les sujets restent dans le cadre` } : { plan };
}

function shortsStyleLabel(b: ProjectBundle): string {
  const rel = b.reels?.params?.timeline;
  if (rel) {
    try {
      const tl = JSON.parse(fs.readFileSync(path.isAbsolute(rel) ? rel : path.join(b.dir, rel), 'utf8')) as TimelineFile;
      const st = tl.scenes.map((s) => s.lyrics?.style).find((s) => s && s !== 'none');
      if (typeof st === 'string') return `${st} (timeline des Shorts)`;
      if (st) return `${(st as any).type ?? 'style'}${(st as any).flow ? `, ${(st as any).flow}` : ''} (timeline des Shorts)`;
    } catch { /* fichier illisible : style par défaut */ }
  }
  const ref = b.project.reels?.lyricStyle ?? b.project.art.lyricStyle;
  return typeof ref === 'string' ? ref : ref ? `${(ref as any).type ?? 'style'} (project.json)` : 'preset:lyrics-reel-cartouche (défaut)';
}

export function proposalDetails(b: ProjectBundle, cands: Candidate[], sync: SyncResolved, analysis: AudioAnalysis): ProposalDetail[] {
  const text = new Map(b.lyrics.sections.flatMap((s) => s.lines.map((l) => [l.id, l.text] as const)));
  const order = b.lyrics.sections.flatMap((s) => s.lines.map((l) => l.id));
  const kind = new Map(b.lyrics.sections.map((s) => [s.id, s.label] as const));
  const actx = { sync, analysis };
  const scenes = (b.timeline?.scenes ?? []).map((sc) => {
    let from = NaN, to = NaN;
    try { from = resolveAnchor(sc.span.from, actx); to = resolveAnchor(sc.span.to, actx); } catch { /* ancre non résolue : scène ignorée */ }
    const tr = sc.transitionIn;
    return { id: sc.id, from, to, illustrations: sc.illustrations.map((i) => i.asset), transitionIn: typeof tr === 'string' ? tr : tr ? (tr as any).type : undefined };
  }).filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to));
  const style = shortsStyleLabel(b);

  return cands.map((c) => {
    const lines = sync.lines.filter((l) => l.start < c.end && l.end > c.start);
    const limits: string[] = [...c.weaknesses];
    const low = lines.filter((l) => l.confidence < 0.5).map((l) => l.id);
    if (low.length) limits.push(`synchronisation à faible confiance : ${low.join(', ')}`);
    const degenerate = lines.filter((l) => l.words.some((w) => w.end - w.start < 0.08)).map((l) => l.id);
    if (degenerate.length) limits.push(`timings de mots dégénérés (karaoké au mot déconseillé) : ${degenerate.join(', ')}`);
    // Pertinence narrative : début et fin de phrase, dialogue, enchaînement des sections.
    const firstIdx = lines.length ? order.indexOf(lines[0].id) : -1;
    const prevText = firstIdx > 0 ? text.get(order[firstIdx - 1]) ?? '' : '';
    const startsClean = firstIdx <= 0 || END_OF_SENTENCE.test(prevText.trim());
    const lastText = lines.length ? text.get(lines[lines.length - 1].id) ?? '' : '';
    const endsClean = END_OF_SENTENCE.test(lastText.trim());
    const dialogue = lines.filter((l) => /^[—–-]\s/.test((text.get(l.id) ?? '').trim())).length;
    const narrative = [
      `sections : ${c.sections.map((s) => kind.get(s) ?? s).join(' → ')}`,
      startsClean ? 'commence en début de phrase' : 'commence en cours de phrase',
      endsClean ? 'finit sur une fin de phrase' : 'finit en cours de phrase',
      dialogue ? `contient un dialogue (${dialogue} réplique(s))` : 'sans dialogue',
    ].join(' ; ');
    if (!startsClean) limits.push('début en cours de phrase (sens à vérifier)');
    if (!endsClean) limits.push('fin en cours de phrase (sens à vérifier)');
    const sc = scenes.filter((s) => s.from < c.end && s.to > c.start);
    const assets = [...new Set(sc.flatMap((s) => s.illustrations))];
    const vertical = assets.map((a) => {
      const v = verticalPlan(b.assets.images.find((i) => i.id === a), a);
      if (v.limit) limits.push(v.limit);
      return { asset: a, plan: v.plan };
    });
    const strong = Object.entries(c.criteria).filter(([, v]) => v >= 0.8).map(([k]) => k);
    return {
      id: c.id, rank: c.rank, start: c.start, end: c.end, duration: c.duration,
      lyrics: lines.map((l) => ({ id: l.id, text: text.get(l.id) ?? '' })),
      musical: `score ${c.score.toFixed(2)} ; critères forts : ${strong.join(', ') || 'aucun'} ; ${c.strengths.join(' ; ') || '—'}`,
      narrative,
      scenes: sc.map((s) => ({ ...s, from: Math.round(s.from * 100) / 100, to: Math.round(s.to * 100) / 100 })),
      vertical,
      lyricStyle: `${style} — à valider (direction artistique propre au projet)`,
      limits,
    };
  });
}

export function proposalMarkdown(details: ProposalDetail[]): string {
  const f = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
  let md = '\n## Fiches détaillées (avant toute production)\n';
  for (const d of details) {
    md += `\n### ${d.rank ?? ''}. ${d.id} — ${f(d.start)} → ${f(d.end)} (${d.duration.toFixed(2)} s)\n\n`;
    md += `- **Paroles** : ${d.lyrics.map((l) => l.text).join(' / ') || '—'}\n`;
    md += `- **Pertinence musicale** : ${d.musical}\n`;
    md += `- **Pertinence narrative** : ${d.narrative}\n`;
    md += `- **Scènes du clip** : ${d.scenes.map((s) => `${s.id} (${s.illustrations.join(', ')}${s.transitionIn ? `, entrée ${s.transitionIn}` : ''})`).join(' ; ') || 'aucune timeline de clip'}\n`;
    md += `- **Montage vertical proposé** : ${d.vertical.map((v) => `${v.asset} — ${v.plan}`).join(' ; ') || '—'}\n`;
    md += `- **Style de paroles envisagé** : ${d.lyricStyle}\n`;
    md += `- **Limites** : ${d.limits.join(' ; ') || 'aucune relevée'}\n`;
  }
  return md;
}

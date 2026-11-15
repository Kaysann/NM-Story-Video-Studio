import type { AudioAnalysis, IllustrationRef, ProjectBundleLike, Scene, SyncResolved, TimelineFile } from './compose.types';

/**
 * Composition automatique : PROPOSITION de timeline.json, entièrement modifiable ensuite.
 * Règles (déterministes) :
 *  - une scène par section de paroles ; intro / interludes / outro si l'écart dépasse le seuil ;
 *  - nombre d'illustrations par scène ≈ durée / durée cible de plan ;
 *  - attribution : d'abord par étiquettes (tags ↔ libellé/type de section), sinon dans l'ordre d'import ;
 *  - mouvements alternés (cycle du projet) ; fondu depuis le noir au début, vers le noir à la fin.
 */
export function composeTimeline(b: ProjectBundleLike, sync: SyncResolved, analysis: AudioAnalysis): { timeline: TimelineFile; rationale: string[] } {
  const rationale: string[] = [];
  // Les fonds d'un générique commun (assets virtuels « cr-… ») ne sont pas des illustrations du récit.
  const images = b.assets.images.filter((i) => !i.id.startsWith('cr-'));
  if (!images.length) throw new Error('Aucune illustration importée (nmsvs import images).');
  const shot = b.project.art.shotLength ?? { min: 6, max: 10 };
  const target = (shot.min + shot.max) / 2;
  const cycle = b.project.art.motionCycle ?? ['preset:slow-push-in', 'preset:drift', 'preset:slow-pull-out', 'preset:pan-left-right'];
  const sections = b.lyrics.sections.filter((s) => sync.sections[s.id]);
  const D = analysis.durationSec;

  type Span = { id: string; from: Scene['span']['from']; label: string; kind: string; start: number; end: number; sectionId?: string; title?: boolean };
  const spans: Span[] = [];
  const firstStart = sections.length ? sync.sections[sections[0].id].start : D;
  if (firstStart > 3) spans.push({ id: 'sc-intro', from: { at: 0 }, label: 'Introduction', kind: 'intro', start: 0, end: firstStart, title: true });
  sections.forEach((s, i) => {
    const st = sync.sections[s.id];
    const from: Scene['span']['from'] = spans.length === 0 ? { at: 0 } : { section: s.id, edge: 'start', offsetSec: -0.3, snap: 'beat' };
    spans.push({ id: `sc-${s.id}`, from, label: s.label, kind: s.kind, start: st.start, end: st.end, sectionId: s.id });
    const next = sections[i + 1];
    if (next) {
      const gap = sync.sections[next.id].start - st.end;
      if (gap > 6) spans.push({ id: `sc-inter-${i + 1}`, from: { section: s.id, edge: 'end', offsetSec: 0.5, snap: 'beat' }, label: 'Interlude', kind: 'instrumental', start: st.end, end: st.end + gap });
    }
  });
  const lastEnd = sections.length ? sync.sections[sections[sections.length - 1].id].end : 0;
  if (D - lastEnd > 4) spans.push({ id: 'sc-outro', from: { section: sections[sections.length - 1].id, edge: 'end', offsetSec: 0.5, snap: 'beat' }, label: 'Final', kind: 'outro', start: lastEnd, end: D });

  // Attribution des illustrations : étiquettes puis tourniquet sans répétition immédiate.
  let rr = 0;
  let mc = 0;
  let lastAsset = '';
  const pick = (sp: Span): string => {
    const words = `${sp.label} ${sp.kind}`.toLowerCase();
    const tagged = images.filter((im) => im.tags?.some((t) => words.includes(t.toLowerCase())) && im.id !== lastAsset);
    let id: string;
    if (tagged.length) id = tagged[rr % tagged.length].id;
    else {
      id = images[rr % images.length].id;
      if (id === lastAsset && images.length > 1) id = images[++rr % images.length].id;
    }
    rr++;
    lastAsset = id;
    return id;
  };

  const scenes: Scene[] = spans.map((sp, i) => {
    const dur = (spans[i + 1]?.start ?? D) - sp.start;
    const count = Math.max(1, Math.min(8, Math.round(dur / target)));
    const ills: IllustrationRef[] = Array.from({ length: count }, () => ({ asset: pick(sp), motion: cycle[mc++ % cycle.length] }));
    const to: Scene['span']['to'] = i + 1 < spans.length ? spans[i + 1].from : { end: true };
    const sc: Scene = {
      id: sp.id, span: { from: sp.from, to }, illustrations: ills, distribution: sp.sectionId ? 'byLines' : 'even',
      note: `${sp.label} — ${dur.toFixed(1)} s, ${count} plan(s) d’environ ${(dur / count).toFixed(1)} s`,
    };
    if (i === 0) sc.transitionIn = 'preset:fade-black';
    if (i === spans.length - 1) sc.transitionOut = 'preset:fade-black';
    if (sp.title) sc.title = { text: b.project.title, style: 'preset:title-plain', durationSec: Math.min(5, Math.max(2, dur - 1)) };
    if (!sp.sectionId) sc.lyrics = { style: 'none' };
    return sc;
  });
  rationale.push(`${scenes.length} scènes : une par section de paroles${spans.some((s) => s.id === 'sc-intro') ? ', une introduction titrée' : ''}${spans.some((s) => s.id.startsWith('sc-inter')) ? ', des interludes instrumentaux (> 6 s)' : ''}${spans.some((s) => s.id === 'sc-outro') ? ', un final' : ''}.`);
  rationale.push(`Durée cible des plans : ${target} s (art.shotLength), changements d’illustration calés sur les débuts de lignes (byLines) ou les temps forts (even).`);
  rationale.push(`${images.length} illustration(s) réparties ${images.some((i) => i.tags?.length) ? 'selon leurs étiquettes, puis ' : ''}dans l’ordre d’import, sans répétition immédiate.`);
  rationale.push(`Mouvements alternés : ${cycle.join(', ')}. Ouverture et fin en fondu au noir. Style de paroles : celui du projet.`);
  return { timeline: { $schema: 'https://nmsvs.local/schemas/timeline/v1.json', schemaVersion: 1, scenes }, rationale };
}

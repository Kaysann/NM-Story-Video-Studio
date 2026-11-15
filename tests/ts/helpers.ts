import type { ProjectBundle } from '../../src/model/project';
import type { AudioAnalysis, LyricsFile, SyncResolved, TimedLine, TimelineFile } from '../../src/model/types';
import { defaultProject } from '../../src/modules/project/init';
import { resolveSync, uniformLines } from '../../src/modules/sync/merge';
import type { ImageInfo } from '../../src/modules/timeline/compile';

export const LYRICS: LyricsFile = {
  schemaVersion: 1,
  language: 'fr',
  title: 'Le Phare Test',
  sections: [
    { id: 'verse-1', kind: 'verse', label: 'Couplet 1', lines: [
      { id: 'verse-1.l1', text: 'Sous le phare des collines' }, { id: 'verse-1.l2', text: 'Les étoiles se souviennent' },
      { id: 'verse-1.l3', text: 'Du chemin des anciens rois' }, { id: 'verse-1.l4', text: 'Et du feu sous la neige' }] },
    { id: 'chorus-1', kind: 'chorus', label: 'Refrain', lines: [
      { id: 'chorus-1.l1', text: 'Le Phare Test brille encore' }, { id: 'chorus-1.l2', text: 'Chante encore' }] },
    { id: 'verse-2', kind: 'verse', label: 'Couplet 2', lines: [
      { id: 'verse-2.l1', text: 'Le vent porte nos histoires' }, { id: 'verse-2.l2', text: 'Jusqu’au bout de la nuit' },
      { id: 'verse-2.l3', text: 'Les tambours de la vallée' }, { id: 'verse-2.l4', text: 'Répondent à nos cris' }] },
    { id: 'chorus-2', kind: 'chorus', label: 'Refrain', repeatOf: 'chorus-1', lines: [
      { id: 'chorus-2.l1', text: 'Le Phare Test brille encore' }, { id: 'chorus-2.l2', text: 'Chante encore' }] },
    { id: 'bridge-1', kind: 'bridge', label: 'Pont', lines: [{ id: 'bridge-1.l1', text: 'Un silence avant l’orage' }] },
    { id: 'chorus-3', kind: 'chorus', label: 'Refrain', repeatOf: 'chorus-1', lines: [
      { id: 'chorus-3.l1', text: 'Le Phare Test brille encore' }, { id: 'chorus-3.l2', text: 'Chante encore' }] },
  ],
};

/** Analyse synthétique : 120 BPM, 4/4, énergie plus forte dans les refrains. */
export function analysis(durationSec = 90): AudioAnalysis {
  const beats: number[] = [];
  for (let t = 0.5; t < durationSec; t += 0.5) beats.push(Math.round(t * 1000) / 1000);
  const rms = Array.from({ length: Math.ceil(durationSec / 0.05) }, (_, i) => {
    const t = i * 0.05;
    const chorus = (t > 24 && t < 32) || (t > 56 && t < 64) || (t > 74 && t < 84);
    return chorus ? 0.3 : 0.12;
  });
  return {
    version: 1, audioSha256: '0'.repeat(64), durationSec, sampleRate: 44100, channels: 2,
    tempo: { bpm: 120, confidence: 0.8 }, beats, downbeats: beats.filter((_, i) => i % 4 === 0), meter: 4, onsets: beats,
    rms: { hopSec: 0.05, values: rms }, novelty: { hopSec: 0.5, values: [] }, vocalBand: { hopSec: 0.1, values: [] },
    chroma: { hopSec: 0.5, values: Array.from({ length: Math.ceil(durationSec / 0.5) }, (_, i) => Array.from({ length: 12 }, (_, k) => ((i + k) % 12 === 0 ? 1 : 0.1))) },
    segments: [{ start: 0, end: 24, label: 'A' }, { start: 24, end: 32, label: 'B' }, { start: 32, end: 56, label: 'A' }, { start: 56, end: 64, label: 'B' }, { start: 64, end: 74, label: 'C' }, { start: 74, end: durationSec, label: 'B' }],
  };
}

/** Synchronisation synthétique placée de façon réaliste (sections espacées). */
export function syncFor(durationSec = 90): SyncResolved {
  const starts: Record<string, number> = { 'verse-1': 8, 'chorus-1': 24, 'verse-2': 40, 'chorus-2': 56, 'bridge-1': 66, 'chorus-3': 74 };
  const lines: TimedLine[] = [];
  for (const s of LYRICS.sections) {
    let t = starts[s.id];
    for (const l of s.lines) {
      const toks = l.text.split(' ');
      const words = toks.map((w, i) => ({ id: `${l.id}.w${i + 1}`, text: w, start: t + i * 0.45, end: t + i * 0.45 + 0.4, confidence: 0.8, source: 'auto' as const }));
      lines.push({ id: l.id, start: t, end: t + toks.length * 0.45, confidence: 0.8, source: 'auto', words });
      t += toks.length * 0.45 + 1.2;
    }
  }
  return resolveSync({ version: 1, engine: 'test', audioSha256: '0'.repeat(64), lyricsHash: 'x', lines }, { schemaVersion: 1 }, LYRICS, durationSec);
}

export function uniformSync(durationSec = 90): SyncResolved {
  return resolveSync({ version: 1, engine: 'uniform', audioSha256: '0'.repeat(64), lyricsHash: 'x', lines: uniformLines(LYRICS, durationSec) }, { schemaVersion: 1 }, LYRICS, durationSec);
}

export const TIMELINE: TimelineFile = {
  schemaVersion: 1,
  scenes: [
    { id: 'sc-intro', span: { from: { at: 0 }, to: { section: 'verse-1', edge: 'start', offsetSec: -0.3, snap: 'beat' } }, illustrations: [{ asset: 'img-a' }], transitionIn: 'preset:fade-black', title: { text: 'Le Phare Test' }, lyrics: { style: 'none' } },
    { id: 'sc-v1', span: { from: { section: 'verse-1', edge: 'start', offsetSec: -0.3, snap: 'beat' }, to: { section: 'chorus-1', edge: 'start' } }, illustrations: [{ asset: 'img-a' }, { asset: 'img-b', motion: 'preset:pan-left-right' }], lyrics: { style: 'preset:lyrics-parchment-default' } },
    { id: 'sc-c1', span: { from: { section: 'chorus-1', edge: 'start' }, to: { section: 'verse-2', edge: 'start' } }, illustrations: [{ asset: 'img-c', motion: 'preset:beat-pulse' }], transitionIn: 'preset:slide-left', lyrics: { style: 'preset:lyrics-text-on-image-default', karaoke: 'word' } },
    { id: 'sc-rest', span: { from: { section: 'verse-2', edge: 'start' }, to: { end: true } }, illustrations: [{ asset: 'img-b' }, { asset: 'img-c' }, { asset: 'img-a' }], transitionIn: 'preset:dip-to-color', transitionOut: 'preset:fade-black' },
  ],
};

export function bundle(over: Partial<ProjectBundle> = {}): ProjectBundle {
  const project = defaultProject('test', 'Le Phare Test', ['16x9', '9x16']);
  return {
    dir: 'C:/inexistant/projet test',
    project,
    assets: { schemaVersion: 1, images: ['img-a', 'img-b', 'img-c'].map((id) => ({ id, path: `media/images/${id}.png`, size: { w: 5120, h: 2880 }, focal: { x: 0.5, y: 0.5 } })) },
    lyrics: LYRICS,
    timeline: structuredClone(TIMELINE),
    overrides: { schemaVersion: 1 },
    ...over,
  };
}

/** Résolveur d'images factice : dérivé « parfait » à la taille cadre × marge. */
export const fakeImages = (W: number, H: number) => (id: string, m: number): ImageInfo => ({ rel: `img/${id}-${m}.png`, sha: `${id}${m}`, w: Math.round(W * m), h: Math.round(H * m), upscale: 1, subjectCut: 0, sourceId: id, fit: 'cover' });
export const noStage = () => null;

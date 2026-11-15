import type { LyricsFile, SyncResolved } from '../../model/types';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function stamp(t: number, sep: ',' | '.') {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

function textOf(lyrics: LyricsFile, id: string) {
  return lyrics.sections.flatMap((s) => s.lines).find((l) => l.id === id)?.text ?? '';
}

export function toSrt(sync: SyncResolved, lyrics: LyricsFile, offsetSec = 0): string {
  return sync.lines
    .map((l, i) => `${i + 1}\n${stamp(l.start - offsetSec, ',')} --> ${stamp(l.end - offsetSec, ',')}\n${textOf(lyrics, l.id)}\n`)
    .join('\n');
}

export function toVtt(sync: SyncResolved, lyrics: LyricsFile, offsetSec = 0): string {
  return 'WEBVTT\n\n' + sync.lines.map((l) => `${stamp(l.start - offsetSec, '.')} --> ${stamp(l.end - offsetSec, '.')}\n${textOf(lyrics, l.id)}\n`).join('\n');
}

/** LRC étendu (A2) : horodatage par ligne et par mot. */
export function toLrc(sync: SyncResolved, title?: string): string {
  const lrcStamp = (t: number) => {
    const cs = Math.max(0, Math.round(t * 100));
    return `${pad(Math.floor(cs / 6000))}:${pad(Math.floor((cs % 6000) / 100))}.${pad(cs % 100)}`;
  };
  const head = title ? `[ti:${title}]\n` : '';
  return head + sync.lines.map((l) => `[${lrcStamp(l.start)}]` + l.words.map((w) => `<${lrcStamp(w.start)}>${w.text} `).join('').trimEnd()).join('\n') + '\n';
}

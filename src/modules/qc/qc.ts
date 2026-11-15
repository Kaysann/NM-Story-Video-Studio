import { run } from '../../core/exec';
import { ffprobeJson, TOOLS } from '../../core/tools';
import type { RTimeline } from '../../remotion/types';
import type { SyncResolved } from '../../model/types';
import type { CompileWarning } from '../timeline/compile';
import { measureLoudness } from '../analysis/analyze';

export type Severity = 'bloquant' | 'majeur' | 'mineur' | 'info';
export interface QcCheck { id: string; label: string; status: 'ok' | 'ko' | 'info'; severity: Severity; detail: string }
export interface QcReport { file: string; checks: QcCheck[]; blocking: boolean; major: number; minor: number }

export interface ExpectedOutput {
  width: number; height: number; fps: number; videoCodec: string; pixFmt: string; audioCodec: string; sampleRate: number;
  durationSec: number;
}

export interface QcInput {
  file: string;
  expected: ExpectedOutput;
  timeline: RTimeline;
  warnings: CompileWarning[];
  sync?: SyncResolved;
  mezzanine?: string;
  /** Master (et extrait éventuel) pour comparer la sonie. */
  master?: { file: string; startSec?: number; durSec?: number };
  vmaf?: boolean;
}

const KNOWN_SHOT_FIT = ['cover', 'contain', 'blurFill'];
const KNOWN_LYRICS = ['text-on-image', 'parchment', 'cartouche'];
const KNOWN_TITLES = ['plain', 'parchment'];

function parseIntervals(stderr: string, startKey: string, endKey: string): [number, number][] {
  const out: [number, number][] = [];
  const re = new RegExp(`${startKey}:\\s*([\\d.]+)[\\s\\S]*?${endKey}:\\s*([\\d.]+)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) out.push([Number(m[1]), Number(m[2])]);
  return out;
}

/** Contrôles qualité d'un export (docs/09 §3, avec QC-E7 révisé : CHANGELOG C-02). */
export async function runQc(q: QcInput): Promise<QcReport> {
  const checks: QcCheck[] = [];
  const add = (id: string, label: string, ok: boolean, severity: Severity, detail: string) => checks.push({ id, label, status: ok ? 'ok' : severity === 'info' ? 'info' : 'ko', severity, detail });
  const e = q.expected;
  const p = await ffprobeJson(q.file);
  const v = p.streams.find((s: any) => s.codec_type === 'video');
  const a = p.streams.find((s: any) => s.codec_type === 'audio');
  const [num, den] = String(v?.r_frame_rate ?? '0/1').split('/').map(Number);
  const fps = num / (den || 1);
  add('QC-T1', 'Résolution, fréquence, codec, format de pixels', !!v && v.width === e.width && v.height === e.height && Math.abs(fps - e.fps) < 0.01 && v.codec_name === e.videoCodec && v.pix_fmt === e.pixFmt, 'bloquant',
    `${v?.width}×${v?.height} @ ${fps.toFixed(3)} i/s, ${v?.codec_name} ${v?.profile ?? ''} ${v?.pix_fmt} (attendu ${e.width}×${e.height} @ ${e.fps}, ${e.videoCodec} ${e.pixFmt})`);
  const tags = [v?.color_primaries, v?.color_transfer, v?.color_space];
  add('QC-T2', 'Balises couleur BT.709', tags.every((x) => x === 'bt709'), 'majeur', `primaires=${tags[0]} transfert=${tags[1]} matrice=${tags[2]} plage=${v?.color_range}`);
  const vdur = Number(v?.duration ?? p.format.duration);
  const adur = Number(a?.duration ?? 0);
  const frame = 1 / e.fps;
  const durOk = Math.abs(vdur - e.durationSec) <= frame + 1e-3 && Math.abs(adur - vdur) <= frame + 0.03;
  add('QC-T3', 'Durée vidéo / audio / attendue (± 1 image)', durOk, 'bloquant', `vidéo ${vdur.toFixed(3)} s, audio ${adur.toFixed(3)} s, attendu ${e.durationSec.toFixed(3)} s`);
  add('QC-T4', 'Audio : codec, fréquence, stéréo', !!a && a.codec_name === e.audioCodec && Number(a.sample_rate) === e.sampleRate && a.channels === 2, 'bloquant',
    `${a?.codec_name} ${a?.sample_rate} Hz ${a?.channels} canaux`);

  if (q.master) {
    const exp = await measureLoudness(q.file);
    if (q.master.startSec === undefined) {
      const ref = await measureLoudness(q.master.file);
      const dl = Math.abs(exp.integratedLUFS - ref.integratedLUFS);
      // Tolérance de crête : +1 dB (dépassements intersamples usuels du codage AAC d'un master déjà limité).
      add('QC-T5', 'Sonie identique au master (EBU R128)', dl <= 0.5 && exp.truePeakDBTP <= ref.truePeakDBTP + 1.0, 'majeur',
        `export ${exp.integratedLUFS} LUFS / crête ${exp.truePeakDBTP} dBFS ; master ${ref.integratedLUFS} LUFS / ${ref.truePeakDBTP} dBFS`);
    } else add('QC-T5', 'Sonie de l’extrait (information)', true, 'info', `${exp.integratedLUFS} LUFS, crête ${exp.truePeakDBTP} dBFS`);
  }

  // Noir non prévu : intervalles noirs hors calques de fondu (tolérance 0,5 s).
  const bd = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-i', q.file, '-an', '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-f', 'null', '-']);
  const blacks = parseIntervals(bd.stderr, 'black_start', 'black_end');
  const fadeSec = q.timeline.fades.map((f) => [f.from / e.fps - 0.5, f.to / e.fps + 0.5]);
  const unexpected = blacks.filter(([s, en]) => !fadeSec.some(([a0, a1]) => s >= a0 && en <= a1));
  add('QC-T6', 'Images noires non prévues', unexpected.length === 0, 'majeur', unexpected.length ? unexpected.map(([s, en]) => `${s.toFixed(2)}–${en.toFixed(2)} s`).join(', ') : `${blacks.length} intervalle(s) noir(s), tous dans des fondus prévus`);

  const fd = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-i', q.file, '-an', '-vf', 'freezedetect=n=0.0005:d=2', '-f', 'null', '-']);
  // Préambule : la couverture est volontairement figée (tolérance 1 s, le mouvement repart en douceur).
  const preSec = (q.timeline.prerollFrames ?? 0) / e.fps;
  const freezes = parseIntervals(fd.stderr, 'freeze_start', 'freeze_end').filter(([s, en]) => !(preSec > 0 && s < 0.1 && en <= preSec + 1));
  add('QC-T7', 'Images figées (> 2 s)', freezes.length === 0, 'mineur', freezes.length ? `${freezes.length} : ${freezes.slice(0, 6).map(([s, en]) => `${s.toFixed(1)}–${en.toFixed(1)} s`).join(', ')} (plans fixes voulus ?)` : 'aucune');

  // Fidélité export / segments rendus (SSIM, VMAF échantillonné) — sert aussi QC-E7.
  let ssim = NaN;
  if (q.mezzanine) {
    const mid = Math.max(0, vdur / 2 - 2.5);
    const len = Math.min(5, vdur);
    const r = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-ss', String(mid), '-t', String(len), '-i', q.file, '-ss', String(mid), '-t', String(len), '-i', q.mezzanine,
      '-lavfi', `[0:v]scale=${e.width}:${e.height}[a];[1:v]scale=${e.width}:${e.height}[b];[a][b]ssim`, '-f', 'null', '-']);
    const m = r.stderr.match(/All:([\d.]+)/);
    ssim = m ? Number(m[1]) : NaN;
    if (q.vmaf) {
      const rv = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-ss', String(mid), '-t', String(len), '-i', q.file, '-ss', String(mid), '-t', String(len), '-i', q.mezzanine,
        '-lavfi', `[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]libvmaf=n_threads=6`, '-f', 'null', '-']);
      const mv = rv.stderr.match(/VMAF score:\s*([\d.]+)/);
      const vmaf = mv ? Number(mv[1]) : NaN;
      add('QC-T8', 'Fidélité au rendu (VMAF échantillon 5 s)', vmaf >= 93, 'majeur', `VMAF ${Number.isNaN(vmaf) ? 'non mesuré' : vmaf.toFixed(2)} (≥ 93)`);
    } else add('QC-T8', 'Fidélité au rendu (SSIM échantillon 5 s)', ssim >= 0.97, 'majeur', `SSIM ${Number.isNaN(ssim) ? 'non mesuré' : ssim.toFixed(4)} (≥ 0,97)`);
  }

  const w = (code: string) => q.warnings.filter((x) => x.code === code);
  add('QC-E1', 'Paroles dans la zone de sécurité', w('QC-E1').length === 0, 'bloquant', w('QC-E1').map((x) => x.message).join(' ; ') || `${q.timeline.lyrics.length} bloc(s) de paroles dans la zone sûre`);
  add('QC-E2', 'Durée de lecture des lignes', w('QC-E2').length === 0, 'mineur', w('QC-E2').map((x) => x.message).slice(0, 8).join(' ; ') || 'conforme (≥ 1 s, ≤ 17 car./s)');
  if (q.sync) {
    const low = q.sync.lines.filter((l) => l.confidence < 0.5 && l.source !== 'override');
    add('QC-E3', 'Lignes à faible confiance non corrigées', true, 'info', q.sync.engine === 'uniform' ? 'moteur uniforme : synchronisation non issue de l’audio' : `${low.length} : ${low.slice(0, 10).map((l) => l.id).join(', ')}`);
  }
  // QC-E4 : contraste entre la couleur du texte et la luminance moyenne mesurée dans la boîte de paroles
  // (échantillon de 12 blocs, image médiane de chaque bloc). Approximation : la mesure inclut les pixels du texte.
  const samples = q.timeline.lyrics.filter((_, i, a) => a.length <= 12 || i % Math.ceil(a.length / 12) === 0).slice(0, 12);
  const lowContrast: string[] = [];
  const scale = e.width / q.timeline.width;
  for (const l of samples) {
    const t = ((l.from + l.to) / 2) / q.timeline.fps;
    const bx = l.style.type === 'text-on-image' ? l.box : l.groupBox;
    if (!bx || !Number.isFinite(t) || !l.style.color) continue; // bloc mal formé : signalé par QC-E7
    const crop = `crop=${Math.max(2, Math.round(bx.w * scale))}:${Math.max(2, Math.round(bx.h * scale))}:${Math.round(bx.x * scale)}:${Math.round(bx.y * scale)}`;
    const r = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostdin', '-ss', t.toFixed(3), '-i', q.file, '-frames:v', '1', '-vf', `${crop},signalstats,metadata=print:key=lavfi.signalstats.YAVG`, '-f', 'null', '-']);
    const yavg = Number(r.stderr.match(/YAVG=([\d.]+)/)?.[1]);
    if (Number.isNaN(yavg)) continue;
    const bg = relLuminanceFromY(yavg);
    const fg = relLuminance(l.style.color);
    const ratio = (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
    if (ratio < 4.5) lowContrast.push(`${l.id} (${ratio.toFixed(1)}:1)`);
  }
  add('QC-E4', 'Contraste texte / fond (≥ 4,5:1, mesure approchée)', lowContrast.length === 0, 'mineur',
    lowContrast.length ? lowContrast.join(', ') : `${samples.length} bloc(s) échantillonné(s), contraste suffisant`);
  add('QC-E5', 'Agrandissement des illustrations', w('QC-E5').length === 0, 'majeur', w('QC-E5').map((x) => x.message).join(' ; ') || 'dans les limites');
  add('QC-E6', 'Sujet coupé par le recadrage', w('QC-E6').length === 0, 'mineur', w('QC-E6').map((x) => x.message).join(' ; ') || 'aucun sujet coupé > 15 %');
  const unknown = [
    ...q.timeline.shots.filter((s) => !KNOWN_SHOT_FIT.includes(s.fit)).map((s) => s.id),
    ...q.timeline.lyrics.filter((l) => !KNOWN_LYRICS.includes(l.style.type)).map((l) => l.id),
    ...q.timeline.titles.filter((x) => !KNOWN_TITLES.includes(x.type)).map((x) => x.id),
    // Sprite déclaré dans timeline.json : toutes ses poses doivent désigner un fichier préparé.
    ...(q.timeline.sprites ?? []).filter((s) => !s.frames.length || s.frames.some((f) => !f)).map((s) => s.id),
  ];
  const layersOk = unknown.length === 0 && !q.timeline.showSafe && (Number.isNaN(ssim) || ssim >= 0.95);
  add('QC-E7', 'Intégrité des calques (aucun calque non déclaré ajouté)', layersOk, 'bloquant',
    `${unknown.length ? `calques inconnus : ${unknown.join(', ')} ; ` : ''}${q.timeline.showSafe ? 'superposition des zones sûres active ; ' : ''}SSIM export/segments ${Number.isNaN(ssim) ? 'n/m' : ssim.toFixed(4)}. Ne détecte pas un filigrane présent dans une illustration source.`);
  add('QC-E8', 'Couverture de la timeline', true, 'bloquant', 'vérifiée à la compilation (aucun trou)');
  const ko = checks.filter((c) => c.status === 'ko');
  return { file: q.file, checks, blocking: ko.some((c) => c.severity === 'bloquant'), major: ko.filter((c) => c.severity === 'majeur').length, minor: ko.filter((c) => c.severity === 'mineur').length };
}

/** Luminance relative WCAG d'une couleur #RRGGBB(AA). */
export function relLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Luminance relative approchée à partir d'une moyenne de luma Y (plage limitée 16–235). */
export function relLuminanceFromY(y: number): number {
  const v = Math.max(0, Math.min(1, (y - 16) / 219));
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function qcMarkdown(r: QcReport): string {
  const icon = (c: QcCheck) => (c.status === 'ok' ? '✅' : c.status === 'info' ? 'ℹ️' : c.severity === 'bloquant' ? '⛔' : c.severity === 'majeur' ? '❌' : '⚠️');
  return `| | Contrôle | Gravité | Détail |\n|---|---|---|---|\n${r.checks.map((c) => `| ${icon(c)} ${c.id} | ${c.label} | ${c.severity} | ${c.detail.replace(/\|/g, '\\|')} |`).join('\n')}\n\n**Bilan** : ${r.blocking ? '⛔ BLOQUANT' : r.major ? `❌ ${r.major} majeur(s)` : '✅ aucun défaut bloquant ou majeur'}${r.minor ? `, ${r.minor} mineur(s)` : ''}.\n`;
}

import fs from 'node:fs';
import path from 'node:path';
import { NmsvsError } from '../../core/errors';
import { ffprobeJson } from '../../core/tools';
import { loadManifest } from '../../pipeline/manifest';
import { addDecision } from './init';

/**
 * Nettoyage sûr (règles V1.1, B5 + règle de sécurité absolue de préservation des sources).
 *
 * LISTE BLANCHE STRICTE : seuls les fichiers intermédiaires générés par NMSVS et régénérables sont supprimables :
 *   - build/<rendu>/segments/<clé>.mp4 (+ partiels .tmp)  → segments vidéo rendus (cache de rendu) ;
 *   - build/<rendu>/mezzanine-<clé>.mp4|.mov              → concaténation intermédiaire avant encodage final ;
 *   - exports/<nom>.tmp.<ext>                             → sortie partielle d'un encodage interrompu.
 * Tout le reste est conservé : sources (media/), copies importées, JSON, analyses, dérivés d'illustrations, exports
 * (y compris archives historiques), rapports, décisions, fichiers inconnus. Aucun lien symbolique n'est suivi.
 *
 * Refus (rien n'est supprimé) si : une commande longue est en cours, un fichier a été modifié depuis moins de
 * `quietSec` secondes (traitement actif probable), ou un MP4 final d'exports/ ne se lit pas correctement.
 */
const ALLOWED: { re: RegExp; kind: string }[] = [
  { re: /^build\/[\w.@-]+\/segments\/[0-9a-f]{8,}(\.tmp)?\.(mp4|mov)$/i, kind: 'segment de rendu' },
  { re: /^build\/[\w.@-]+\/mezzanine-[0-9a-f]{8,}(\.tmp)?\.(mp4|mov)$/i, kind: 'mezzanine intermédiaire' },
  { re: /^exports\/[^/]+\.tmp\.(mp4|mov|mkv)$/i, kind: 'export partiel interrompu' },
];

export interface CleanResult {
  applied: boolean;
  removed: { file: string; kind: string; bytes: number }[];
  bytes: number;
  verifiedExports: string[];
  outOfScope: string[]; // fichiers d'exports/ non livrables : jamais supprimés sans autorisation distincte
}

function walk(dir: string, root: string, out: string[]) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue; // jamais suivi
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, root, out);
    else if (e.isFile()) out.push(path.relative(root, p).split(path.sep).join('/'));
  }
}

export function classify(rel: string): string | undefined {
  return ALLOWED.find((a) => a.re.test(rel))?.kind;
}

async function readableMp4(file: string): Promise<boolean> {
  try {
    const j = await ffprobeJson(file);
    return Number(j?.format?.duration) > 0 && (j?.streams ?? []).some((s: any) => s.codec_type === 'video');
  } catch {
    return false;
  }
}

export async function cleanProject(projectDir: string, opts: { apply?: boolean; quietSec?: number; verify?: (file: string) => Promise<boolean> } = {}): Promise<CleanResult> {
  const root = fs.realpathSync(projectDir);
  const quietSec = opts.quietSec ?? 120;
  const verify = opts.verify ?? readableMp4;

  const lc = loadManifest(root).lastCommand;
  if (lc?.status === 'running') {
    throw new NmsvsError('E_CLEAN_REFUSED', `Une commande est marquée en cours (${lc.argv.join(' ')}, ${lc.at}) : nettoyage refusé.`, 'Attendre sa fin, ou la terminer / la reprendre (`nmsvs resume`) puis relancer le nettoyage. En cas de doute, ne rien supprimer.');
  }
  const files: string[] = [];
  walk(path.join(root, 'build'), root, files);
  walk(path.join(root, 'exports'), root, files);
  const now = Date.now();
  const recent = files.filter((f) => now - fs.statSync(path.join(root, f)).mtimeMs < quietSec * 1000);
  if (recent.length) {
    throw new NmsvsError('E_CLEAN_REFUSED', `Fichiers modifiés il y a moins de ${quietSec} s (traitement actif probable) : ${recent.slice(0, 3).join(', ')}${recent.length > 3 ? '…' : ''}`, 'Relancer le nettoyage une fois les traitements terminés.');
  }
  // Vérification préalable des MP4 finaux : les intermédiaires ne sont supprimés que si les livrables sont sains.
  const finals = files.filter((f) => /^exports\/[^/]+\.mp4$/i.test(f) && !/\.tmp\.mp4$/i.test(f) && !/\.REJECTED\.mp4$/i.test(f));
  const verified: string[] = [];
  for (const f of finals) {
    if (!(await verify(path.join(root, f)))) throw new NmsvsError('E_CLEAN_REFUSED', `MP4 final illisible ou incomplet : ${f}`, 'Vérifier ou refaire cet export avant tout nettoyage (ses intermédiaires peuvent être nécessaires).');
    verified.push(f);
  }
  const removed: CleanResult['removed'] = [];
  for (const f of files) {
    const kind = classify(f);
    if (!kind) continue;
    const abs = path.join(root, f);
    // Garde-fou : le chemin réel doit rester sous build/ ou exports/ du projet.
    const real = fs.realpathSync(abs);
    if (!(real.startsWith(path.join(root, 'build') + path.sep) || real.startsWith(path.join(root, 'exports') + path.sep))) continue;
    removed.push({ file: f, kind, bytes: fs.statSync(abs).size });
  }
  if (opts.apply) {
    for (const r of removed) fs.rmSync(path.join(root, r.file));
    if (removed.length) addDecision(root, { by: 'user', via: 'nmsvs clean --apply', scope: 'maintenance', decision: `Nettoyage des intermédiaires régénérables : ${removed.length} fichier(s), ${(removed.reduce((s, r) => s + r.bytes, 0) / 2 ** 20).toFixed(1)} Mo (liste dans le rapport d'exécution)` });
  }
  const outOfScope = files.filter((f) => f.startsWith('exports/') && !classify(f) && !finals.includes(f));
  return { applied: !!opts.apply, removed, bytes: removed.reduce((s, r) => s + r.bytes, 0), verifiedExports: verified, outOfScope };
}

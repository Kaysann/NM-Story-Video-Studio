import path from 'node:path';
import { writeFileAtomic, writeJsonAtomic } from '../../core/fsx';
import { toolVersions } from '../../core/tools';
import type { RunContext } from '../../core/context';

/** Rapport d'exécution (Markdown + JSON) dans le dossier de l'exécution. */
export async function writeRunReport(ctx: RunContext, status: 'ok' | 'error', result: unknown, error?: { code: string; message: string; action?: string }, extraMd = '') {
  ctx.persist();
  const versions = await toolVersions();
  const durationSec = (Date.now() - ctx.startedAt.getTime()) / 1000;
  const json = {
    id: ctx.id, command: ctx.command, project: ctx.projectDir, status, startedAt: ctx.startedAt.toISOString(), durationSec,
    steps: ctx.steps, warnings: ctx.warnings, artifacts: ctx.artifacts, versions, error, result,
  };
  writeJsonAtomic(path.join(ctx.dir, 'report.json'), json);
  const fmtS = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
  let md = `# Rapport — \`nmsvs ${ctx.command}\`\n\n- Exécution : ${ctx.id}\n- Statut : **${status === 'ok' ? 'succès' : `échec (${error?.code})`}**\n- Durée : ${durationSec.toFixed(1)} s\n`;
  if (ctx.projectDir) md += `- Projet : ${ctx.projectDir}\n`;
  if (error) md += `\n## Erreur\n\n${error.message}\n\n${error.action ? `**Action proposée** : ${error.action}\n` : ''}`;
  if (ctx.steps.length) md += `\n## Étapes\n\n| Étape | Statut | Durée |\n|---|---|---|\n${ctx.steps.map((s) => `| ${s.id} | ${s.status === 'cached' ? 'en cache' : s.status === 'done' ? 'calculée' : 'échec'} | ${fmtS(s.durationMs)} |`).join('\n')}\n`;
  if (ctx.warnings.length) md += `\n## Alertes (${ctx.warnings.length})\n\n${ctx.warnings.map((w) => `- \`${w.code}\` ${w.message}`).join('\n')}\n`;
  if (ctx.artifacts.length) md += `\n## Fichiers produits\n\n${ctx.artifacts.map((a) => `- ${a}`).join('\n')}\n`;
  md += extraMd ? `\n${extraMd}\n` : '';
  md += `\n## Versions\n\nNode ${versions.node} · NMSVS ${versions.nmsvs} · Remotion ${versions.remotion} · FFmpeg ${versions.ffmpeg}\n`;
  writeFileAtomic(path.join(ctx.dir, 'report.md'), md);
  return path.join(ctx.dir, 'report.md');
}

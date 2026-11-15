import fs from 'node:fs';
import { hashObject } from '../core/hash';
import type { RunContext } from '../core/context';
import { asNmsvsError } from '../core/errors';
import { loadManifest, updateManifest } from './manifest';

export interface StepDef<T> {
  /** Identifiant unique dans le projet (ex. "analyze-audio", "prepare-assets:16x9"). */
  id: string;
  /** Incrémenter quand l'algorithme change : invalide les résultats antérieurs. */
  version: number;
  /** Description hachable de TOUTES les entrées (hash de fichiers, paramètres, versions d'outils). */
  inputs: unknown;
  /** Fichiers produits : l'étape est refaite si l'un manque. */
  outputs: string[];
  run: () => Promise<T>;
  /** Relecture du résultat quand l'étape est en cache. */
  load: () => T;
}

export function stepKey(def: Pick<StepDef<unknown>, 'id' | 'version' | 'inputs'>): string {
  return hashObject({ id: def.id, version: def.version, inputs: def.inputs });
}

/**
 * Exécute une étape avec cache : saute si la clé est inchangée et les sorties présentes.
 * L'état est écrit dans le manifeste avant et après (reprise après interruption).
 */
export async function runStep<T>(ctx: RunContext, projectDir: string, def: StepDef<T>, force = false): Promise<{ value: T; cached: boolean }> {
  const key = stepKey(def);
  const prev = loadManifest(projectDir).steps[def.id];
  if (!force && prev && prev.key === key && prev.status === 'done' && def.outputs.every((o) => fs.existsSync(o))) {
    ctx.steps.push({ id: def.id, status: 'cached', durationMs: 0, key });
    ctx.log.info('à jour (cache)', undefined, def.id);
    return { value: def.load(), cached: true };
  }
  const t0 = performance.now();
  updateManifest(projectDir, (m) => {
    m.steps[def.id] = { key, status: 'running', startedAt: new Date().toISOString() };
  });
  try {
    const value = await def.run();
    const durationMs = performance.now() - t0;
    updateManifest(projectDir, (m) => {
      m.steps[def.id] = { ...m.steps[def.id], key, status: 'done', finishedAt: new Date().toISOString(), durationMs: Math.round(durationMs), outputs: def.outputs };
    });
    ctx.steps.push({ id: def.id, status: 'done', durationMs, key });
    return { value, cached: false };
  } catch (e) {
    const err = asNmsvsError(e);
    updateManifest(projectDir, (m) => {
      m.steps[def.id] = { ...m.steps[def.id], key, status: 'failed', finishedAt: new Date().toISOString(), error: { code: err.code, message: err.message } };
    });
    ctx.steps.push({ id: def.id, status: 'failed', durationMs: performance.now() - t0, key });
    throw err;
  }
}

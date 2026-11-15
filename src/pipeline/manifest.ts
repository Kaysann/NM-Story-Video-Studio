import fs from 'node:fs';
import path from 'node:path';
import { readJsonIfExists, writeJsonAtomic } from '../core/fsx';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface StepState {
  key: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: { code: string; message: string };
  outputs?: string[];
}

export interface Manifest {
  version: 1;
  lastCommand?: { argv: string[]; at: string; status: 'running' | 'done' | 'failed' | 'interrupted' };
  steps: Record<string, StepState>;
  /** Derniers plans de segments par format (clés), pour la purge du cache. */
  segmentPlans: Record<string, string[][]>;
  exports: { file: string; profile: string; key: string; at: string; qc?: string }[];
}

export function manifestPath(projectDir: string) {
  return path.join(projectDir, 'build', 'manifest.json');
}

export function loadManifest(projectDir: string): Manifest {
  return readJsonIfExists<Manifest>(manifestPath(projectDir)) ?? { version: 1, steps: {}, segmentPlans: {}, exports: [] };
}

export function saveManifest(projectDir: string, m: Manifest) {
  writeJsonAtomic(manifestPath(projectDir), m);
}

/** Mise à jour atomique lecture-modification-écriture (un seul processus nmsvs par projet). */
export function updateManifest(projectDir: string, fn: (m: Manifest) => void): Manifest {
  const m = loadManifest(projectDir);
  fn(m);
  saveManifest(projectDir, m);
  return m;
}

export function recordSegmentPlan(projectDir: string, format: string, keys: string[], keep = 3) {
  updateManifest(projectDir, (m) => {
    const plans = (m.segmentPlans[format] ??= []);
    if (JSON.stringify(plans[plans.length - 1]) !== JSON.stringify(keys)) plans.push(keys);
    while (plans.length > keep) plans.shift();
  });
}

/** Purge : supprime les segments qui n'appartiennent à aucun des derniers plans conservés. */
export function gcSegments(projectDir: string): { removed: string[]; bytes: number } {
  const m = loadManifest(projectDir);
  const removed: string[] = [];
  let bytes = 0;
  const buildDir = path.join(projectDir, 'build');
  if (!fs.existsSync(buildDir)) return { removed, bytes };
  for (const fmt of fs.readdirSync(buildDir)) {
    const segDir = path.join(buildDir, fmt, 'segments');
    if (!fs.existsSync(segDir)) continue;
    const keep = new Set((m.segmentPlans[fmt] ?? []).flat());
    for (const f of fs.readdirSync(segDir)) {
      const key = f.split('.')[0];
      if (!keep.has(key)) {
        const p = path.join(segDir, f);
        bytes += fs.statSync(p).size;
        fs.rmSync(p);
        removed.push(p);
      }
    }
  }
  return { removed, bytes };
}

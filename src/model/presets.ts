import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../core/paths';
import { NmsvsError } from '../core/errors';
import { assertValid } from './schemas';
import type { Ref } from './types';

export type PresetFamily = 'motion' | 'transition' | 'lyrics' | 'title' | 'safe' | 'export' | 'reels-weights';

const cache = new Map<string, any>();

export function presetPath(family: PresetFamily, id: string) {
  return path.join(PATHS.presets, family, `${id}.json`);
}

export function listPresets(family: PresetFamily): string[] {
  const dir = path.join(PATHS.presets, family);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort() : [];
}

export function loadPreset<T = any>(family: PresetFamily, id: string, depth = 0): T {
  const key = `${family}/${id}`;
  if (cache.has(key)) return structuredClone(cache.get(key));
  const file = presetPath(family, id);
  if (!fs.existsSync(file)) {
    throw new NmsvsError('E_SCHEMA', `Preset introuvable : ${family}/${id}`, `Presets disponibles : ${listPresets(family).join(', ')}`);
  }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertValid('preset', doc, file);
  let value = doc.value;
  if (value.extends) {
    if (depth > 5) throw new NmsvsError('E_SCHEMA', `Chaîne d'héritage trop profonde pour ${key}`);
    value = deepMerge(loadPreset(family, value.extends.slice('preset:'.length), depth + 1), value);
    delete value.extends;
  }
  cache.set(key, value);
  return structuredClone(value);
}

/** Résout une référence « preset:<id> » ou un objet en ligne (lui-même éventuellement `extends`). */
export function resolveRef<T>(family: PresetFamily, ref: Ref<T> | undefined): T | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref === 'string') {
    if (!ref.startsWith('preset:')) throw new NmsvsError('E_SCHEMA', `Référence invalide « ${ref} » (attendu preset:<id>)`);
    return loadPreset<T>(family, ref.slice('preset:'.length));
  }
  const obj: any = structuredClone(ref);
  if (obj.extends) {
    const parent = loadPreset(family, String(obj.extends).slice('preset:'.length));
    delete obj.extends;
    return deepMerge(parent, obj);
  }
  return obj;
}

export function deepMerge<A>(base: A, over: any): A {
  if (over === undefined) return base;
  if (base && typeof base === 'object' && !Array.isArray(base) && over && typeof over === 'object' && !Array.isArray(over)) {
    const out: any = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = deepMerge((base as any)[k], v);
    return out;
  }
  return over as A;
}

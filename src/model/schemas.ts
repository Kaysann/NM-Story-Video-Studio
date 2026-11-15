import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { PATHS } from '../core/paths';
import { NmsvsError } from '../core/errors';

export type SchemaName =
  | 'project' | 'assets' | 'lyrics' | 'timeline' | 'sync-overrides' | 'reels' | 'decision'
  | 'preset' | 'export-profile' | 'audio-analysis' | 'sync-auto' | 'timeline-resolved' | 'credits';

const ID = (name: string) => `https://nmsvs.local/schemas/${name}/v1.json`;

let ajv: Ajv2020 | null = null;
const compiled = new Map<string, ValidateFunction>();

function getAjv(): Ajv2020 {
  if (ajv) return ajv;
  ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const f of fs.readdirSync(PATHS.schemas).filter((f) => f.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(fs.readFileSync(path.join(PATHS.schemas, f), 'utf8')));
  }
  return ajv;
}

function validator(name: SchemaName | string): ValidateFunction {
  let v = compiled.get(name);
  if (!v) {
    const ref = name.includes('#') ? `${ID(name.split('#')[0])}#${name.split('#')[1]}` : ID(name);
    v = getAjv().getSchema(ref);
    if (!v) throw new NmsvsError('E_INTERNAL', `Schéma inconnu : ${name}`);
    compiled.set(name, v);
  }
  return v;
}

export interface ValidationIssue { path: string; message: string }

/** Messages lisibles : on retire le bruit des branches oneOf non retenues. */
function format(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  if (!errors) return [];
  const out: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const e of errors) {
    if (e.keyword === 'oneOf' || e.keyword === 'if') continue;
    let msg: string;
    switch (e.keyword) {
      case 'required': msg = `propriété obligatoire manquante « ${(e.params as any).missingProperty} »`; break;
      case 'additionalProperties': msg = `propriété inconnue « ${(e.params as any).additionalProperty} » (faute de frappe ?)`; break;
      case 'enum': msg = `valeur non autorisée ; attendu : ${(e.params as any).allowedValues.join(', ')}`; break;
      case 'pattern': msg = `format invalide (motif ${(e.params as any).pattern})`; break;
      case 'const': msg = `doit valoir ${JSON.stringify((e.params as any).allowedValue)}`; break;
      case 'type': msg = `type attendu : ${(e.params as any).type}`; break;
      case 'minimum': case 'maximum': case 'exclusiveMinimum': case 'exclusiveMaximum':
        msg = `valeur hors limites (${e.keyword} ${(e.params as any).limit})`; break;
      default: msg = e.message ?? e.keyword;
    }
    const key = `${e.instancePath}|${msg}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ path: e.instancePath || '/', message: msg });
    }
  }
  return out;
}

export function validate(name: SchemaName | string, data: unknown): ValidationIssue[] {
  const v = validator(name);
  return v(data) ? [] : format(v.errors);
}

export function assertValid(name: SchemaName | string, data: unknown, file: string) {
  const issues = validate(name, data);
  if (issues.length) {
    const lines = issues.slice(0, 12).map((i) => `  ${i.path} : ${i.message}`).join('\n');
    throw new NmsvsError('E_SCHEMA', `${file} ne respecte pas le schéma « ${name} » :\n${lines}`, 'Corriger le fichier puis relancer `nmsvs validate`.', issues);
  }
}

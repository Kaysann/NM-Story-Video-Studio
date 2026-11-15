import fs from 'node:fs';
import path from 'node:path';
import { NmsvsError } from '../core/errors';
import { pngSize } from '../core/png';
import { validate } from './schemas';
import type { AssetsFile, CreditsMediaRef, CreditsRef, CreditsSequence, CreditsTemplate, Scene, SpriteSpec, TimeAnchor, TimelineFile } from './types';

/**
 * Générique réutilisable : un modèle (*.credits.json, hors projet) décrit les séquences de fin ; chaque projet l'appelle
 * depuis timeline.json (`credits`) avec son instant de départ et ses racines de médias. Les séquences deviennent des
 * scènes ordinaires ajoutées après la dernière scène (mêmes moteurs de rendu, sprites, transitions, QC) et les médias
 * des assets virtuels lus en place : rien n'est copié, déplacé ni réécrit dans les fichiers du projet.
 */

export interface CreditsIO {
  exists(file: string): boolean;
  readJson(file: string): unknown;
  size(file: string): { w?: number; h?: number };
}

export const nodeCreditsIO: CreditsIO = {
  exists: (f) => fs.existsSync(f) && fs.statSync(f).isFile(),
  readJson: (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')),
  size: (f) => pngSize(f),
};

/** Préfixe des identifiants d'assets virtuels créés pour les médias du générique. */
export const CREDITS_ASSET_PREFIX = 'cr-';

const list = (r?: string | string[]) => (r === undefined ? [] : Array.isArray(r) ? r : [r]);
const abs = (base: string, p: string) => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(base, p));

export function creditsTemplateFile(projectDir: string, ref: CreditsRef): string {
  return abs(projectDir, ref.template);
}

export function loadCreditsTemplate(projectDir: string, ref: CreditsRef, io: CreditsIO = nodeCreditsIO): { template: CreditsTemplate; file: string } {
  const file = creditsTemplateFile(projectDir, ref);
  if (!io.exists(file)) throw new NmsvsError('E_ASSET_MISSING', `Modèle de générique introuvable : ${file}`, 'Corriger `credits.template` dans timeline.json (chemin absolu ou relatif au projet).');
  const template = io.readJson(file) as CreditsTemplate;
  const issues = validate('credits', template);
  if (issues.length) throw new NmsvsError('E_SCHEMA', `Modèle de générique invalide (${file}) :\n${issues.slice(0, 8).map((i) => `  ${i.path} : ${i.message}`).join('\n')}`, 'Corriger le fichier modèle.');
  const seqIds = template.sequences.map((s) => s.id);
  if (new Set(seqIds).size !== seqIds.length) throw new NmsvsError('E_SCHEMA', `Modèle de générique ${file} : séquences en double.`);
  template.sequences.slice(0, -1).forEach((s) => {
    if (s.durationSec === undefined) throw new NmsvsError('E_SCHEMA', `Modèle de générique ${file} : la séquence « ${s.id} » doit avoir une durée (seule la dernière va jusqu'à la fin).`);
  });
  return { template, file };
}

export type ResolvedMedia = { kind: 'file'; file: string } | { kind: 'asset'; id: string };

/**
 * Résolution d'un emplacement média : valeur du projet (`credits.media`) puis du modèle ; chemin absolu tel quel,
 * sinon recherché dans les racines du projet, puis du modèle, puis le dossier du modèle — d'abord au chemin relatif
 * indiqué, puis par son seul nom de fichier (médias rangés à plat, ex. copies importées dans media/).
 */
export function resolveCreditsMedia(projectDir: string, ref: CreditsRef, template: CreditsTemplate, templateFile: string, slot: string, io: CreditsIO = nodeCreditsIO): ResolvedMedia {
  const value: CreditsMediaRef | undefined = ref.media?.[slot] ?? template.media[slot];
  if (value === undefined) throw new NmsvsError('E_ASSET_MISSING', `Générique « ${template.id} » : emplacement média « ${slot} » non défini.`, 'Le déclarer dans `media` du modèle ou de `credits` (timeline.json).');
  if (typeof value !== 'string') return { kind: 'asset', id: value.asset };
  if (path.isAbsolute(value)) {
    if (!io.exists(value)) throw new NmsvsError('E_ASSET_MISSING', `Générique « ${template.id} » : fichier introuvable pour « ${slot} » : ${value}`);
    return { kind: 'file', file: path.normalize(value) };
  }
  const tplDir = path.dirname(templateFile);
  const roots = [...list(ref.mediaRoot).map((r) => abs(projectDir, r)), ...list(template.mediaRoot).map((r) => abs(tplDir, r)), tplDir];
  const tried: string[] = [];
  for (const root of roots) {
    for (const cand of [path.resolve(root, value), path.resolve(root, path.basename(value))]) {
      if (tried.includes(cand)) continue;
      tried.push(cand);
      if (io.exists(cand)) return { kind: 'file', file: cand };
    }
  }
  throw new NmsvsError('E_ASSET_MISSING', `Générique « ${template.id} » : « ${value} » (emplacement ${slot}) introuvable dans ${roots.join(' ; ')}`,
    'Renseigner `credits.mediaRoot` (dossier des médias) ou `credits.media` dans timeline.json.');
}

function addSec(a: TimeAnchor, sec: number): TimeAnchor {
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  if ('at' in a && a.offsetSec === undefined && a.snap === undefined) return { at: r(a.at + sec) };
  return { ...a, offsetSec: r((a.offsetSec ?? 0) + sec) };
}

function patchSequence(s: CreditsSequence, p: NonNullable<CreditsRef['overrides']>[string] | undefined): CreditsSequence {
  if (!p) return s;
  const { sprites: sp, ...rest } = p;
  const sprites = s.sprites?.map((x) => ({ ...x, ...(sp?.find((o) => o.id === x.id) ?? {}) }) as SpriteSpec);
  return { ...s, ...rest, ...(sprites ? { sprites } : {}) };
}

export interface ExpandedCredits { scenes: Scene[]; images: AssetsFile['images']; textures: NonNullable<AssetsFile['textures']>; templateFile: string }

/** Scènes et assets virtuels d'un appel de générique (fonction pure hormis les accès `io`). */
export function expandCredits(projectDir: string, ref: CreditsRef, assets: AssetsFile, io: CreditsIO = nodeCreditsIO): ExpandedCredits {
  const { template, file } = loadCreditsTemplate(projectDir, ref, io);
  const images: AssetsFile['images'] = [];
  const textures: NonNullable<AssetsFile['textures']> = [];
  const media = (slot: string, kind: 'image' | 'texture'): string => {
    const m = resolveCreditsMedia(projectDir, ref, template, file, slot, io);
    if (m.kind === 'asset') {
      const known = kind === 'image' ? assets.images.some((i) => i.id === m.id) : (assets.textures ?? []).some((t) => t.id === m.id);
      if (!known) throw new NmsvsError('E_ASSET_MISSING', `Générique « ${template.id} » : asset « ${m.id} » (emplacement ${slot}) absent de assets.json.`);
      return m.id;
    }
    const id = `${CREDITS_ASSET_PREFIX}${slot}`;
    if (kind === 'image') {
      if (!images.some((i) => i.id === id)) {
        const { w, h } = io.size(m.file);
        if (!w || !h) throw new NmsvsError('E_ASSET_MISSING', `Générique « ${template.id} » : dimensions illisibles pour ${m.file} (PNG attendu).`);
        images.push({ id, path: m.file, size: { w, h } });
      }
    } else if (!textures.some((t) => t.id === id)) textures.push({ id, path: m.file });
    return id;
  };

  const scenes: Scene[] = [];
  let from = ref.from;
  template.sequences.forEach((raw, i) => {
    const s = patchSequence(raw, ref.overrides?.[raw.id]);
    const last = i === template.sequences.length - 1;
    const to: TimeAnchor = s.durationSec !== undefined ? addSec(from, s.durationSec) : { end: true };
    if (!last && s.durationSec === undefined) throw new NmsvsError('E_SCHEMA', `Générique « ${template.id} » : durée manquante pour « ${s.id} ».`);
    const scene: Scene = {
      id: `sc-${s.id}`,
      span: { from, to },
      illustrations: [{ asset: media(s.background, 'image'), motion: s.motion ?? { type: 'still', from: { scale: 1 }, to: { scale: 1 } } }],
      lyrics: { style: 'none' },
      note: `Générique « ${template.id} » — ${s.note ?? s.id}`,
    };
    if (s.transitionIn) scene.transitionIn = s.transitionIn;
    if (s.transitionOut) scene.transitionOut = s.transitionOut;
    if (s.sprites?.length) scene.sprites = s.sprites.map((sp) => ({ ...sp, frames: sp.frames.map((f) => media(f, 'texture')) }));
    scenes.push(scene);
    from = to;
  });
  return { scenes, images, textures, templateFile: file };
}

/**
 * Timeline et assets complétés par le générique appelé (copies : les objets lus depuis les fichiers ne sont pas modifiés).
 * Sans `credits`, renvoie les objets d'origine.
 */
export function withCredits(projectDir: string, timeline: TimelineFile | undefined, assets: AssetsFile, io: CreditsIO = nodeCreditsIO): { timeline?: TimelineFile; assets: AssetsFile } {
  if (!timeline?.credits) return { timeline, assets };
  const x = expandCredits(projectDir, timeline.credits, assets, io);
  const clash = x.scenes.find((s) => timeline.scenes.some((t) => t.id === s.id));
  if (clash) throw new NmsvsError('E_SCHEMA', `Générique : la scène « ${clash.id} » existe déjà dans timeline.json.`, 'Retirer les scènes de générique écrites à la main (le générique commun les fournit).');
  return {
    timeline: { ...timeline, scenes: [...timeline.scenes, ...x.scenes] },
    assets: { ...assets, images: [...assets.images, ...x.images], textures: [...(assets.textures ?? []), ...x.textures] },
  };
}

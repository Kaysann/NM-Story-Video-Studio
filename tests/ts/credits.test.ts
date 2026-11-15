import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandCredits, withCredits, type CreditsIO } from '../../src/model/credits';
import { validate } from '../../src/model/schemas';
import { compileTimeline } from '../../src/modules/timeline/compile';
import type { CreditsRef, CreditsTemplate } from '../../src/model/types';
import { analysis, bundle, fakeImages, syncFor } from './helpers';

// Arborescence factice : modèle dans une bibliothèque, médias rangés à plat dans le projet (copies importées)
// ou en sous-dossiers ailleurs (dossier de sources d'un autre projet).
const ROOT = path.resolve('/nmsvs-fictif');
const PROJ = path.join(ROOT, 'projets', 'example-project-b');
const LIB = path.join(ROOT, 'bibliotheque', 'credits');
const SRC = path.join(ROOT, 'sources', 'example-project-a');
const poses = (p: string) => Array.from({ length: 8 }, (_, i) => `${p}-0${i + 1}`);

const TEMPLATE: CreditsTemplate = {
  schemaVersion: 1, id: 'generique-test',
  media: {
    'fond-a': 'fond A.png', 'fond-b': 'fond B.png',
    ...Object.fromEntries([...poses('perso-a'), ...poses('perso-b')].map((id) => [id, `${id.slice(0, 6)}/${id}.png`])),
  },
  sequences: [
    {
      id: 'remerciements', background: 'fond-a', durationSec: 8.5,
      transitionIn: { type: 'page-turn', duration: { sec: 1.5 }, direction: 'left' },
      sprites: [
        { id: 'perso-a', frames: poses('perso-a'), poseFps: 8, height: 0.22, path: { from: { x: 0.9, y: 0.866 }, to: { x: 0.16, y: 0.866 } }, startSec: 1, durationSec: 6.3, fadeSec: 0.5 },
        { id: 'perso-b', frames: poses('perso-b'), poseFps: 8, height: 0.22, path: { from: { x: 0.16, y: 0.896 }, to: { x: 0.9, y: 0.896 } }, startSec: 1, durationSec: 6.3, fadeSec: 0.5 },
      ],
    },
    { id: 'merci', background: 'fond-b', transitionIn: { type: 'page-turn', duration: { sec: 1.5 } }, transitionOut: { type: 'fade-black', duration: { sec: 2.5 } } },
  ],
};

function fakeIO(files: string[], template: unknown = TEMPLATE): CreditsIO {
  const set = new Set(files.map((f) => path.normalize(f)));
  set.add(path.join(LIB, 'generique.credits.json'));
  return {
    exists: (f) => set.has(path.normalize(f)),
    readJson: () => structuredClone(template),
    size: () => ({ w: 3840, h: 2160 }),
  };
}
const flat = (dir: string) => ['fond A.png', 'fond B.png', ...[...poses('perso-a'), ...poses('perso-b')].map((id) => `${id}.png`)].map((f) => path.join(dir, f));
const nested = (dir: string) => ['fond A.png', 'fond B.png', ...[...poses('perso-a'), ...poses('perso-b')].map((id) => path.join(id.slice(0, 6), `${id}.png`))].map((f) => path.join(dir, f));
const REF: CreditsRef = { template: '../../bibliotheque/credits/generique.credits.json', from: { at: 123.3 }, mediaRoot: 'media' };
const ASSETS = { schemaVersion: 1 as const, images: [{ id: 'img-a', path: 'media/images/img-a.png' }] };

describe('générique réutilisable', () => {
  it('modèle et appel conformes aux schémas', () => {
    expect(validate('credits', TEMPLATE)).toEqual([]);
    const tl = { ...structuredClone(bundle().timeline!), credits: REF };
    expect(validate('timeline', tl)).toEqual([]);
  });

  it('séquences enchaînées en scènes, assets virtuels lus en place (copies à plat : recherche par nom)', () => {
    const x = expandCredits(PROJ, REF, ASSETS, fakeIO(flat(path.join(PROJ, 'media'))));
    expect(x.scenes.map((s) => s.id)).toEqual(['sc-remerciements', 'sc-merci']);
    expect(x.scenes[0].span).toEqual({ from: { at: 123.3 }, to: { at: 131.8 } });
    expect(x.scenes[1].span).toEqual({ from: { at: 131.8 }, to: { end: true } });
    expect(x.scenes[0].illustrations[0].asset).toBe('cr-fond-a');
    expect(x.scenes[0].lyrics).toEqual({ style: 'none' });
    expect(x.scenes[0].sprites![0].frames[0]).toBe('cr-perso-a-01');
    expect(x.scenes[0].sprites![0].path).toEqual(TEMPLATE.sequences[0].sprites![0].path);
    expect(x.scenes[1].transitionOut).toEqual({ type: 'fade-black', duration: { sec: 2.5 } });
    expect(x.images[0]).toEqual({ id: 'cr-fond-a', path: path.join(PROJ, 'media', 'fond A.png'), size: { w: 3840, h: 2160 } });
    expect(x.textures).toHaveLength(16);
  });

  it('médias dans un autre dossier (chemin absolu, sous-dossiers conservés), sans copie', () => {
    const x = expandCredits(PROJ, { ...REF, mediaRoot: SRC }, ASSETS, fakeIO(nested(SRC)));
    expect(x.textures[0].path).toBe(path.join(SRC, 'perso-', 'perso-a-01.png'));
  });

  it('priorités : média du projet > modèle ; asset du projet ; racine du modèle par défaut', () => {
    const tpl = { ...TEMPLATE, mediaRoot: '../../sources/example-project-a' };
    const ref: CreditsRef = { ...REF, mediaRoot: undefined, media: { 'fond-b': { asset: 'img-a' }, 'fond-a': path.join(ROOT, 'autre', 'fond.png') } };
    const x = expandCredits(PROJ, ref, ASSETS, fakeIO([...nested(SRC), path.join(ROOT, 'autre', 'fond.png')], tpl));
    expect(x.scenes[1].illustrations[0].asset).toBe('img-a');
    expect(x.images.map((i) => i.path)).toEqual([path.join(ROOT, 'autre', 'fond.png')]);
    expect(x.textures[0].path).toBe(path.join(SRC, 'perso-', 'perso-a-01.png'));
  });

  it('surcharges du projet : durée, trajet d\'un personnage', () => {
    const ref: CreditsRef = { ...REF, overrides: { remerciements: { durationSec: 9, sprites: [{ id: 'perso-b', startSec: 1.5 }] } } };
    const x = expandCredits(PROJ, ref, ASSETS, fakeIO(flat(path.join(PROJ, 'media'))));
    expect(x.scenes[0].span.to).toEqual({ at: 132.3 });
    expect(x.scenes[0].sprites![1].startSec).toBe(1.5);
    expect(x.scenes[0].sprites![1].height).toBe(0.22);
  });

  it('erreurs explicites : média introuvable, modèle absent, scène déjà présente', () => {
    expect(() => expandCredits(PROJ, REF, ASSETS, fakeIO([]))).toThrow(/introuvable/);
    expect(() => expandCredits(PROJ, { ...REF, template: 'absent.json' }, ASSETS, fakeIO([]))).toThrow(/Modèle de générique introuvable/);
    const tl = { schemaVersion: 1 as const, credits: REF, scenes: [{ id: 'sc-merci', span: { from: { at: 0 }, to: { at: 123.3 } }, illustrations: [{ asset: 'img-a' }] }] };
    expect(() => withCredits(PROJ, tl, ASSETS, fakeIO(flat(path.join(PROJ, 'media'))))).toThrow(/existe déjà/);
  });

  it('les objets lus ne sont pas modifiés ; sans appel, rien ne change', () => {
    const tl = { schemaVersion: 1 as const, credits: REF, scenes: [{ id: 'sc-p9', span: { from: { at: 0 }, to: { at: 123.3 } }, illustrations: [{ asset: 'img-a' }] }] };
    const before = JSON.stringify([tl, ASSETS]);
    const r = withCredits(PROJ, tl, ASSETS, fakeIO(flat(path.join(PROJ, 'media'))));
    expect(r.timeline!.scenes).toHaveLength(3);
    expect(JSON.stringify([tl, ASSETS])).toBe(before);
    const plain = { schemaVersion: 1 as const, scenes: tl.scenes };
    expect(withCredits(PROJ, plain, ASSETS).timeline).toBe(plain);
  });

  it('compilé comme des scènes ordinaires : fonds, personnages animés, fondu final', () => {
    const b = bundle();
    const last = b.timeline!.scenes[b.timeline!.scenes.length - 1];
    last.span.to = { end: true, offsetSec: -12 };
    delete last.transitionOut;
    b.timeline!.credits = { ...REF, from: { end: true, offsetSec: -12 } };
    const r = withCredits(PROJ, b.timeline, b.assets, fakeIO(flat(path.join(PROJ, 'media'))));
    b.timeline = r.timeline;
    b.assets = r.assets;
    const stage = (_k: 'font' | 'texture', id: string) => ({ rel: `tex/${id}.png`, sha: id });
    const t = compileTimeline(b, '16x9', syncFor(), analysis(), fakeImages(3840, 2160), stage).timeline;
    expect(validate('timeline-resolved', t)).toEqual([]);
    expect(t.shots.filter((s) => s.sceneId === 'sc-remerciements')).toHaveLength(1);
    expect(t.sprites!.map((s) => s.id)).toEqual(['sc-remerciements-perso-a', 'sc-remerciements-perso-b']);
    expect(t.sprites![0].frames[0]).toBe('tex/cr-perso-a-01.png');
    expect(Math.max(...t.fades.map((f) => f.to))).toBe(t.durationInFrames);
    expect(t.lyrics.some((l) => l.sceneId.startsWith('sc-merci') || l.sceneId === 'sc-remerciements')).toBe(false);
  });
});

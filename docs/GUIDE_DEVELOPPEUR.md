# Guide développeur NMSVS

## 1. Installation (poste Windows)

Pré-requis vérifiés : Node.js ≥ 20 (24 utilisé), FFmpeg ≥ 9 dans le PATH (build *full* avec AMF, libvmaf), Python **3.12** (`py -3.12`).

```powershell
npm ci                                                     # dépendances Node épinglées (package-lock.json)
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.8.0+cpu torchaudio==2.8.0+cpu torchvision==0.23.0+cpu
.\.venv\Scripts\python.exe -m pip install -r python\requirements.lock
.\nmsvs.cmd doctor
```

- npm 11 bloque le script d'installation d'esbuild (politique *allow-scripts*) : sans conséquence (binaire fourni par `@esbuild/win32-x64`).
- Chrome Headless Shell est téléchargé par Remotion au premier rendu (`.nmsvs`/cache Remotion).
- Modèles IA téléchargés au premier `nmsvs sync` dans `.nmsvs/models` (`HF_HOME`, `TORCH_HOME` redirigés).
- Variables : `NMSVS_PROJECTS` (dossier des projets), `NMSVS_HOME` (cache), `NMSVS_FFMPEG`, `NMSVS_FFPROBE`, `NMSVS_PYTHON`, `NMSVS_PROJECT`.

## 2. Organisation du code

```
bin/nmsvs.mjs          lanceur (tsx) ; nmsvs.cmd pour PowerShell
src/cli/main.ts        commandes (commander), sortie --json, codes de sortie, reprise
src/core/              erreurs typées, hash/JSON canonique, écriture atomique, journal JSONL, exec, outils
src/model/             types, schémas (Ajv 2020), presets (extends), chargement/validation de projet
src/pipeline/          étapes à cache (runStep), manifeste (build/manifest.json), purge
src/modules/
  project/             init, import (copie sans modification des sources), journal des décisions, nettoyage sûr (clean)
  lyrics/              analyse du texte structuré
  analysis/            pont vers l'analyse librosa, sonie EBU R128
  python/              contrat JSON fichier avec le worker Python
  sync/                alignement, fusion des corrections, sous-titres, rapport, évaluation vs repères
  assets/              recadrage, harmonisation, dérivés d'images (FFmpeg), staging polices/textures
  timeline/            ancres, mise en page, compilateur, composition automatique
  render/              segments + clés, bundle, serveur d'assets local, rendu, stills, préviz
  export/              profils, encodage final (aucun écrasement sans --replace, aucune archive automatique), garde-fou YouTube 4K
  qc/                  contrôles qualité
  reels/               candidats, critères, MMR, fiches de proposition, fermeture des Shorts, production
  report/, doctor/
src/remotion/          compositions (navigateur) : Main, Shot, Lyrics, Parchment, Title, Effects, SafeOverlay, anim.ts (pur)
python/nmsvs_audio/    worker : analyze, align (+textnorm), image_stats, env_check
schemas/               JSON Schema 2020-12 (source de vérité)
presets/               motion, transition, lyrics, title, safe, export, reels-weights, render.json (réglages mesurés)
tests/ts/              unitaires (Vitest) ; tests/ts/integration : bout en bout + golden ; tests/golden : références
python/tests/          unitaires (pytest)
scripts/bench/         benchmarks et projet de mesure de l'alignement
```

## 3. Principes à respecter

- **Fichiers humains / machine** : seuls `init`, `import`, `compose`, `sync fix…`, `reels select`, `decide` écrivent des fichiers humains, avec sauvegarde `.bak` et entrée dans `decisions.jsonl`.
- **Clés de cache** : toute nouvelle entrée influençant un résultat doit entrer dans la clé de l'étape (`runStep.inputs`) ou du segment (`segmentKey`). Tester l'invalidation (`tests/ts/cache-invalidation.test.ts`).
- **Composants Remotion purs et déterministes** : aucune lecture disque, aucun aléatoire non graine, aucune date ; tout calcul musical se fait dans le compilateur (timeline résolue en images/pixels).
- **Écriture atomique** (`writeFileAtomic`) pour tout fichier produit ; erreurs `NmsvsError(code, message, action)`.
- **Licences** : tout nouveau modèle doit avoir une licence de **poids** établie compatible avec un usage monétisé (décision interne de cadrage C-01).

## 4. Tests

| Commande | Contenu | Durée indicative |
|---|---|---|
| `npm run typecheck` | TypeScript strict | ~10 s |
| `npm test` | 99 tests unitaires TS (schémas, sync, timeline, cache, recadrage, couleur, animations, Reels, pipeline, QC sur vidéos défectueuses) | ~5 s |
| `npm run test:py` | 10 tests Python (normalisation, appariement, fenêtres, extension des voyelles, recalage des attaques, contrat, analyse) | ~10 s |
| `npm run test:integration` | 17 tests : bout en bout réel (CLI, Remotion, FFmpeg, export YouTube 4K direct 3840×2160, refus d’écrasement, interruption/reprise, Reels) + 39 images de référence (dont page tournée, paroles en défilement 9:16) + déterminisme | ~3 min |
| `npm run test:all` | tout | |

Images de référence : supprimer `tests/golden/<nom>.png` pour la régénérer (à valider visuellement), après une modification
volontaire d'un composant.

## 5. Étendre

- **Nouveau preset** : fichier `presets/<famille>/<id>.json` (`{ family, id, description, value }`), validé par `schemas/preset.schema.json`.
- **Nouvelle transition** : type dans `schemas/common.schema.json#/$defs/transition`, `RTransitionType`, `transitionStyle()` (`src/remotion/anim.ts`), et classement chevauchement/couleur dans `compile.ts` ; ajouter une image de référence.
  Exemple complet : `page-turn` (géométrie pure `pageTurnAt()`, champ `TStyle.page`, ombrage `PageShading` dans `Shot.tsx`, ordre d'empilement `layerOrder()` utilisé par `Main.tsx` pour garder la page sortante au-dessus).
- **Nouveau style de paroles** : type dans le schéma, `RLyricsStyle`, rendu dans `components/Lyrics.tsx`, règles de groupe/mise en page dans `compileLyrics`.
- **Nouveau profil d'export** : preset `export` (encodeur parmi ceux pris en charge par `videoArgs`).
- **Autre moteur d'alignement** : nouvelle branche dans `python/nmsvs_audio/align.py` (`_fine_*`), valeur d'`engine` dans le schéma.

## 6. Contrat TS ↔ Python

`python -m nmsvs_audio <commande> --request req.json --response res.json` ; progression en JSONL sur stderr ;
codes 0/2/3/4/130 ; schéma `schemas/py-contract.schema.json`. Le TS appelle toujours `.venv\Scripts\python.exe`.

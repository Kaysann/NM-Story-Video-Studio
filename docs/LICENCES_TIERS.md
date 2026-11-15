# Licences des composants tiers

NMSVS est publié sous **Apache License 2.0** (voir `LICENSE` et `NOTICE`). Cette licence couvre **uniquement** le code et les fichiers originaux de ce dépôt.

**Aucun composant tiers n'est redistribué** : les dépendances sont installées par l'utilisateur (`npm ci`, `pip install`), et les modèles IA sont téléchargés au premier usage. Chaque utilisateur doit respecter les licences ci-dessous. Elles ont été relevées le 14/11/2026 sur les versions épinglées, à titre indicatif : seules les licences des projets eux-mêmes font foi.

## Node.js (`package.json`, `package-lock.json`)

| Paquet | Version | Licence |
|---|---|---|
| `remotion`, `@remotion/bundler`, `@remotion/cli`, `@remotion/renderer` | 4.0.543 | **Remotion License** : gratuite pour les particuliers et les petites équipes ; **licence d'entreprise requise** au-delà. Voir [remotion.dev/license](https://www.remotion.dev/license). |
| `@remotion/layout-utils` | 4.0.543 | MIT |
| `react`, `react-dom` | 19.3.1 | MIT |
| `ajv` | 8.20.0 | MIT |
| `commander` | 14.0.3 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `tsx`, `vitest`, `@types/node`, `@types/react` | — | MIT |

Remotion télécharge en outre **Chrome Headless Shell** au premier rendu, sous la licence de Chromium et de Google.

## Python (`python/requirements.lock`, 125 paquets)

| Paquet principal | Licence |
|---|---|
| `whisperx` | BSD-2-Clause |
| `faster-whisper`, `ctranslate2`, `stable-ts` | MIT |
| `torch`, `torchaudio`, `torchvision` | BSD-3-Clause |
| `librosa` | ISC |
| `transformers` | Apache-2.0 |
| `numpy`, `soundfile` | BSD |
| `pyannote.*` | MIT (métadonnées de paquet vides, licence du projet amont) |
| `soxr` | LGPL-2.1-or-later : bibliothèque importée, non redistribuée |

## Outils externes

| Outil | Licence |
|---|---|
| **FFmpeg / FFprobe** | LGPL-2.1+ ou GPL selon la compilation installée par l'utilisateur, appelé comme processus externe |

## Modèles IA (non inclus)

| Modèle | Usage | Licence |
|---|---|---|
| faster-whisper `large-v3` (conversion de Whisper) | transcription témoin | MIT (Whisper) |
| `jonatasgrosman/wav2vec2-large-xlsr-53-french` | alignement forcé | Apache-2.0 (vérifier la fiche du modèle) |

Avant tout usage commercial, vérifier la licence des **poids** de chaque modèle employé.

## Créations artistiques

Les créations de NM Story (musiques, paroles, illustrations, couvertures, vidéos) ne sont **pas** incluses et ne sont **pas** placées sous Apache 2.0. Les tests utilisent uniquement des fixtures synthétiques générées par FFmpeg et des paroles inventées.

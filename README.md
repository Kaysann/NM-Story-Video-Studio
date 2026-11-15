# NM Story Video Studio (NMSVS)

> *Programmable, scriptable video editing and production engine (Remotion, FFmpeg, audio analysis and synchronization).*
> Documentation in French.

**NMSVS** est un **moteur local de montage et de production vidéo**, programmable, configurable et automatisable.

Un projet est décrit par des fichiers JSON validés par schéma :
- les médias (audio, images, textures) ;
- une timeline de scènes ancrée sur l'audio ;
- les styles de texte, les mouvements, les transitions et les calques ;
- les formats de sortie et les profils d'export.

Le moteur compile cette description en une timeline résolue (images, pixels), la rend avec Remotion, l'encode avec FFmpeg, puis contrôle automatiquement le fichier produit.

Applications exercées à ce jour :
- clips musicaux horizontaux en 4K ;
- extraits verticaux de type Shorts / Reels.

Ce sont des exemples d'usage : le montage — scènes, médias, timings, transitions, textes, calques — se définit par configuration, et non par un gabarit figé.

Le moteur se pilote en ligne de commande (sortie `--json` structurée), et peut l'être en langage naturel par un agent de code ([AGENTS.md](AGENTS.md)).

> **Contenu artistique non inclus.** Aucune création artistique (musique, paroles, illustrations, vidéos) ne fait partie de ce dépôt. Les tests utilisent exclusivement des données **synthétiques** : mires et sons générés par FFmpeg, voix de synthèse, paroles inventées.

## Statut

| | |
|---|---|
| Version | **1.1.0** |
| Utilisation réelle | **4 productions complètes validées** (2 vidéos horizontales 3840 × 2160, 2 vidéos verticales 1080 × 1920) : contrôles techniques et validation artistique explicite. Voir [Validations en conditions réelles](#validations-en-conditions-réelles) |
| Tests automatisés | 124 tests unitaires TypeScript, 17 tests d'intégration réels, 39 images de référence, 10 tests Python. Voir [Tests](#tests) |
| Qualification globale V1.0 | cahier de recette globale **non exécuté formellement**. Voir [Statut de qualification](#statut-de-qualification) |
| Plateforme | Windows 10/11 (seule plateforme testée) |
| Licence | **Apache License 2.0** pour le code de ce dépôt ; les dépendances gardent leurs propres licences (voir [Licence](#licence)) |

## Capacités

Les fonctionnalités sont classées selon trois niveaux de preuve :
- **Production** : exercée dans au moins une des quatre productions réelles validées ;
- **Tests** : développée et couverte par les tests automatisés, sans usage en production à ce jour ;
- **Non pris en charge** : absente du moteur.

### Montage et composition

| Fonctionnalité | Détail | Preuve |
|---|---|---|
| Timeline déclarative | `timeline.json` : suite de scènes contiguës. Leurs bornes s'expriment en secondes ou en **ancres musicales** : section, ligne, mot, battement, mesure, fin, avec décalage et aimantation au temps. Le compilateur vérifie la couverture complète (pas de trou). | Production |
| Scènes et médias | une ou plusieurs illustrations par scène, réparties automatiquement ou bornées explicitement (`until`) ; illustrations alternatives par format | Production |
| Mouvements de caméra | zoom, panoramique, fixe (production) ; dérive, parallaxe à calque de premier plan, pulsation sur les temps (tests). Courbes d'accélération configurables. | Production / Tests |
| Transitions | 9 types paramétrables (durée en secondes ou en temps, direction, couleur) : coupe, fondu enchaîné, fondu au noir, passage par une couleur, glissement, volet linéaire ou radial, zoom traversant, fondu flouté, page tournée en perspective. Seules la coupe et la page tournée ont été utilisées en production. | Production / Tests |
| Calques indépendants | image de fond ; conteneur de texte (bandeau texturé, cartouche ou texte seul) sur un calque distinct ; titres ; personnages animés (`sprites` : cycle de poses PNG transparentes sur une trajectoire) ; vignettage et grain ; fondus de couleur | Production (fond, bandeau, personnages animés) / Tests (autres) |
| Préambule | N secondes d'image avant l'audio, en silence numérique ajouté à l'assemblage. Le master audio n'est pas modifié et les ancres restent en temps audio. | Production |
| Séquences réutilisables | modèles de séquences (`*.credits.json`, schéma `credits`) appelés par plusieurs projets depuis `timeline.json → credits`. Leurs médias sont lus en place, sans copie. | Production (une séquence commune réutilisée à l'identique dans deux projets) |
| Composition automatique | `nmsvs compose` propose une `timeline.json` (durée cible des plans, changements calés sur les lignes ou les temps forts) | Tests |
| Couleur | harmonisation colorimétrique automatique, LUT `.cube` avec intensité | Tests |

### Synchronisation audio et texte

| Fonctionnalité | Détail | Preuve |
|---|---|---|
| Analyse audio | tempo, battements, mesures, sections, énergie, sonie EBU R128 (librosa, FFmpeg) | Production |
| Alignement forcé | aligne un texte **connu** sur la voix (WhisperX / wav2vec2 sur CPU ; moteurs `stable-ts` et `uniform` en option). Ce n'est pas une transcription libre. | Production (avec corrections, voir [Limites](#limites-connues)) |
| Corrections ciblées | `sync fix / shift / offset / unlock / apply`, au niveau de la ligne ou du mot, verrouillables ; réalignement partiel (`sync --lines`) ; rapport classé par confiance | Production |
| Couches par format | couche de corrections propre aux sorties verticales (`--shorts`), sans effet sur la vidéo principale | Production |
| Affichage du texte | styles résolus en cascade (ligne → scène → section → projet) ; modes statique, défilement et phrase (une phrase à la fois, révélation à chaque chant) ; 1 ou 2 lignes ; karaoké à la ligne ou au mot ; position automatique opposée au sujet | Production (mode phrase sur bandeau texturé) / Tests (autres) |
| Sous-titres | `.srt`, `.vtt`, `.lrc` produits à l'export | Production |

### Formats et exports

| Fonctionnalité | Détail | Preuve |
|---|---|---|
| Formats | formats déclarés librement (`<largeur>x<hauteur>`, jusqu'à 7680 px) ; zones sûres par format | Production (16:9 et 9:16) |
| Recadrage | point focal, rectangle de recadrage par format, image de remplacement par format, image entière sur fond flouté (`blurFill`) | Production |
| Profils d'export | `youtube-4k-master` (H.264 CRF 16, 3840 × 2160 imposé) ; `reel-1080-h264` (1080 × 1920) | Production |
| Autres profils | `youtube-4k-fast` (HEVC matériel AMD), `reel-2160-h264`, `archive-hevc10` (MKV + FLAC), brouillons `draft-16x9` / `draft-9x16` | Tests |
| Rendu | segmenté et incrémental : seuls les segments modifiés sont recalculés ; reprise après interruption (`nmsvs resume`) | Production |
| Gestion des versions | aucun export écrasé sans `--replace` ; nouvelle version par `--label` ; aucun filigrane ajouté | Production |

### Extraits verticaux (Shorts / Reels)

| Fonctionnalité | Détail | Preuve |
|---|---|---|
| Propositions | `reels analyze` évalue les extraits admissibles sur 8 critères (accroche, énergie, montée, voix, complétude, texte, aptitude à boucler, originalité), puis retient 5 candidats diversifiés, avec fiche et justification. Il ne fait **aucune prédiction d'audience**. | Production |
| Sélection humaine | **aucune production avant `reels select`**, qui consigne le choix de l'utilisateur (bornes ajustables) | Production |
| Montage dédié | timeline propre aux extraits (`params.timeline`), style de texte dédié, couche de synchronisation dédiée | Production |
| Fermeture | séquence ajoutée après l'extrait : texte masqué, transition vers une scène choisie, tenue ; audio arrêté ou poursuivi en fondu | Production |
| Campagne | tous les extraits sélectionnés produits en une commande (`reels build`) ; essai technique sans sélection (`--try`) | Production (un extrait par projet) / Tests (plusieurs) |

### Fiabilité et traçabilité

| Fonctionnalité | Détail | Preuve |
|---|---|---|
| Contrôle qualité | QC automatique de chaque export (16 contrôles QC-T / QC-E) : résolution, codec, balises BT.709, durées, audio, sonie, images noires ou figées, fidélité au rendu (SSIM), texte dans les zones sûres, temps de lecture, contraste, agrandissement, sujet coupé, intégrité des calques, couverture de la timeline | Production |
| Préservation des sources | `import` **copie** les médias dans le projet ; les originaux ne sont jamais modifiés, et aucune commande ne réécrit `media/` | Production |
| Validation | `nmsvs validate` : schémas JSON (Ajv 2020-12) et cohérence (références, ancres, modèles de séquences) | Production |
| Journal de décisions | `nmsvs decide` et décisions automatiques horodatées dans `decisions.jsonl` | Production |
| Nettoyage sécurisé | `nmsvs clean` : inventaire à blanc, puis `--apply` | Production |
| Rapports | chaque commande longue écrit un rapport (`report.md`/`.json`, journal, versions des outils) | Production |

**Liste blanche du nettoyage.** `nmsvs clean` ne supprime que les intermédiaires régénérables :
- segments de rendu et mezzanines de `build/` ;
- exports `.tmp` interrompus.

Il refuse d'agir si une commande longue est en cours, si un fichier vient d'être modifié ou si un MP4 final est illisible. Il ne touche jamais aux sources, copies importées, configurations, analyses, exports, sous-titres, rapports, décisions ni aux fichiers inconnus.

### Non pris en charge actuellement

- Plateformes autres que Windows.
- Intégration continue.
- Accélération GPU de l'alignement.
- Transcription libre de paroles inconnues : l'alignement suppose le texte fourni.
- Vidéo source animée comme média de scène : les scènes utilisent des images fixes animées par la caméra.

## Validations en conditions réelles

Le moteur a servi à réaliser **quatre productions vidéo complètes** à partir de sources réelles :

| | Format | Profil | QC automatique |
|---|---|---|---|
| 2 vidéos horizontales (≈ 2 à 3 min) | 3840 × 2160, 30 i/s, H.264 + AAC | `youtube-4k-master` | aucun défaut bloquant ni majeur |
| 2 vidéos verticales (≈ 30 à 40 s) | 1080 × 1920, 30 i/s, H.264 + AAC | `reel-1080-h264` | aucun défaut bloquant ni majeur |

Ces productions ont exercé, dans des conditions réelles :
- **Montage** : scènes ancrées sur la musique, préambule silencieux, mouvements de caméra, transitions page tournée et coupe, personnages animés.
- **Texte** : synchronisé sur la voix, une phrase à la fois sur un calque de bandeau indépendant, masqué pendant les transitions de scène.
- **Montages verticaux** : indépendants des vidéos horizontales, avec leur timeline, leurs recadrages, leur couche de synchronisation et leur séquence de fermeture.
- **Séquence commune** : une séquence de fin, définie une fois, réutilisée dans les deux projets.

Toutes les entrées ont été conservées dans chaque projet. Le déterminisme du rendu est vérifié par les tests ; aucun projet nettoyé n'a été intégralement re-rendu à ce jour.

Résultats vérifiés :
- **Export** : décodage intégral des fichiers finaux et empreintes SHA-256 consignées.
- **Audio** : décalage de 0 ms avec le master original, vérifié par corrélation sur une production.
- **Sources** : empreintes identiques avant et après production.
- **Nettoyage** : `nmsvs clean` appliqué à la clôture des deux projets, sans perte d'information de production.
- **Validation** : les quatre vidéos finales ont été validées techniquement et artistiquement par l'utilisateur, et chaque validation est consignée dans le journal de décisions du projet.

Cette validation porte sur les scénarios effectivement exercés. Elle ne constitue pas une couverture exhaustive des fonctionnalités : la colonne « Preuve » des tableaux ci-dessus distingue ce qui a été utilisé en production de ce qui n'est couvert que par les tests.

## Statut de qualification

- **Productions réelles** : quatre vidéos validées (voir ci-dessus).
- **Tests automatisés** : verts (voir [Tests](#tests)).
- **Qualification globale V1.0** : le cahier de recette prévu au cadrage (scénarios de bout en bout sur deux projets pilotes, grille formelle) **n'a pas été exécuté formellement**. Le second projet pilote n'a pas été produit. Les validations obtenues sont des **validations en production** ; elles ne valent pas certification globale de la V1.0.

## Architecture

```
bin/nmsvs.mjs, nmsvs.cmd   lanceurs de la CLI
src/cli/                   commandes (sortie --json structurée, erreurs typées, reprise)
src/model/                 types, schémas JSON (Ajv 2020-12), presets, modèles de séquences
src/pipeline/              étapes à cache par clé de contenu, manifeste
src/modules/               analyse, synchro, assets, timeline (compilateur), rendu, export, QC, extraits verticaux, nettoyage
src/remotion/              compositions Remotion (React) : plans, transitions, textes, bandeaux, personnages animés
python/nmsvs_audio/        worker Python (analyse audio, transcription témoin, alignement) ; contrat JSON par fichiers
schemas/, presets/         contrats des fichiers de projet ; presets (mouvements, transitions, styles, zones sûres, export)
tests/                     Vitest (unitaires, intégration, images de référence), pytest ; fixtures synthétiques
docs/                      modèle de données, guides, règles de production
```

Chaîne de traitement :
1. Les **fichiers humains** (`project`, `assets`, `lyrics`, `timeline`, `reels`, corrections de synchronisation) sont validés par schéma.
2. Le **compilateur** TypeScript les transforme en **timeline résolue** en images et en pixels (plans, transitions, textes, calques, zones sûres, alertes).
3. Cette timeline est rendue par des **compositions Remotion pures**, donc déterministes, en **segments** mis en cache.
4. **FFmpeg** assemble et encode le résultat.
5. Le **QC** contrôle le fichier final.

Un projet vit dans `projects/<slug>/` :
- les fichiers JSON humains ;
- les copies des médias dans `media/` ;
- les dossiers machine `analysis/`, `build/`, `exports/` et `reports/`.

**Ce dossier n'est pas versionné.**

## Prérequis

- **Windows 10/11**.
- **Node.js ≥ 20** (testé avec 24).
- **FFmpeg ≥ 9** et **FFprobe** dans le `PATH`.
- **Python 3.12**.
- **Remotion 4.0.543**, installé par `npm ci`. Chrome Headless Shell est téléchargé par Remotion au premier rendu.
- **Modèles IA** : téléchargés à la demande dans `.nmsvs/models` (faster-whisper, wav2vec2 français). Ils ne sont **pas** inclus dans ce dépôt.

Installation détaillée : [docs/INSTALLATION_WINDOWS.md](docs/INSTALLATION_WINDOWS.md).

## Installation

```powershell
git clone https://github.com/<compte>/NM-Story-Video-Studio.git
cd NM-Story-Video-Studio
npm ci
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.8.0+cpu torchaudio==2.8.0+cpu torchvision==0.23.0+cpu
.\.venv\Scripts\python.exe -m pip install -r python\requirements.lock
.\nmsvs.cmd doctor
```

## Commandes

Démarrage pas à pas : [docs/DEMARRAGE_RAPIDE.md](docs/DEMARRAGE_RAPIDE.md). Toutes les commandes acceptent `-p <projet>`, `--json` (réponse `{ ok, result, warnings, report, artifacts }` ou `{ ok: false, error: { code, message, action } }`) et `-q`.

| Étape | Commandes |
|---|---|
| Environnement | `nmsvs doctor` |
| Projet | `nmsvs init mon-projet --title "Mon projet" [--formats 16x9,9x16]` · `status` · `resume` |
| Import (copie, originaux intacts) | `import audio <fichier>` · `import lyrics <fichier>` · `import images <fichiers…\|dossier>` · `import textures <fichiers…>` |
| Validation et traçabilité | `validate` · `decide "<décision>" --scope <portée> --reason "<raison>"` · `presets [famille]` |
| Analyse | `analyze` |
| Synchronisation | `sync [--engine whisperx\|stable-ts\|uniform] [--lines <sélection>]` · `sync report` · `sync fix <id> --start <s> --end <s> --lock` · `sync shift <id> +0.2` · `sync offset -0.04` · `sync apply <lot.json>` · `sync unlock <id>` · option `--shorts` |
| Montage | `compose` (proposition) · édition de `timeline.json` · `timeline` (compilation sans rendu) |
| Prévisualisation (sur demande) | `preview still <t> [-f 9x16] [--safe]` · `preview contact` · `preview draft --from <repère> --to <repère>` · `preview studio` |
| Rendu et export | `render` (segments seuls) · `export --profile <id> [--label <version>] [--replace]` · `qc <fichier>` |
| Extraits verticaux | `reels analyze [--audio]` · `reels select <cand…> [--adjust-start/--adjust-end <id=sec>] [--no-snap]` · `reels build` · `reels build --try <cand>` |
| Maintenance | `clean` (inventaire) · `clean --apply` · `cache gc` |

### Exemple : vidéo horizontale puis extrait vertical

```powershell
.\nmsvs.cmd init mon-clip --title "Mon clip"
.\nmsvs.cmd -p mon-clip import audio master.wav
.\nmsvs.cmd -p mon-clip import lyrics paroles.txt
.\nmsvs.cmd -p mon-clip import images .\illustrations
.\nmsvs.cmd -p mon-clip analyze
.\nmsvs.cmd -p mon-clip sync                 # puis lire sync-report.md et corriger (sync fix / shift / apply)
.\nmsvs.cmd -p mon-clip compose              # proposition de timeline.json, à éditer
.\nmsvs.cmd -p mon-clip validate
.\nmsvs.cmd -p mon-clip export --profile youtube-4k-master
.\nmsvs.cmd -p mon-clip reels analyze        # 5 propositions, aucune production
.\nmsvs.cmd -p mon-clip reels select cand-2  # choix explicite de l'utilisateur
.\nmsvs.cmd -p mon-clip reels build
```

Exemple de scène dans `timeline.json` (deux illustrations, la seconde à partir de la ligne 3, transition en volet) :

```json
{
  "id": "sc-refrain",
  "span": { "from": { "section": "chorus-1", "edge": "start" }, "to": { "section": "verse-2", "edge": "start" } },
  "illustrations": [
    { "asset": "img-a", "motion": "preset:slow-push-in", "until": { "line": "chorus-1.l3", "edge": "start" } },
    { "asset": "img-b", "motion": "preset:pan-left-right" }
  ],
  "transitionIn": "preset:wipe-linear",
  "lyrics": { "style": "preset:lyrics-text-on-image-default" }
}
```

Modèle de données complet : [docs/04_MODELE_DONNEES_JSON.md](docs/04_MODELE_DONNEES_JSON.md).

## Tests

```powershell
npm run typecheck
npm test                    # tests unitaires TypeScript (124)
npm run test:py             # tests du worker Python (10)
npm run test:integration    # bout en bout réel : Remotion + FFmpeg, export 3840 × 2160, interruption/reprise, extraits verticaux, 39 images de référence (SSIM), déterminisme du rendu ; ~6 min
```

- **Tests unitaires** : schémas, synchronisation, compilateur, recadrage, animations, extraits verticaux, règles de production, nettoyage, modèles de séquences, personnages animés, bandeaux texturés.
- **Tests d'intégration** : 17 cas, verts lors de leur dernière exécution.
- **Images de référence** : rendues depuis des mires synthétiques, en 16:9 et 9:16.
- **Données** : aucune ne provient d'une création réelle.

## Limites connues

- **Synchronisation sur voix chantée.** L'alignement automatique reste imparfait. En production, une écoute humaine, des réalignements localisés et des corrections par lot (`sync apply`) ont été nécessaires. Le karaoké au mot est déconseillé quand les timings de mots sont dégénérés.
- **Le QC ne remplace pas le visionnage.** Le QC automatique contrôle la conformité technique et plusieurs règles de lisibilité, mais pas toutes les erreurs de montage : une transition indésirable, par exemple, peut passer inaperçue. Un visionnage humain reste nécessaire avant validation.
- **Relances de mouvement.** Une scène plus longue que deux fois `art.shotLength.max` sur une seule illustration est découpée en plans successifs enchaînés par la transition par défaut du projet. Pour l'éviter, il faut borner la scène ou fournir plusieurs illustrations.
- **Recadrage vertical.** Une illustration paysage recadrée en 9:16 ne conserve qu'environ un tiers de sa largeur. Il faut des points focaux, des rectangles de recadrage ou des images de remplacement.
- **Plateforme.** Seul Windows est pris en charge et testé (lanceur `nmsvs.cmd`, chemins `.venv\Scripts`, encodeurs AMD AMF facultatifs).
- **Performances.** L'alignement et le rendu Remotion se font sur CPU : un rendu 4K est long.

## Documentation

| Document | Contenu |
|---|---|
| [docs/INSTALLATION_WINDOWS.md](docs/INSTALLATION_WINDOWS.md) | Installation pas à pas |
| [docs/DEMARRAGE_RAPIDE.md](docs/DEMARRAGE_RAPIDE.md) | Premier projet, premier extrait vertical |
| [docs/GUIDE_UTILISATEUR.md](docs/GUIDE_UTILISATEUR.md) | Utilisation complète |
| [docs/GUIDE_DEVELOPPEUR.md](docs/GUIDE_DEVELOPPEUR.md) | Architecture du code, tests, extension |
| [docs/04_MODELE_DONNEES_JSON.md](docs/04_MODELE_DONNEES_JSON.md) | Modèle de données : fichiers JSON d'un projet |
| [docs/12_REGLES_PRODUCTION.md](docs/12_REGLES_PRODUCTION.md) | Règles de production (exports, extraits verticaux, nettoyage, validation) |
| [docs/LICENCES_TIERS.md](docs/LICENCES_TIERS.md) | Licences des dépendances et des modèles |
| [AGENTS.md](AGENTS.md) | Règles de pilotage par un agent de code |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution |

Les documents internes de cadrage, de conception et de recette (références `docs/01`…`docs/11` citées dans certains commentaires du code) ne sont pas publiés.

## Développement assisté par IA

NMSVS a été développé **avec l'assistance d'agents de codage IA** (OpenAI Codex, puis Anthropic Claude Code), sous **pilotage humain**. Une large part du code, des tests et de la documentation a été rédigée par ces agents ; elle n'est pas présentée comme écrite manuellement.

L'auteur :
- définit les exigences et les critères de validation ;
- arbitre les choix techniques et artistiques ;
- fixe les règles de gouvernance : préservation absolue des sources, aucune sélection artistique faite à sa place, aucune publication ni suppression sans autorisation ;
- **valide les résultats**.

Le travail avance par campagnes ciblées : brief, implémentation, tests, rapport factuel (PASS / FAIL / NOT_TESTED), puis validation humaine. Les décisions sont consignées dans le journal de décisions de chaque projet.

**Technologies** : Node.js et TypeScript, Remotion 4, React 19, FFmpeg, Python 3.12 (PyTorch CPU, librosa, WhisperX, faster-whisper), JSON Schema et Ajv, Vitest, pytest.

## Licence

Copyright 2026 NIMOTORY.

Le code de ce dépôt est distribué sous **Apache License 2.0** : voir [LICENSE](LICENSE) et [NOTICE](NOTICE).

- **Ce que couvre la licence.** Le code, les schémas, les presets, les fixtures synthétiques, les images de référence des tests et la documentation de ce dépôt.
- **Ce qu'elle ne couvre pas.** Les dépendances tierces et les créations artistiques de l'auteur, qui ne sont pas incluses.
- **Dépendances.** Elles ne sont pas redistribuées, mais installées par l'utilisateur, qui doit respecter leurs licences ([docs/LICENCES_TIERS.md](docs/LICENCES_TIERS.md)). C'est le cas notamment de :
  - **Remotion**, sous sa licence propre : gratuite pour les particuliers et les petites équipes, licence d'entreprise requise au-delà ([remotion.dev/license](https://www.remotion.dev/license)) ;
  - FFmpeg, PyTorch, WhisperX, faster-whisper et librosa ;
  - les poids des modèles IA.

# Guide utilisateur NMSVS

Ce guide décrit l'utilisation quotidienne. En pratique, vous parlez à Codex ; Codex exécute les commandes ci-dessous
(règles dans [AGENTS.md](../AGENTS.md)). Toutes les commandes s'écrivent `.\nmsvs.cmd <commande> -p <projet>`.

## 1. Cycle de travail

```
init → import (audio, paroles, images, textures) → sync → compose → [ajustements] → preview → export → reels
```

Chaque étape est **mise en cache** : relancer une commande ne recalcule que ce qui a changé.
Chaque exécution produit un rapport dans `projects/<projet>/reports/<date>-<commande>/report.md`.

## 2. Préparer les médias

| Média | Recommandation |
|---|---|
| Audio maître | WAV ou FLAC 44,1/48 kHz (un MP3 est accepté avec alerte). Jamais modifié : copié dans `media/audio`. |
| Paroles | Texte UTF-8 avec en-têtes `[Couplet 1]`, `[Refrain]`, `[Pré-refrain]`, `[Pont]`, `[Intro]`, `[Outro]`, `[Instrumental]`, `[Parlé]`. `(x2)` en fin de ligne répète la ligne ; `[Refrain] x2` répète la section. `#` = commentaire. |
| Illustrations | PNG/JPG/WebP/TIFF. Pour la 4K avec mouvement : **≥ 4224×2376** (16:9) ; pour le vertical, une image dédiée ≥ 1188×2112 ou un cadrage. Alerte au-delà de 1,2× d'agrandissement, erreur au-delà de `art.maxUpscale` (1,5). |
| Texture de parchemin | Optionnelle (`import textures`), sinon texture procédurale. |
| Polices | Fichier `.ttf/.otf/.woff2` placé dans `media/fonts/` puis `project.json → art.fonts.lyrics`. Sans police : Georgia (système). |

## 3. Synchronisation des paroles

`nmsvs sync` : analyse musicale, pré-traitement « vocal-focus » (canal central + filtre voix, sans modèle tiers),
transcription grossière (faster-whisper large-v3, CPU), alignement fin mot à mot (wav2vec2 français, licence Apache-2.0).
Le premier lancement télécharge les modèles (~4,5 Go dans `.nmsvs/models`). Ensuite tout fonctionne hors ligne.

Lire **`sync-report.md`** : lignes à faible confiance en tête, durées de lecture insuffisantes, mots interpolés, écarts texte/chant.

| Correction | Commande |
|---|---|
| Décaler une ligne | `sync shift chorus-1.l2 +0.15` (ou `-0.1`) |
| Fixer début/fin et verrouiller | `sync fix chorus-1.l2 --start 63.42 --end 66.10 --lock` |
| Fixer un mot | `sync fix chorus-1.l2.w4 --start 64.90` |
| Corriger **pour les Shorts seulement** (le clip n'est pas touché) | ajouter `--shorts` à `sync fix`, `shift`, `unlock` ; fichier déclaré dans `reels.json → params.syncOverrides` |
| Corrections par lot (une seule décision) | `sync apply timings.json [--shorts] --reason "…"` (JSON `{ "lines": { id: { start, end } }, "words": { … } }`, entrées verrouillées) |
| Décalage global | `sync offset -0.04` |
| Réaligner une zone (les lignes verrouillées servent d'ancres) | `sync --lines verse-2.l1-verse-2.l4` · `sync --lines bridge-1` |
| Annuler | `sync unlock chorus-1.l2` (déverrouille) · `sync unlock chorus-1.l2 --clear` (supprime la correction) |
| Écouter | `preview draft --from verse-2 --to chorus-2` |

Les corrections sont stockées dans `sync.overrides.json` et ne sont **jamais** écrasées par un recalcul.
Si l'audio maître change, elles sont conservées et signalées « à revalider ».

Mesurer la précision (recette) : `sync reference-template` crée `reference.timings.json` (20 lignes) ; notez à l'oreille
le début de chaque ligne, puis `sync evaluate --auto` (synchro automatique seule) ou `sync evaluate` (avec corrections).

Option : `"sync": { "engine": "stable-ts" }` dans `project.json` (autre moteur d'alignement) ; `"uniform"` = répartition
proportionnelle sans écoute (tests uniquement) ; `"preprocess": "none"` désactive le filtre vocal.

## 4. Composition

`nmsvs compose` écrit une **proposition** `timeline.json` (une scène par section, intro titrée si l'introduction dépasse 3 s,
interludes > 6 s, plans de 6–10 s, mouvements alternés, fondus au noir). `compose.md` explique le découpage.
La timeline est ensuite **à vous** : `compose --overwrite` est nécessaire pour la remplacer (avec sauvegarde `.bak`).

### Scène type

```json
{
  "id": "sc-refrain-1",
  "span": { "from": { "section": "chorus-1", "edge": "start", "offsetSec": -0.3, "snap": "beat" },
            "to":   { "section": "verse-2", "edge": "start" } },
  "illustrations": [
    { "asset": "img-scene-01", "motion": "preset:beat-pulse", "until": { "line": "chorus-1.l3", "edge": "start" } },
    { "asset": "img-chateau", "motion": { "type": "pan", "from": { "scale": 1.15, "x": 0.2 }, "to": { "scale": 1.15, "x": 0.8 } } }
  ],
  "illustrationTransition": "preset:crossfade-beat",
  "transitionIn": "preset:zoom-through",
  "lyrics": { "style": "preset:lyrics-text-on-image-default", "karaoke": "word" },
  "formats": { "9x16": { "lyrics": { "position": "center" } } }
}
```

- **Ancres** : `at` (secondes), `section`, `line`, `word`, `beat`, `bar`, `end` ; `offsetSec` ; `snap: beat|downbeat` (±150/300 ms).
- **Répartition** des illustrations : `byLines` (changements sur débuts de lignes), `even` (temps forts), `explicit` (`until` = fin de l'illustration), `weights`.
- **Mouvements** : `slow-push-in`, `slow-pull-out`, `pan-left-right`, `pan-right-left`, `pan-up`, `drift`, `still`, `beat-pulse`, `parallax` (avec `foreground`: calque détouré fourni).
- **Transitions** : `cut`, `crossfade-beat`, `crossfade-long`, `fade-black`, `dip-to-color`, `slide-left`, `zoom-through`, `wipe-linear`, `wipe-radial`, `blur-dissolve`, `page-turn` (livre illustré : la page pivote sur sa reliure avec perspective et ombre ; `direction` `left` = reliure à gauche, sens de lecture, ou `right`) — durées en temps musicaux ou en secondes (`{ "sec": 1.5 }`, indépendant du tempo détecté).
- **Paroles** : `lyrics-text-on-image-default`, `lyrics-parchment-default`, `lyrics-cartouche-default`, `lyrics-reel-cartouche`, `lyrics-fast` (cartouche sans flou) ; `style: "none"` masque les paroles ; style en ligne possible (`{ "type": "cartouche", "extends": "preset:…", "panel": { "opacity": 0.6 } }`).
  `"flow": "scroll"` : **défilement synchronisé** — la ligne chantée au premier plan, la suivante en attente dessous (atténuée) qui monte au départ de son chant (texte sur image ou cartouche). Le karaoké au mot repasse automatiquement **par ligne** pour une ligne dont un mot dure moins de 80 ms (alignement dégénéré, alerte `I_KARAOKE_LINE`).
  `"flow": "phrase"` : **une phrase à la fois** — les lignes sont regroupées jusqu'à la ponctuation finale (`. ! ?` ; `…` seulement si la ligne suivante commence par une majuscule ou un tiret), au plus `lines` lignes ; chaque ligne apparaît à son propre chant (révélation progressive), toute la phrase s'efface au départ de la suivante ; une phrase d'une ligne est centrée. Le conteneur (parchemin) persiste d'une scène à l'autre tant que le chant continue (pause < 3 s) : les pages tournent derrière lui.
  `"leadSec": 0` : avance d'affichage propre au style (défaut `art.lyricLeadSec`, 0,25 s) ; **0 = jamais avant le chant**.
- **Titres** : `"title": { "text": "…", "style": "preset:title-parchment", "durationSec": 4 }`.
- **Effets** : `art.vignette`, `art.grain` (projet) ou `effects` par scène.

Ordre de résolution du style d'une ligne : ligne → scène (et surcharge de format) → section → `art.lyricStyle`.

## 5. Couleur et recadrage

- `art.harmonize` : `{ "mode": "auto", "strength": 0.5, "reference": "img-…" }` — correction bornée vers la médiane du lot (ou l'image de référence). `assets.json → grade.excludeFromHarmonize` pour exclure une image.
- `art.colorLook` : `{ "lut": "media/luts/look.cube", "intensity": 0.6 }`.
- `assets.json → grade` : `exposure` (EV), `contrast`, `saturation`, `temperature` (−1…1), additifs.
- Recadrage par format, par priorité : `replace["9x16"]` (autre image) > `crops["9x16"]` (rectangle 0–1) > `focal` (point focal) > centre. `safeSubject` (rectangle) active l'alerte « sujet coupé ». `fit: "blurFill"` garde l'image entière sur fond flouté ; `fits: { "9x16": "blurFill" }` le fait **pour un format seulement** (le 16:9 reste inchangé).
- Zones de sécurité : presets `safe-16x9-default` (title safe 90 %) et `safe-9x16-social` (hypothèses à vérifier sur les plateformes). `preview still <t> --safe` les affiche.

## 6. Prévisualiser

| Commande | Résultat |
|---|---|
| `preview studio -f 16x9 [--safe]` | Remotion Studio (lecture, image par image). Fermer avec Ctrl+C. |
| `preview still 62.5 -f 9x16 --safe` | PNG pleine résolution |
| `preview contact -f 9x16` | Planche-contact (milieu de chaque plan + chaque bloc de paroles), zones sûres visibles |
| `preview draft [--from chorus-1 --to chorus-2]` | Vidéo basse résolution avec son (encodage GPU AMD) |

## 7. Exporter

`export --profile <id>` (plusieurs possibles) ; sans option : `project.exportProfiles`.

**Préambule silencieux** : `project.json → "preroll": { "sec": 3 }` fait commencer la vidéo 3 s avant la chanson.
Le premier plan (ex. la couverture) est visible dès l'image 0, caméra figée jusqu'au début de son mouvement ; la chanson
démarre à 3,000 s (silence numérique ajouté à l'assemblage, WAV inchangé) ; tout le montage est décalé d'autant
(arrondi à l'image : `round(sec × fps)`). Les ancres de `timeline.json` restent en **temps chanson** : rien à modifier.
Sous-titres de l'export décalés d'autant ; `exports/<id>.srt/.vtt/.lrc` restent en temps chanson. Les Reels et
`preview draft --from/--to` ignorent le préambule ; `preview still <t>` prend un temps **vidéo**.
À ne pas confondre avec `audio.offsetSec` (recalage fin du master par rapport à l'image, sans allonger la vidéo).

| Profil | Usage |
|---|---|
| `youtube-4k-master` | Maître 3840×2160, libx264 CRF 16 *slow*, AAC 320 kb/s, + SRT/VTT |
| `youtube-4k-fast` | Même format, encodeur GPU AMD (HEVC) — itérations |
| `reel-1080-h264` | Vertical 1080×1920, CRF 18 |
| `reel-2160-h264` | Vertical 2160×3840 (option) |
| `archive-hevc10` | Archive HEVC 10 bits + FLAC (MKV) |
| `draft-16x9`, `draft-9x16` | Brouillons |

Un export existant n'est jamais écrasé ni archivé automatiquement (règles V1.1) : le moteur refuse (`E_EXPORT_EXISTS`)
sauf autorisation explicite `--replace` ; pour une nouvelle version, préférer un autre nom (`--label`). Les fichiers déjà
présents dans `exports/archive/` sont historiques et ne sont supprimés que sur autorisation distincte. Un export qui échoue à un contrôle
**bloquant** est renommé `*.REJECTED.mp4` et le rapport `qc-*.md` explique pourquoi.
Garantie : NMSVS n'ajoute aucun filigrane. Le contrôle QC-E7 vérifie l'intégrité des calques rendus ; il ne peut pas
détecter un filigrane déjà présent dans une illustration fournie.

## 8. Reels

1. `reels analyze` : 5 extraits (durées `reels.json → params.durations`, défaut 20/30/45 s), classés selon 8 critères
   (accroche, énergie, montée, présence vocale, complétude, texte lisible, bouclage, singularité), diversifiés,
   **justifiés**, avec extraits audio `reels/cand-N.m4a` dans le rapport. Aucune prédiction d'audience.
2. Vous choisissez : `reels select cand-1 cand-4 --name cand-1=refrain-final [--adjust-start cand-4=-0.5]`.
3. `reels build` : production en 9:16 (timeline du clip si elle existe, sinon composition automatique), fondus audio/image, QC.

Pondérations : `params.weights` = `preset:reels-balanced | reels-hook-first | reels-energy-first | reels-narrative` ou objet.

- **Timeline des Shorts** : `reels.json → params.timeline: "reels.timeline.json"` (mêmes ancres en temps chanson, styles de paroles verticaux) ; sinon la timeline du clip. Le préambule (`preroll`) ne s'applique jamais aux Shorts.
- **Synchronisation des Shorts** : `reels.json → params.syncOverrides: "sync.overrides.shorts.json"` — corrections appliquées par-dessus celles du clip, pour les Shorts uniquement (trace : `build/sync.shorts.resolved.json`). Le clip YouTube, ses ancres et ses sous-titres n'en dépendent jamais.
- **Essai technique** (sans sélection, `reels.json` inchangé, consigné comme essai du moteur) : `reels build --try cand-1 [--timeline reels.timeline.B.json] [--from 94.5 --to 106.5] [--label style-B]` → `exports/<projet>-try-cand-1-<label>.mp4`.
- Bornes des extraits : une fin de ligne s'étend au plus jusqu'à 0,05 s avant la ligne suivante (jamais +0,3 s sur une ligne enchaînée) ; fondus `project.reels.fadeInSec/fadeOutSec`, aussi appliqués aux extraits d'écoute.

## 8 bis. Règles V1.1 (détail : `docs/12_REGLES_PRODUCTION.md`)

- **Propositions de Shorts** : `reels analyze` produit 5 fiches (paroles, pertinence musicale et narrative, scènes du clip, montage vertical, style envisagé, limites) ; extraits audio seulement avec `--audio`. Aucun Short final avant `reels select`.
- **Fermeture d'un Short** : `reels.json → params.closing` (`scene`, `transition`, `lyricsOutSec`, `holdSec`) — ajoutée après la musique : paroles masquées, page tournée à rebours vers la scène indiquée, fin sur l'image ; l'audio s'arrête avec la musique.
- **Ouverture sans texte** : scène d'ouverture `"lyrics": { "style": "none" }` ; avec `parchment.unrollSec` court (0,25 s), le parchemin se déroule juste après la page tournée.
- **Exports** : plus d'archive automatique ; un export existant n'est remplacé qu'avec `--replace` (`export`, `reels build`). Préférer un nouveau nom (`--label`).
- **YouTube** : profil `youtube-*` exigeant 3840 × 2160, MP4, sans mise à l'échelle (sinon `E_PROFILE`).
- **Nettoyage** : `nmsvs clean` (à blanc) puis `nmsvs clean --apply` — segments et mezzanines de `build/` et exports partiels `.tmp` uniquement ; refus si un traitement est actif ou si un MP4 final est illisible ; sources, JSON, exports et archives jamais touchés.

## 9. Incidents

| Situation | Action |
|---|---|
| Interruption (Ctrl+C, panne) | `nmsvs resume` — les segments déjà rendus sont conservés |
| `E_TIMELINE_GAP` | Les scènes doivent se suivre : `to` d'une scène = `from` de la suivante |
| `E_SCHEMA` | Le message donne le fichier, le chemin JSON et la cause |
| Disque | `nmsvs cache gc` supprime les segments hors des 3 derniers plans de rendu |
| Diagnostic | `nmsvs doctor` |

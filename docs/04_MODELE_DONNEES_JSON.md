# 04 — Modèle de données JSON

## 1. Conventions communes

- Schémas **JSON Schema 2020-12** dans `schemas/`, identifiants `https://nmsvs.local/schemas/<nom>/v<N>.json`.
- Chaque fichier porte `"$schema"` et `"schemaVersion"` (entier). Migrations dans `src/model/migrations/<nom>/<n>-to-<n+1>.ts`, appliquées par `nmsvs validate --migrate` (sauvegarde `.bak` avant).
- `additionalProperties: false` partout (faute de frappe = erreur explicite).
- Identifiants : `[a-z0-9][a-z0-9-]*` (ex. `chorus-1`, `img-forest-01`). Les lignes de paroles : `<sectionId>.l<n>` (ex. `verse-1.l3`), les mots : `<lineId>.w<n>`.
- Temps : **secondes décimales** dans les fichiers humains (lisibles), **images entières** dans les fichiers résolus.
- Coordonnées normalisées `[0..1]` (origine haut-gauche) pour points focaux et cadrages ; indépendantes de la résolution.
- Couleurs : `#RRGGBB` ou `#RRGGBBAA`.
- Chemins : relatifs au dossier du projet, séparateur `/` (normalisé sous Windows).
- Les champs absents prennent la valeur du **niveau supérieur** (cascade : ligne → scène → section → projet → preset).

## 2. Fichiers humains

### 2.1 `project.json`

```json
{
  "$schema": "https://nmsvs.local/schemas/project/v1.json",
  "schemaVersion": 1,
  "id": "example-project",
  "title": "Example project",
  "audio": { "master": "media/audio/sample-audio.wav", "offsetSec": 0 },
  "preroll": { "sec": 0 },
  "lyrics": "lyrics.json",
  "fps": 30,
  "formats": {
    "16x9": { "width": 3840, "height": 2160, "safeZone": "preset:safe-16x9-default" },
    "9x16": { "width": 1080, "height": 1920, "safeZone": "preset:safe-9x16-social" }
  },
  "art": {
    "lyricStyle": "preset:lyrics-cartouche-default",
    "transitionDefault": "preset:crossfade-beat",
    "motionCycle": ["preset:slow-push-in", "preset:drift"],
    "colorLook": { "lut": "presets/looks/warm-legend.cube", "intensity": 0.6 },
    "harmonize": { "mode": "auto", "strength": 0.5 },
    "fonts": { "lyrics": "fonts/MaPolice.ttf", "titles": "fonts/MaPoliceTitre.ttf" },
    "palette": { "text": "#F5EBDD", "accent": "#C8A15A", "shadow": "#000000B0" }
  },
  "exportProfiles": ["youtube-4k-master", "reel-1080-h264"]
}
```

### 2.2 `assets.json`

```json
{
  "schemaVersion": 1,
  "images": [
    {
      "id": "img-forest-01",
      "path": "media/images/foret_01.png",
      "sha256": "…",
      "size": { "w": 5120, "h": 2880 },
      "focal": { "x": 0.62, "y": 0.40 },
      "safeSubject": { "x": 0.45, "y": 0.20, "w": 0.35, "h": 0.55 },
      "crops": { "9x16": { "x": 0.40, "y": 0.0, "w": 0.316, "h": 1.0 } },
      "replace": { "9x16": "img-forest-01-portrait" },
      "grade": { "exposure": 0, "contrast": 0, "saturation": 0, "temperature": 0, "excludeFromHarmonize": false },
      "tags": ["forêt", "nuit"]
    }
  ],
  "textures": [ { "id": "parchment-a", "path": "media/textures/parchemin.png" } ]
}
```
`sha256` et `size` sont renseignés par l'import (et recalculés si le fichier change) ; ce sont les seuls champs machine tolérés dans un fichier humain. Règle : `replace[format]` prime sur `crops[format]`, qui prime sur `focal` (recadrage automatique centré sur le point focal), qui prime sur le centre.

### 2.3 `lyrics.json`

```json
{
  "schemaVersion": 1,
  "language": "fr",
  "sections": [
    {
      "id": "verse-1", "kind": "verse", "label": "Couplet 1",
      "lines": [
        { "id": "verse-1.l1", "text": "Sous le phare des collines anciennes",
          "display": { "9x16": "Sous le phare\ndes collines anciennes" },
          "singer": null, "skipAlign": false }
      ]
    },
    { "id": "chorus-1", "kind": "chorus", "label": "Refrain", "repeatOf": null, "lines": [] }
  ]
}
```
`kind` ∈ `intro|verse|prechorus|chorus|bridge|outro|instrumental|spoken|other`. `display` permet des retours à la ligne par format. `skipAlign` exclut une ligne (ex. chœur inaudible) qui reste positionnable manuellement.

### 2.4 `timeline.json` (timeline déclarative)

```json
{
  "schemaVersion": 1,
  "scenes": [
    {
      "id": "sc-intro",
      "span": { "from": { "at": 0 }, "to": { "section": "verse-1", "edge": "start" } },
      "illustrations": [ { "asset": "img-title", "motion": "preset:slow-pull-out" } ],
      "lyrics": { "style": "none" },
      "title": { "text": "Example project", "style": "preset:title-parchment" },
      "transitionIn": "preset:fade-from-black"
    },
    {
      "id": "sc-verse-1",
      "span": { "from": { "section": "verse-1", "edge": "start", "offsetSec": -0.5 },
                "to":   { "section": "verse-1", "edge": "end" } },
      "illustrations": [
        { "asset": "img-forest-01", "motion": "preset:slow-push-in" },
        { "asset": "img-forest-02", "until": { "line": "verse-1.l3", "edge": "start" },
          "motion": { "type": "pan", "from": { "x": 0.3 }, "to": { "x": 0.7 }, "easing": "inOutSine" } },
        { "asset": "img-castle" }
      ],
      "distribution": "byLines",
      "illustrationTransition": "preset:crossfade-beat",
      "lyrics": { "style": "preset:lyrics-text-on-image", "karaoke": "word" },
      "formats": { "9x16": { "lyrics": { "position": "lower-third" } } }
    }
  ]
}
```

**Ancres temporelles** (`TimeAnchor`), une seule forme par ancre :

| Forme | Exemple | Résolution |
|---|---|---|
| Absolue | `{ "at": 12.5 }` | secondes |
| Section | `{ "section": "chorus-1", "edge": "start" }` | début/fin de la section (via sync) |
| Ligne | `{ "line": "verse-1.l3", "edge": "end" }` | début/fin de la ligne |
| Mot | `{ "word": "verse-1.l3.w2" }` | début du mot |
| Battement | `{ "beat": 64 }` ou `{ "bar": 16 }` | via `audio.json` |
| Modificateurs | `offsetSec`, `snap: "beat"|"downbeat"|"none"` | appliqués après résolution |

**Distribution des illustrations dans une scène** : `byLines` (changements calés sur des débuts de lignes), `even` (durées égales calées sur le battement), `explicit` (`until` sur chaque illustration), `weights` (`weight` par illustration).

**Personnages animés (`sprites`, V1.2)** : cycle de poses PNG transparentes (textures de `assets.json`, utilisées telles
quelles), déplacé en ligne droite à vitesse constante au-dessus des illustrations (sous les fondus et les paroles).

```jsonc
"sprites": [{
  "id": "perso-a", "frames": ["pose-01", "pose-02", "…"], "poseFps": 8,
  "height": 0.22,
  "path": { "from": { "x": 0.90, "y": 0.866 }, "to": { "x": 0.16, "y": 0.866 } },
  "startSec": 1.0, "durationSec": 6.3, "fadeSec": 0.5
}]
```

`height` : fraction de la hauteur de l'image (largeur proportionnelle) ; `path` : point d'appui bas-centre du PNG, en
coordonnées normalisées ; `startSec` relatif au début de la scène ; un trajet qui dépasse la scène est tronqué
(`W_SPRITE_CUT`). Le personnage le plus bas passe devant au croisement. Pose inconnue → `E_ASSET_MISSING`.

**Parchemin texturé (V1.2)** : `parchment.paper: { x, y, w, h }` (fractions de la texture) déclare la zone de papier plat
d'un bandeau fourni. Le bandeau est alors dessiné tel quel (proportions conservées, largeur = `maxWidth` × zone sûre, sans
ombre ni rouleaux), le texte tient dans cette zone (une ligne de texte par ligne chantée, taille plafonnée à la hauteur du
papier) et reste sur un calque distinct. **`sceneBreak: true`** (mode `phrase`) referme le conteneur à chaque changement
de scène : un parchemin par page, même si le chant continue ; il est en outre **absent pendant les transitions entre
scènes** (pages tournées) : fermeture achevée au premier instant de la transition, réouverture à sa fin (déroulé raccourci,
au minimum 0,1 s, si la voix entre aussitôt). Une ligne chantée entièrement pendant une transition n'est pas affichée
(information `I_TURN_HIDDEN`) ; la synchronisation des lignes et des mots n'est jamais modifiée.
**`centerX`** (fraction de la largeur du cadre) impose le centre horizontal du conteneur et du texte (ex. page d'un livre
décalée par sa reliure) ; défaut : centre de la zone sûre.

**Préambule et première transition (V1.2)** : la borne « 40 % du plan le plus court » d'une transition tient compte des
images de préambule ajoutées au premier plan ; une couverture courte en temps chanson peut donc tourner complètement
pendant la fin du préambule.

**Générique réutilisable (`credits`, V1.2)** : un modèle `*.credits.json` (schéma `credits`), rangé hors du projet (ex.
bibliothèque privée), décrit des séquences de fin — fond fixe, personnages animés, transitions, fondu final — dont les médias
sont des **emplacements nommés**. La timeline l'appelle ; ses séquences deviennent des scènes ordinaires ajoutées après la
dernière scène (en mémoire : `timeline.json` et `assets.json` ne sont pas réécrits).

```jsonc
"credits": {
  "template": "../../library/credits/mon-generique.credits.json",   // absolu ou relatif au projet
  "from": { "at": 123.3 },                                          // = fin de la dernière scène
  "mediaRoot": ["media/images", "media/textures"],                  // racines des médias (projet), facultatif
  "media": { "fond-a": { "asset": "img-fond" } },                   // surcharge d'emplacement, facultatif
  "overrides": { "remerciements": { "durationSec": 9 } }            // surcharge de séquence, facultatif
}
```

Modèle : `{ id, media: { emplacement: chemin | { asset } }, mediaRoot?, sequences: [{ id, background, durationSec?, motion?,
transitionIn?, transitionOut?, sprites? }] }` ; scène produite `sc-<id>` ; seule la dernière séquence peut omettre
`durationSec` (jusqu'à la fin de la musique). Résolution d'un média : valeur du projet puis du modèle ; chemin absolu tel
quel, sinon recherche dans les racines du projet, puis du modèle (relatives au fichier modèle), puis le dossier du modèle —
au chemin relatif indiqué puis par le seul nom de fichier. Les fichiers sont lus en place (assets virtuels `cr-<emplacement>`) :
aucune copie, aucun déplacement. `nmsvs validate` vérifie le modèle, la résolution de chaque média et l'enchaînement
(`credits.from` identique à la fin de la dernière scène).

### 2.5 `sync.overrides.json`

```json
{
  "schemaVersion": 1,
  "globalOffsetSec": 0.0,
  "lines": {
    "chorus-1.l2": { "start": 63.42, "end": 66.10, "lock": true, "note": "attaque après le souffle" },
    "verse-2.l1": { "shift": 0.15 }
  },
  "words": { "chorus-1.l2.w4": { "start": 64.90, "lock": true } }
}
```
Sémantique : `lock` fige la valeur ; l'alignement automatique ultérieur utilise les éléments verrouillés comme **ancres** et ne réaligne que les intervalles entre ancres.

### 2.6 `reels.json`

```json
{
  "schemaVersion": 1,
  "params": { "durations": [20, 30, 45], "count": 5, "maxOverlap": 0.35, "weights": "preset:reels-balanced" },
  "selection": [
    { "candidate": "cand-3", "name": "refrain-final", "adjust": { "startSec": -0.5 }, "snap": true }
  ]
}
```

`params.timeline` (optionnel) : timeline déclarative propre aux Shorts. `params.syncOverrides` (optionnel) : corrections de synchronisation propres aux Shorts (schéma de `sync.overrides.json`), superposées à celles du clip — une entrée des Shorts remplace celle du clip pour le même identifiant ; éditées par `nmsvs sync fix|shift|unlock|apply --shorts`, jamais à la main. Le clip ne les lit jamais. `params.closing` (optionnel) : fermeture des Shorts ajoutée après la musique — `{ "scene": "sc-couverture", "transition": { "type": "page-turn", "duration": { "sec": 1.2 }, "direction": "right" }, "lyricsOutSec": 0.4, "holdSec": 0.8 }`. `"audio": "continue"` (V1.2) : le master se poursuit sous la fermeture au lieu de s'arrêter avec l'extrait (pas de silence final, fondu audio sur les dernières images, jamais de fondu image) ; défaut `"stop"`.

### 2.7 `decisions.jsonl` (append-only)

```json
{"ts":"2026-11-20T21:04:00+01:00","by":"user","via":"codex","scope":"scene:sc-verse-1","decision":"Style cartouche pour le couplet 2","reason":"lisibilité sur image claire","refs":["timeline.json#/scenes/3"]}
```

## 3. Fichiers machine

| Fichier | Contenu principal |
|---|---|
| `analysis/audio.json` | `durationSec, sampleRate, tempo{bpm,confidence}, beats[], downbeats[], onsets[], rms{hopSec,values}`, `novelty`, `segments[{start,end,label,similarTo[]}]`, `loudness{integratedLUFS,truePeakDBTP,lra}`, `vocalActivity{hopSec,values}` |
| `analysis/sync.auto.json` | Par ligne/mot : `start,end,confidence,method`; `textDiff` (écarts texte/transcription), `normalizationMap` |
| `build/sync.resolved.json` | Fusion auto + overrides ; champ `source: auto|override|interpolated` par élément |
| `analysis/assets.stats.json` | Par image : luminance moyenne, histogramme, moyenne Lab, température estimée, corrections proposées |
| `analysis/reels.candidates.json` | Candidats, scores par critère, score global, justification, frontières (début/fin, raison du calage) |
| `build/<fmt>/timeline.resolved.json` | Tout en **images** : `fps, durationInFrames, scenes[{from,to,layers[]}], lyrics[{from,to,words[],styleResolved,box}], transitions[]`, assets → chemins dérivés |
| `build/manifest.json` | État des étapes, clés, segments, exports |

## 4. Presets

`presets/<famille>/<id>.json`, même mécanisme de schéma. Familles : `motion`, `transition`, `lyrics`, `title`, `safe`, `export`, `reels-weights`, `looks` (.cube). Un preset peut **étendre** un autre (`"extends": "preset:…"`). Référence : `"preset:<id>"` ou objet inline.

## 5. Liste des schémas à produire

`project`, `assets`, `lyrics`, `timeline` (avec `$defs`: `TimeAnchor`, `Motion`, `Transition`, `LyricsStyle`, `Crop`), `sync-overrides`, `reels`, `decision`, `audio-analysis`, `sync-auto`, `sync-resolved`, `assets-stats`, `reels-candidates`, `timeline-resolved`, `manifest`, `py-request`, `py-response`, `preset-*`, `export-profile`, `qc-report`.

Les types TypeScript sont **générés** (json-schema-to-typescript) ; les modèles Python utilisent des `TypedDict` générés ou validés via `jsonschema`. Un test vérifie que chaque exemple de `docs/` et de `tests/fixtures/` est valide.

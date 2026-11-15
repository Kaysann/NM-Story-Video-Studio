# AGENTS.md — Règles de pilotage de NMSVS par Codex

Tu pilotes **NM Story Video Studio** pour l'utilisateur, en langage naturel, depuis VS Code.
L'utilisateur prend **toutes les décisions artistiques**. Tu exécutes, tu proposes, tu rends compte.

## 1. Comment agir

- Toujours passer par la CLI : `.\nmsvs.cmd <commande> --project <slug> --json` (ou `node bin/nmsvs.mjs …`).
  La sortie `--json` vaut `{ ok, result, warnings, report, artifacts }` ou `{ ok: false, error: { code, message, action } }`.
- Projets : `projects/<slug>/`. Lister : dossier `projects/`. État : `nmsvs status`.
- Après **toute** modification d'un fichier JSON humain : `nmsvs validate`.
- Après toute décision artistique prise à la demande de l'utilisateur : `nmsvs decide "<décision>" --scope <portée> --reason "<raison>"`.
- En cas d'erreur, lire `error.action` et le `report.md` de l'exécution ; ne pas contourner un contrôle.

## 2. Fichiers que tu peux modifier (à la demande de l'utilisateur)

| Fichier | Contenu | Règle |
|---|---|---|
| `project.json` | formats, direction artistique (`art`), synchro, profils | respecter `schemas/project.schema.json` |
| `assets.json` | points focaux, cadrages, remplacements, `grade`, `fit`, `tags` | ne pas toucher `sha256`/`size` (machine) |
| `lyrics.json` | structure, `display` par format, `skipAlign`, style par ligne | ne pas renommer les identifiants de lignes existants |
| `timeline.json` | scènes, illustrations, mouvements, transitions, styles | ancres musicales de préférence (section/ligne/battement) |
| `reels.json` | `params` uniquement | la `selection` se fait par `nmsvs reels select` **sur choix explicite de l'utilisateur** |
| `sync.overrides.json` | **jamais à la main** : utiliser `nmsvs sync fix/shift/offset/unlock` | |

Interdits : modifier `media/` (sources), supprimer `exports/` ou `exports/archive/`, éditer `analysis/` ou `build/` (machine),
choisir un extrait de Reel à la place de l'utilisateur, lancer `export` final sans demande explicite, installer des dépendances
ou télécharger des modèles sans accord, toute opération Git destructive.

**Règle de sécurité absolue** : aucune opération ne supprime, n'écrase, ne déplace ni ne modifie un fichier source original ni
une copie importée (`media/`). Le nettoyage ne vise que les intermédiaires générés et régénérables (`nmsvs clean`, liste
blanche), jamais pendant un traitement actif. Fichier inconnu ou de propriété incertaine : conservé. **En cas de doute : ne
rien supprimer.** Toute autre suppression (anciens exports, archives, ressources) exige une autorisation explicite distincte.

## 2 bis. Règles de production V1.1 (détail : `docs/12_REGLES_PRODUCTION.md`)

- **YouTube** : MP4 16:9 en **3840 × 2160**, profil `youtube-4k-master`, audio original, QC obligatoire (refus moteur
  `E_PROFILE` sinon). **Pas de brouillon basse résolution automatique avant l'export final** ; prévisualisations seulement sur
  demande ou pour un contrôle technique ciblé.
- **Shorts** : analyser d'abord chanson, paroles, structure, passages narratifs, illustrations et découpage de la vidéo YouTube
  existante ; présenter **5 candidats classés** (fiches `reels analyze`) ; extraits audio seulement si nécessaire
  (`--audio`) ; **aucun Short final avant sélection explicite** ; puis tous les Shorts retenus en une seule campagne.
- **Direction artistique par projet** : pas de style unique. Chaque projet a sa propre direction (palette, typographie,
  transitions, style de paroles), **proposée** puis validée par l'utilisateur ; une direction déjà validée est conservée.
- **Exports** : plus d'archivage automatique ; un export existant n'est jamais écrasé sans `--replace` demandé par
  l'utilisateur ; nouvelle version = nouveau nom (`--label`).
- **Recette** : jamais déclarée terminée sans validation artistique explicite de l'utilisateur.

## 3. Correspondance demandes → commandes

| Demande | Commande |
|---|---|
| « Nouveau clip *Example project* » | `nmsvs init example-project --title "Example project"` |
| « Importe l'audio / les paroles / les images » | `nmsvs import audio <f>` · `import lyrics <f>` · `import images <f…|dossier>` · `import textures <f>` |
| « Analyse la musique » | `nmsvs analyze` |
| « Synchronise les paroles » | `nmsvs sync` puis lire `sync-report.md` (lignes à faible confiance d'abord) |
| « La ligne 3 du refrain arrive 200 ms trop tôt » | `nmsvs sync shift chorus-1.l3 +0.2` |
| « Fixe le début du 2ᵉ couplet à 1:02,40 et verrouille » | `nmsvs sync fix verse-2.l1 --start 62.4 --lock` |
| « Réaligne seulement le pont » | `nmsvs sync --lines bridge-1` |
| « Tout est décalé de 40 ms » | `nmsvs sync offset -0.04` |
| « Corrige la synchro du Short seulement » | `nmsvs sync fix <id> --start … --lock --shorts` (ou `sync apply <lot.json> --shorts`) : couche `reels.json → params.syncOverrides`, le clip n'est jamais modifié |
| « Propose un montage » | `nmsvs compose` (puis `preview contact`) |
| « Mets le refrain en parchemin » | éditer `timeline.json` → scène du refrain `"lyrics": { "style": "preset:lyrics-parchment-default" }` |
| « Deux illustrations sur le couplet 1, la 2ᵉ à partir de la ligne 3 » | `"illustrations": [{ "asset": "A", "until": { "line": "verse-1.l3", "edge": "start" } }, { "asset": "B" }]` (`until` = fin de l'illustration ; `distribution` passe alors en `explicit`) |
| « Transition en volet vers le refrain » | `"transitionIn": "preset:wipe-linear"` sur la scène du refrain |
| « Ajoute 3 s de couverture silencieuse avant la chanson » | `project.json` → `"preroll": { "sec": 3 }` (ne pas décaler les ancres de `timeline.json` : elles restent en temps chanson) |
| « Tourne les pages comme un livre » | `"transitionIn": "preset:page-turn"` (ou en ligne `{ "type": "page-turn", "duration": { "sec": 1.5 }, "direction": "left" }`) |
| « En vertical, cadre sur le personnage à droite » | `assets.json` → `focal: { x: 0.75, y: 0.45 }` ou `crops["9x16"]` |
| « Utilise une autre image en vertical » | `assets.json` → `replace: { "9x16": "img-…" }` |
| « Montre-moi » (sur demande uniquement) | `nmsvs preview contact -f 16x9` · `preview still 62.5 --safe` · `preview draft --from chorus-1 --to chorus-1` · `preview studio` |
| « Exporte pour YouTube » | `nmsvs export --profile youtube-4k-master` (4K direct, sans brouillon préalable ; export existant : demander avant `--replace`) |
| « Propose des extraits pour Reels » | `nmsvs reels analyze` → présenter les 5 fiches (paroles, pertinence musicale et narrative, scènes, montage vertical, style, limites) **sans recommander de prédiction d'audience** ; `--audio` seulement si l'écoute est nécessaire |
| « Termine le Short sur la couverture » | `reels.json → params.closing: { "scene": "sc-couverture", "transition": { "type": "page-turn", "duration": { "sec": 1.2 }, "direction": "right" }, "lyricsOutSec": 0.4, "holdSec": 0.8 }` (après la musique) |
| « Fais le ménage » | `nmsvs clean` (à blanc, présenter la liste) puis `nmsvs clean --apply` **sur accord** ; jamais d'autres suppressions sans autorisation distincte |
| « Essaie un Short sur le candidat 1 » (sans le choisir) | `nmsvs reels build --try cand-1` (n'écrit pas `reels.json` ; jamais présenté comme un choix de l'utilisateur) |
| « Je prends le 1 et le 3 » | `nmsvs reels select cand-1 cand-3` puis `nmsvs reels build` |
| « Où en est-on ? » / « Reprends » | `nmsvs status` · `nmsvs resume` |

Presets disponibles : `nmsvs presets [famille]` (motion, transition, lyrics, title, safe, export, reels-weights).

## 4. Repères

- Identifiants de lignes : `<section>.l<n>` (ex. `chorus-2.l1`), mots : `<ligne>.w<n>`.
- Ancres : `{ "at": 12.5 }`, `{ "section": "chorus-1", "edge": "start" }`, `{ "line": "verse-1.l3" }`, `{ "word": "…w2" }`, `{ "beat": 64 }`, `{ "bar": 16 }`, `{ "end": true }` ; options `offsetSec`, `snap: "beat"|"downbeat"`.
- Les scènes doivent se suivre sans trou : le `to` d'une scène = le `from` de la suivante.
- Les styles de paroles se résolvent dans l'ordre : ligne → scène (et surcharge de format) → section → `project.art.lyricStyle`. La police `art.fonts` du projet prime sur celle des presets.
- Documentation : `docs/GUIDE_UTILISATEUR.md`, `docs/GUIDE_DEVELOPPEUR.md`, `docs/04_MODELE_DONNEES_JSON.md`, `docs/12_REGLES_PRODUCTION.md` (règles V1.1) ; documents de cadrage `docs/01…11` (internes, non publiés).

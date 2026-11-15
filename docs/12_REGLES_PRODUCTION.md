# 12 — Règles de production NMSVS (V1.1)

Règles permanentes, en vigueur depuis le 14/11/2026 (campagne de clôture R2.1/R2.2). Elles s'appliquent à tout projet.
Les décisions artistiques restent celles de l'utilisateur.

## 0. Règle de sécurité absolue : préservation des sources

- Aucune procédure (nettoyage, maintenance, export, optimisation) ne supprime, n'écrase, ne déplace ni ne modifie un **fichier source original**.
- La règle vaut aussi pour les **copies importées** dans un projet (`media/`).
- Le nettoyage est réservé aux fichiers **temporaires et intermédiaires générés par NMSVS**, identifiés comme régénérables, et seulement quand aucun traitement actif ne les utilise.
- Un fichier inconnu, ou dont la propriété n'est pas établie, est **conservé**.
- **En cas de doute : ne rien supprimer.**
- Les exports MP4 validés, les configurations et les éléments de reproductibilité sont conservés.
- Toute suppression hors de ce périmètre exige une **autorisation explicite distincte** de l'utilisateur.

## 1. Production YouTube

| Exigence | Valeur | Contrôle moteur |
|---|---|---|
| Résolution finale | **3840 × 2160** | refus `E_PROFILE` si `formats.16x9` ≠ 3840×2160 pour un profil `youtube-*` |
| Ratio | 16:9 | idem (format `16x9` exigé) |
| Format | MP4 | idem (conteneur `mp4` exigé) |
| Encodage | profil maître validé `youtube-4k-master` (libx264 CRF 16 slow, AAC 320 k) | — |
| Rendu | direct en 4K (pas de mise à l'échelle) | refus si `scale` ≠ 1 |
| Audio | master original préservé (le WAV n'est jamais modifié ; le préambule est un silence inséré à l'encodage) | QC-T5 (sonie identique au master) |
| Contrôle qualité | obligatoire | intégré à chaque export (rejet `.REJECTED.mp4` si bloquant) |

- **Pas de brouillon avant l'export final.** On ne produit plus automatiquement de brouillon vidéo basse résolution avant l'export final. Les prévisualisations (`preview still|contact|draft|studio`) restent disponibles **sur demande**, ou si un contrôle technique ciblé les exige.
- **Vérifications conservées.** Les vérifications nécessaires au rendu restent en place : validation, compilation de la timeline, QC.

## 2. Shorts : analyse, propositions, production

### 2.1 Analyse préalable (avant toute proposition)

Points à analyser :
- la chanson et ses paroles ;
- la structure musicale ;
- les passages narratifs (dialogues, débuts et fins de phrase) ;
- les illustrations disponibles et leur aptitude au vertical ;
- la vidéo YouTube existante, lorsqu'elle est fournie : son **découpage, ses scènes et ses transitions** (timeline du clip), plutôt qu'un recadrage mécanique ;
- la pertinence d'un montage vertical.

### 2.2 Cinq propositions avant toute production

Commande : `nmsvs reels analyze`. Elle produit **uniquement** des propositions : `analysis/reels.candidates.json`, `reels.md` et `reels.proposals.json` dans le rapport d'exécution. Pour chaque candidat :

| Rubrique | Contenu |
|---|---|
| Début, fin, durée exacte | temps chanson |
| Paroles concernées | lignes de la fenêtre |
| Pertinence musicale | score, critères forts (accroche, énergie, montée, voix…) |
| Pertinence narrative | sections traversées, début et fin de phrase, dialogue |
| Scènes et illustrations | scènes du clip existant traversées, transitions |
| Montage vertical proposé | par illustration : remplacement, recadrage dédié, image entière sur fond flouté, ou point focal et part de largeur conservée |
| Style de paroles envisagé | issu de la timeline des Shorts, **à valider** |
| Limites | synchronisation à faible confiance, mots dégénérés, phrases coupées, recadrage fort |

- Les **extraits audio d'écoute** ne sont produits que si la sélection les exige : `reels analyze --audio`.
- **Interdiction de produire les Shorts finaux avant la sélection explicite de l'utilisateur.** Le moteur refuse `reels build` sans sélection (`E_REELS`). Un essai `reels build --try` est un essai technique, jamais un livrable ni un choix, et ne se lance que sur demande.
- Une fois les choix confirmés (`reels select`), **tous les Shorts retenus sont produits en une seule campagne** (`reels build`).

### 2.3 Composition d'un Short (acquis R2.1/R2.2)

- Timeline propre aux Shorts : `reels.json → params.timeline`, ou `--timeline`.
- Synchronisation propre aux Shorts : `params.syncOverrides`. Les paroles ne s'affichent jamais avant le chant (`leadSec: 0`).
- Paroles une phrase à la fois : `flow: "phrase"`.
- Ouverture sans texte sur la couverture : scène d'ouverture en `lyrics: none` ; un déroulé de parchemin court démarre après la page tournée.
- Fermeture **après** la musique (`params.closing`) :
  - paroles et conteneur masqués ;
  - transition (page tournée à rebours) vers le 1ᵉʳ plan de la scène indiquée ;
  - tenue courte, puis fin sur l'image, sans fondu au noir ;
  - l'audio s'arrête avec la musique ;
  - aucune image de la partie musicale n'est modifiée.

## 3. Direction artistique par projet

- **Pas de style unique** imposé à tous les projets.
- Une direction déjà validée pour un projet (ex. : illustrations en pages tournées et bandeau de paroles texturé) est conservée pour ses suites.
- Pour un nouveau projet, la direction artistique est à **proposer** : palette, typographie, transitions et style de paroles sont soumis à l'utilisateur avant toute production.
- La direction artistique définitive est **toujours validée par l'utilisateur** et consignée (`nmsvs decide`).

## 4. Exports et nettoyage

### 4.1 Exports

- **Plus d'archivage automatique.** Un export existant n'est jamais déplacé ni écrasé implicitement. Le moteur refuse (`E_EXPORT_EXISTS`) sauf autorisation explicite `--replace`, et l'ancien fichier est alors remplacé sans archive.
- **Nommage.** Pour une nouvelle version, préférer un **nom distinct** (`--label`), puis supprimer l'ancienne version seulement sur autorisation.
- **Contenu de `exports/`.** On n'y conserve que les MP4 retenus comme livrables. Le tri des exports existants (anciennes versions, essais, `exports/archive/`) se fait **uniquement sur autorisation distincte** : le moteur ne les supprime jamais.

### 4.2 Nettoyage sûr : `nmsvs clean`

- **À blanc par défaut.** Sans option, la commande liste seulement ; `--apply` supprime.
- **Liste blanche stricte**, rien d'autre :

| Supprimable | Motif |
|---|---|
| `build/<rendu>/segments/<clé>.mp4` (et `.tmp.mp4`) | segments de rendu, régénérables |
| `build/<rendu>/mezzanine-<clé>.mp4` | concaténation intermédiaire, régénérable |
| `exports/<nom>.tmp.mp4` | sortie partielle d'un encodage interrompu |

- **Jamais supprimés** : `media/` (sources et copies importées), JSON et configurations, `analysis/`, dérivés d'illustrations, exports et `exports/archive/`, rapports, décisions, scripts, fichiers inconnus. Les liens symboliques ne sont jamais suivis, et le chemin réel doit rester sous `build/` ou `exports/`.
- **Refus (rien n'est supprimé)** dans trois cas :
  - une commande est marquée en cours ;
  - un fichier a été modifié depuis moins de 2 minutes ;
  - un MP4 final d'`exports/` est illisible ou incomplet (vérification ffprobe préalable).
- **Traçabilité** : la liste complète est enregistrée dans `clean.json` du rapport d'exécution, et une décision `nmsvs clean --apply` est consignée.

## 5. Critères de validation artistique

Une recette n'est **terminée** qu'après validation explicite de l'utilisateur. Les contrôles techniques ne la remplacent jamais.

| Domaine | Critère, apprécié par l'utilisateur | Aide technique fournie |
|---|---|---|
| Synchronisation | le texte n'apparaît jamais avant le chant ; écarts perçus acceptables | tableaux de timings, témoins concordants ou non, points à écouter en priorité |
| Lisibilité | une phrase à la fois ; taille et contraste lisibles sur smartphone | QC-E2 (temps de lecture), QC-E4 (contraste) |
| Cadrage | visages et sujets non masqués ni coupés ; parchemin dans les zones sûres | QC-E1 (zones sûres), QC-E6 (sujet coupé), planches d'images |
| Récit | sens de l'histoire respecté ; début et fin cohérents | fiches de proposition (pertinence narrative) |
| Rythme | transitions aux instants musicaux voulus ; ouverture et fermeture fluides et courtes | instants des transitions documentés |
| Direction artistique | cohérente avec l'univers de l'album | décisions consignées |

# Démarrage rapide

Prérequis installés : voir [INSTALLATION_WINDOWS.md](INSTALLATION_WINDOWS.md). Dans les exemples, `nmsvs` désigne `.\nmsvs.cmd`.

## 1. Créer un projet et importer les médias

```powershell
.\nmsvs.cmd init mon-clip --title "Mon clip"
.\nmsvs.cmd -p mon-clip import audio "D:\Masters\mon-clip.wav"
.\nmsvs.cmd -p mon-clip import lyrics "D:\Textes\mon-clip.txt"
.\nmsvs.cmd -p mon-clip import images "D:\Illustrations\mon-clip"
```

- **Copies** : les médias sont copiés dans `projects/mon-clip/media/` ; les originaux ne sont jamais modifiés.
- **Format des paroles** : texte structuré par sections, par exemple `[Couplet 1]`, `[Refrain]`, `[Pont]`.

## 2. Analyser et synchroniser

```powershell
.\nmsvs.cmd -p mon-clip analyze
.\nmsvs.cmd -p mon-clip sync
```

1. Lire le `sync-report.md` du rapport d'exécution, en commençant par les lignes à faible confiance.
2. Corriger :

```powershell
.\nmsvs.cmd -p mon-clip sync shift chorus-1.l3 +0.2
.\nmsvs.cmd -p mon-clip sync fix verse-2.l1 --start 62.4 --lock
```

## 3. Monter

```powershell
.\nmsvs.cmd -p mon-clip compose          # propose une timeline.json
.\nmsvs.cmd -p mon-clip validate         # après toute modification d'un JSON
.\nmsvs.cmd -p mon-clip preview contact  # planche-contact (sur demande)
```

Éditer ensuite `timeline.json` : scènes, illustrations, transitions (`"transitionIn": "preset:page-turn"`) et styles de paroles. Les modèles de fichiers sont décrits dans [04_MODELE_DONNEES_JSON.md](04_MODELE_DONNEES_JSON.md).

## 4. Exporter pour YouTube (4K)

```powershell
.\nmsvs.cmd -p mon-clip export --profile youtube-4k-master
```

Le résultat est `projects/mon-clip/exports/mon-clip-16x9-youtube-4k-master.mp4` (3840 × 2160), accompagné d'un rapport QC.

## 5. Shorts

```powershell
.\nmsvs.cmd -p mon-clip reels analyze               # 5 propositions et fiches, rien n'est produit
.\nmsvs.cmd -p mon-clip reels select cand-1 cand-3  # votre choix
.\nmsvs.cmd -p mon-clip reels build                 # production des Shorts retenus
```

## 6. Nettoyer

```powershell
.\nmsvs.cmd -p mon-clip clean          # liste les intermédiaires supprimables
.\nmsvs.cmd -p mon-clip clean --apply  # après vérification
```

## Pour aller plus loin

- [GUIDE_UTILISATEUR.md](GUIDE_UTILISATEUR.md) : toutes les options.
- [12_REGLES_PRODUCTION.md](12_REGLES_PRODUCTION.md) : règles de production.
- [../AGENTS.md](../AGENTS.md) : pilotage en langage naturel.

# Contribuer à NMSVS

> NMSVS est distribué sous **Apache License 2.0** ([LICENSE](LICENSE)). Toute contribution proposée est réputée placée sous cette même licence (article 5). Pour une évolution importante, ouvrir d'abord une *issue*.

## Principes

- **Aucune création artistique dans le dépôt** : pas de musique, de paroles réelles, d'illustration, de vidéo ni de police artistique. Les tests utilisent des fixtures **synthétiques** générées par `tests/fixtures/make-fixture.ts` et des paroles inventées.
- **Aucun secret ni donnée personnelle** : clés, jetons, chemins personnels, adresses.
- **Préservation des sources** : aucune fonctionnalité ne doit modifier, déplacer ou supprimer un fichier source ou une copie importée. Les règles sont dans [docs/12_REGLES_PRODUCTION.md](docs/12_REGLES_PRODUCTION.md).
- **Conventions du code** : TypeScript strict, messages et documentation en français, erreurs typées (`NmsvsError` avec code, message et action), écriture atomique des fichiers, schémas JSON pour tout fichier de projet.

## Avant une demande de fusion

```powershell
npm run typecheck
npm test
npm run test:py
npm run test:integration   # si le rendu est concerné (~6 min)
```

**Images de référence** : si un changement modifie volontairement un rendu, régénérer les images de `tests/golden/` et expliquer pourquoi dans la demande.

## Structure

Voir [docs/GUIDE_DEVELOPPEUR.md](docs/GUIDE_DEVELOPPEUR.md).

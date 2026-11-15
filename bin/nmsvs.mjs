#!/usr/bin/env node
// Lanceur : enregistre tsx (TypeScript à la volée) relativement à ce dépôt, puis exécute la CLI.
// Fonctionne quel que soit le répertoire courant (y compris un dossier de projet).
import { register } from 'tsx/esm/api';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

register();
const here = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(here, '..', 'src', 'cli', 'main.ts')).href);

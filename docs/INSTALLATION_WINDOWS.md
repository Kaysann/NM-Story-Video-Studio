# Installation sous Windows

Testé sous Windows 11, avec PowerShell 5.1 et 7.

## 1. Prérequis

| Outil | Version | Vérification |
|---|---|---|
| Node.js | ≥ 20 (testé avec 24) | `node --version` |
| FFmpeg et FFprobe | ≥ 9, build *full* (libx264, libx265 ; AMF et libvmaf facultatifs) | `ffmpeg -version`, `ffprobe -version` |
| Python | **3.12** | `py -3.12 --version` |
| Git | récent | `git --version` |

**FFmpeg et FFprobe doivent être dans le `PATH`.** Si ce n'est pas le cas, définir `NMSVS_FFMPEG` et `NMSVS_FFPROBE` avec les chemins complets.

## 2. Dépendances Node

```powershell
npm ci
```

- `npm ci` installe les versions épinglées par `package-lock.json`, dont Remotion 4.0.543.
- npm 11 peut bloquer le script d'installation d'esbuild : c'est sans conséquence, le binaire est fourni par `@esbuild/win32-x64`.
- Chrome Headless Shell est téléchargé automatiquement par Remotion au premier rendu.

## 3. Environnement Python

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.8.0+cpu torchaudio==2.8.0+cpu torchvision==0.23.0+cpu
.\.venv\Scripts\python.exe -m pip install -r python\requirements.lock
```

Le worker Python est appelé par la CLI via `.venv\Scripts\python.exe`. Un autre interpréteur peut être choisi avec `NMSVS_PYTHON`.

## 4. Modèles IA

Aucun modèle n'est inclus dans le dépôt :
- les modèles de transcription et d'alignement (faster-whisper, wav2vec2 français) se téléchargent au premier `nmsvs sync`, dans `.nmsvs/models` ;
- `HF_HOME` et `TORCH_HOME` y sont redirigés.

**Le premier `sync` demande donc une connexion réseau.** Les suivants fonctionnent hors ligne.

## 5. Vérification

```powershell
.\nmsvs.cmd doctor
npm run typecheck
npm test
npm run test:py
```

`doctor` contrôle Node, FFmpeg et ses encodeurs, Python, les paquets et les modèles présents.

## 6. Variables d'environnement facultatives

| Variable | Rôle | Défaut |
|---|---|---|
| `NMSVS_PROJECTS` | dossier des projets | `projects/` |
| `NMSVS_HOME` | cache global (modèles, bundles) | `.nmsvs/` |
| `NMSVS_PROJECT` | projet par défaut | — |
| `NMSVS_FFMPEG`, `NMSVS_FFPROBE` | chemins de FFmpeg et FFprobe | `ffmpeg`, `ffprobe` |
| `NMSVS_PYTHON` | interpréteur Python | `.venv\Scripts\python.exe` |

## 7. Confidentialité

Les dossiers suivants restent locaux : `.gitignore` les exclut, et ils ne doivent jamais être publiés.
- `projects/` : vos créations ;
- `.nmsvs/` : modèles et caches ;
- `.venv/` et `node_modules/`.

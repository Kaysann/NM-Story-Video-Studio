"""Vérification de l'environnement Python (versions, modèles présents)."""
from __future__ import annotations

import importlib.metadata as md
import os
import platform


def _ver(pkg: str) -> str | None:
    try:
        return md.version(pkg)
    except md.PackageNotFoundError:
        return None


def run(inputs: dict, params: dict, work_dir: str) -> dict:
    models_dir = params.get("modelsDir", "")
    pkgs = ["torch", "torchaudio", "whisperx", "faster-whisper", "ctranslate2", "librosa", "stable-ts", "numpy", "pillow", "transformers"]
    versions = {p: _ver(p) for p in pkgs}
    present = {}
    if models_dir and os.path.isdir(models_dir):
        for root, dirs, _files in os.walk(models_dir):
            for d in dirs:
                if d.startswith("models--"):
                    present[d.replace("models--", "").replace("--", "/")] = True
    return {
        "outputs": {"python": platform.python_version(), "packages": versions, "modelsPresent": sorted(present)},
        "toolVersions": {k: v for k, v in versions.items() if v},
    }

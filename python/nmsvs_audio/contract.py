"""Contrat requête/réponse et progression (JSONL sur stderr)."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from typing import Any


class WorkerError(Exception):
    """Erreur métier : code stable + message français."""

    def __init__(self, code: str, message: str, detail: Any = None, exit_code: int = 4):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail
        self.exit_code = exit_code


def progress(step: str, ratio: float, msg: str = "") -> None:
    sys.stderr.write(json.dumps({"type": "progress", "step": step, "ratio": round(ratio, 3), "msg": msg}) + "\n")
    sys.stderr.flush()


def log(msg: str, level: str = "info") -> None:
    sys.stderr.write(json.dumps({"type": "log", "level": level, "msg": msg}, ensure_ascii=False) + "\n")
    sys.stderr.flush()


def write_json_atomic(path: str, data: Any) -> None:
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def read_request(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            req = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise WorkerError("E_ARGS", f"Requête illisible : {e}", exit_code=2) from e
    for k in ("schemaVersion", "command", "inputs", "params", "workDir"):
        if k not in req:
            raise WorkerError("E_ARGS", f"Requête invalide : champ « {k} » manquant", exit_code=2)
    if req["schemaVersion"] != 1:
        raise WorkerError("E_ARGS", "Version de contrat non prise en charge", exit_code=2)
    return req

"""Point d'entrée : python -m nmsvs_audio <commande> --request req.json --response res.json"""
from __future__ import annotations

import argparse
import sys
import traceback

from .contract import WorkerError, read_request, write_json_atomic


def _dispatch(command: str, req: dict) -> dict:
    # Imports paresseux : `env-check` et `image-stats` ne chargent pas torch.
    if command == "env-check":
        from .env_check import run
    elif command == "analyze":
        from .analyze import run
    elif command == "align":
        from .align import run
    elif command == "transcribe":
        from .align import run_transcribe as run
    elif command == "image-stats":
        from .image_stats import run
    else:
        raise WorkerError("E_ARGS", f"Commande inconnue : {command}", exit_code=2)
    return run(req["inputs"], req["params"], req["workDir"])


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="nmsvs_audio")
    p.add_argument("command")
    p.add_argument("--request", required=True)
    p.add_argument("--response", required=True)
    a = p.parse_args(argv)
    try:
        req = read_request(a.request)
        if req["command"] != a.command:
            raise WorkerError("E_ARGS", "Commande incohérente entre argument et requête", exit_code=2)
        out = _dispatch(a.command, req)
        write_json_atomic(a.response, {"schemaVersion": 1, "status": "ok", **out})
        return 0
    except WorkerError as e:
        write_json_atomic(a.response, {"schemaVersion": 1, "status": "error", "error": {"code": e.code, "message": e.message, "detail": e.detail}})
        return e.exit_code
    except KeyboardInterrupt:
        return 130
    except Exception as e:  # noqa: BLE001 — toute erreur inattendue est rapportée proprement
        write_json_atomic(a.response, {"schemaVersion": 1, "status": "error", "error": {"code": "E_PY_FAILED", "message": str(e), "detail": traceback.format_exc()}})
        return 4


if __name__ == "__main__":
    sys.exit(main())

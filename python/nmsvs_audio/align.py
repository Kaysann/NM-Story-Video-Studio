"""Alignement forcé de paroles connues sur l'audio.

Chaîne : (audio pré-traité 16 kHz mono) → transcription grossière faster-whisper
→ appariement texte (Needleman-Wunsch) → fenêtres par ligne → alignement fin
(WhisperX + wav2vec2 FR Apache-2.0, ou stable-ts) → post-traitement.

Les lignes verrouillées (anchors) ne sont jamais recalculées : elles bornent les fenêtres.
"""
from __future__ import annotations

import os
import time

import numpy as np
import soundfile as sf

from .contract import WorkerError, log, progress
from .textnorm import align_sequences, line_tokens, similarity

SR = 16000


def _load_audio(path: str) -> np.ndarray:
    try:
        y, sr = sf.read(path, dtype="float32", always_2d=False)
    except Exception as e:  # noqa: BLE001
        raise WorkerError("E_ASSET_MISSING", f"Audio illisible : {e}") from e
    if y.ndim > 1:
        y = y.mean(axis=1)
    if sr != SR:
        raise WorkerError("E_ARGS", f"Audio attendu à 16 kHz (reçu {sr})")
    return y


def _models_env(models_dir: str) -> None:
    os.environ.setdefault("HF_HOME", os.path.join(models_dir, "hf"))
    os.environ.setdefault("TORCH_HOME", os.path.join(models_dir, "torch"))
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


# ─────────────────────────── transcription grossière ───────────────────────────

def transcribe(audio_path: str, params: dict) -> list[dict]:
    from faster_whisper import WhisperModel

    models_dir = params["modelsDir"]
    _models_env(models_dir)
    t0 = time.time()
    model = WhisperModel(params.get("asrModel", "large-v3"), device="cpu", compute_type="int8",
                         download_root=os.path.join(models_dir, "faster-whisper"), cpu_threads=int(params.get("threads", 6)))
    log(f"modèle ASR chargé en {time.time() - t0:.1f} s")
    # Audio passé déjà décodé (WAV 16 kHz lu par soundfile) : évite le décodeur PyAV,
    # dont les versions récentes sont incompatibles avec faster-whisper 1.2.1 (paramètre metadata_errors retiré).
    segments, info = model.transcribe(
        _load_audio(audio_path), language=params.get("language", "fr"), word_timestamps=True, vad_filter=False,
        condition_on_previous_text=False, beam_size=5, no_speech_threshold=0.9,
    )
    words = []
    dur = max(1e-6, info.duration)
    for seg in segments:
        progress("transcribe", min(0.99, seg.end / dur))
        for w in seg.words or []:
            for part in _norm_words(w.word):
                words.append({"w": part, "s": float(w.start), "e": float(w.end), "p": float(w.probability)})
    return words


def _norm_words(text: str) -> list[str]:
    _, norm = line_tokens(text)
    return [w for _, w in norm]


def run_transcribe(inputs: dict, params: dict, work_dir: str) -> dict:
    t0 = time.time()
    words = transcribe(inputs["audio"], params)
    return {"outputs": {"words": words}, "metrics": {"transcribeSec": round(time.time() - t0, 2)}}


# ─────────────────────────── placement grossier ───────────────────────────

def coarse_windows(lines: list[dict], words: list[dict], duration: float, anchors: list[dict]) -> tuple[dict, list[dict]]:
    """Fenêtres [début, fin] par ligne cible à partir de la transcription ; écarts texte/chant."""
    ref, owner = [], []
    for li, ln in enumerate(lines):
        for _, w in ln["norm"]:
            ref.append(w)
            owner.append(li)
    match = align_sequences(ref, [w["w"] for w in words])
    spans: dict[int, list[float]] = {}
    for k, j in enumerate(match):
        if j is None:
            continue
        li = owner[k]
        s, e = words[j]["s"], words[j]["e"]
        if li in spans:
            spans[li][0] = min(spans[li][0], s)
            spans[li][1] = max(spans[li][1], e)
        else:
            spans[li] = [s, e]
    # Écarts texte/transcription (lignes très différentes de ce qui est entendu)
    diffs = []
    for li, ln in enumerate(lines):
        if li in spans:
            heard = " ".join(w["w"] for w in words if spans[li][0] - 0.05 <= w["s"] <= spans[li][1] + 0.05)
            expected = " ".join(w for _, w in ln["norm"])
            if similarity(expected, heard) < 0.6:
                diffs.append({"lineId": ln["id"], "expected": expected, "heard": heard})
        else:
            diffs.append({"lineId": ln["id"], "expected": " ".join(w for _, w in ln["norm"]), "heard": ""})
    # Interpolation des lignes sans correspondance, au prorata du nombre de caractères
    windows: dict[str, list[float]] = {}
    known = sorted(spans)
    for li, ln in enumerate(lines):
        if li in spans:
            windows[ln["id"]] = spans[li][:]
            continue
        prev = max([k for k in known if k < li], default=None)
        nxt = min([k for k in known if k > li], default=None)
        a = spans[prev][1] if prev is not None else 0.0
        b = spans[nxt][0] if nxt is not None else duration
        group = [k for k in range((prev if prev is not None else -1) + 1, nxt if nxt is not None else len(lines))]
        chars = [max(1, len(lines[k]["text"])) for k in group]
        pos = a + (b - a) * sum(chars[: group.index(li)]) / sum(chars)
        windows[ln["id"]] = [pos, pos + (b - a) * chars[group.index(li)] / sum(chars)]
    # Monotonie + marge ±1 s, bornée par les ancres verrouillées
    anchor_times = sorted((a["start"], a["end"]) for a in anchors)
    for ln in lines:
        s, e = windows[ln["id"]]
        lo = max([ae for (as_, ae) in anchor_times if ae <= s + 0.5], default=0.0)
        hi = min([as_ for (as_, ae) in anchor_times if as_ >= e - 0.5], default=duration)
        windows[ln["id"]] = [max(lo, s - 1.0), min(hi, e + 1.0)]
    return windows, diffs


# ─────────────────────────── alignement fin ───────────────────────────

def _fine_whisperx(lines: list[dict], windows: dict, audio_path: str, params: dict) -> dict:
    import whisperx

    _models_env(params["modelsDir"])
    t0 = time.time()
    model_a, meta = whisperx.load_align_model(language_code=params.get("language", "fr"), device="cpu",
                                              model_name=params.get("alignModel"), model_dir=os.path.join(params["modelsDir"], "align"))
    log(f"modèle d'alignement chargé en {time.time() - t0:.1f} s")
    audio = whisperx.load_audio(audio_path)
    out = {}
    for k, ln in enumerate(lines):
        progress("align", k / max(1, len(lines)))
        s, e = windows[ln["id"]]
        text = " ".join(w for _, w in ln["norm"])
        if not text or e - s < 0.2:
            out[ln["id"]] = [None] * len(ln["norm"])
            continue
        try:
            res = whisperx.align([{"text": text, "start": s, "end": e}], model_a, meta, audio, "cpu", return_char_alignments=False)
            ws = [w for seg in res.get("segments", []) for w in seg.get("words", [])]
        except Exception as ex:  # noqa: BLE001 — une ligne en échec n'arrête pas les autres
            log(f"alignement en échec pour {ln['id']} : {ex}", "warn")
            ws = []
        vals = []
        for i in range(len(ln["norm"])):
            w = ws[i] if i < len(ws) else None
            if w and "start" in w and "end" in w:
                vals.append((float(w["start"]), float(w["end"]), float(w.get("score", 0.5))))
            else:
                vals.append(None)
        out[ln["id"]] = vals
    return out


def _fine_stable_ts(lines: list[dict], windows: dict, audio_path: str, params: dict) -> dict:
    import stable_whisper

    _models_env(params["modelsDir"])
    model = stable_whisper.load_faster_whisper(params.get("asrModel", "large-v3"), device="cpu", compute_type="int8",
                                               download_root=os.path.join(params["modelsDir"], "faster-whisper"))
    out = {}
    audio = _load_audio(audio_path)
    for k, ln in enumerate(lines):
        progress("align", k / max(1, len(lines)))
        s, e = windows[ln["id"]]
        text = " ".join(w for _, w in ln["norm"])
        a, b = int(s * SR), int(e * SR)
        vals: list = [None] * len(ln["norm"])
        if text and b - a > SR // 5:
            try:
                res = model.align(audio[a:b], text, language=params.get("language", "fr"), verbose=None)
                ws = [w for seg in res.segments for w in seg.words]
                for i in range(min(len(ws), len(vals))):
                    vals[i] = (s + float(ws[i].start), s + float(ws[i].end), float(getattr(ws[i], "probability", 0.5) or 0.5))
            except Exception as ex:  # noqa: BLE001
                log(f"stable-ts en échec pour {ln['id']} : {ex}", "warn")
        out[ln["id"]] = vals
    return out


# ─────────────────────────── post-traitement ───────────────────────────

def _energy(audio: np.ndarray, hop: float = 0.02) -> np.ndarray:
    n = int(hop * SR)
    frames = len(audio) // n
    if frames == 0:
        return np.zeros(1)
    return np.sqrt((audio[: frames * n].reshape(frames, n) ** 2).mean(axis=1))


def build_lines(lines: list[dict], fine: dict, windows: dict, audio: np.ndarray, anchors: list[dict]) -> list[dict]:
    energy = _energy(audio)
    voiced = []
    result = []
    for ln in lines:
        vals = fine.get(ln["id"], [])
        tokens: list[str] = ln["tokens"]
        tok_times: list[list] = [[] for _ in tokens]
        for (ti, _w), v in zip(ln["norm"], vals):
            if v:
                tok_times[ti].append(v)
        words = []
        for ti, tok in enumerate(tokens):
            tv = tok_times[ti]
            if tv:
                words.append({"id": f"{ln['id']}.w{ti + 1}", "text": tok, "start": min(t[0] for t in tv), "end": max(t[1] for t in tv),
                              "confidence": float(np.mean([t[2] for t in tv])), "source": "auto"})
                voiced.append((words[-1]["start"], words[-1]["end"]))
            else:
                words.append({"id": f"{ln['id']}.w{ti + 1}", "text": tok, "start": None, "end": None, "confidence": 0.0, "source": "interpolated"})
        _interpolate(words, windows[ln["id"]])
        conf = float(np.mean([w["confidence"] for w in words])) if words else 0.0
        result.append({"id": ln["id"], "start": words[0]["start"], "end": words[-1]["end"], "confidence": round(conf, 3),
                       "source": "auto" if conf > 0 else "interpolated", "words": words})
    # Seuil d'activité vocale : fraction de l'énergie médiane dans les zones chantées détectées
    vals = [energy[int(s / 0.02):max(int(s / 0.02) + 1, int(e / 0.02))].mean() for s, e in voiced if int(s / 0.02) < len(energy)]
    thr = 0.3 * float(np.median(vals)) if vals else 0.0
    # Premier mot anormalement long (l'aligneur l'étire sur un silence, souvent après une erreur de transcription) :
    # recalage sur la dernière montée d'énergie vocale soutenue avant sa fin ; à défaut, durée plafonnée.
    for r in result:
        w0 = r["words"][0]
        if w0["end"] - w0["start"] <= 0.8 or w0["source"] != "auto":
            continue
        others = [w["end"] - w["start"] for w in r["words"][1:]] or [0.3]
        cap = max(0.6, 3 * float(np.median(others)))
        onset = _last_onset(energy, w0["start"], w0["end"], thr)
        w0["start"] = onset if onset is not None else max(w0["start"], w0["end"] - cap)
        w0["confidence"] = min(w0["confidence"], 0.5)  # signalé « à vérifier » dans le rapport
        r["start"] = w0["start"]
        r["confidence"] = round(float(np.mean([w["confidence"] for w in r["words"]])), 3)
    bounds = sorted([(a["start"], a["end"]) for a in anchors] + [(r["start"], r["end"]) for r in result])
    result.sort(key=lambda r: r["start"])
    for i, r in enumerate(result):
        nxt = min([s for (s, _e) in bounds if s > r["start"] + 0.01], default=len(audio) / SR)
        # Extension de fin : tant que la voix tient (voyelles tenues), plafonnée à 1,5 s et au début suivant
        end = r["end"]
        limit = min(nxt - 0.05, end + 1.5)
        k = int(end / 0.02)
        while thr > 0 and end < limit and k < len(energy) and energy[k] > thr:
            end += 0.02
            k += 1
        r["end"] = round(max(r["end"], min(end, limit)), 3)
        r["words"][-1]["end"] = r["end"]
        if i + 1 < len(result) and r["end"] > result[i + 1]["start"]:
            r["end"] = r["words"][-1]["end"] = result[i + 1]["start"]
        r["start"] = round(r["start"], 3)
        for w in r["words"]:
            w["start"], w["end"] = round(w["start"], 3), round(max(w["end"], w["start"] + 0.02), 3)
    return result


def _last_onset(energy: np.ndarray, start: float, end: float, thr: float, hop: float = 0.02, hold: int = 3) -> float | None:
    """Dernier passage sous→au-dessus du seuil suivi d'au moins `hold` trames au-dessus, dans [start, end - 0,1 s]."""
    if thr <= 0:
        return None
    a, b = int(start / hop), min(len(energy) - hold, int((end - 0.1) / hop))
    best = None
    for k in range(max(a, 1), b):
        if energy[k - 1] < thr <= energy[k] and all(energy[k + j] >= thr for j in range(hold)):
            best = k * hop
    return best


def _interpolate(words: list[dict], window: list[float]) -> None:
    """Mots sans horodatage : répartition linéaire entre voisins datés (ou bornes de fenêtre)."""
    n = len(words)
    i = 0
    while i < n:
        if words[i]["start"] is not None:
            i += 1
            continue
        j = i
        while j < n and words[j]["start"] is None:
            j += 1
        a = words[i - 1]["end"] if i > 0 else window[0]
        b = words[j]["start"] if j < n else window[1]
        if b <= a:
            b = a + 0.1 * (j - i)
        step = (b - a) / (j - i)
        for k in range(i, j):
            words[k]["start"] = a + step * (k - i)
            words[k]["end"] = a + step * (k - i + 1)
        i = j


# ─────────────────────────── commande ───────────────────────────

def run(inputs: dict, params: dict, work_dir: str) -> dict:
    t_all = time.time()
    audio_path = inputs["audio"]
    audio = _load_audio(audio_path)
    duration = len(audio) / SR
    anchors = inputs.get("anchors", [])
    lines = []
    for ln in inputs["lines"]:
        tokens, norm = line_tokens(ln["text"])
        if not tokens:
            continue
        lines.append({"id": ln["id"], "text": ln["text"], "tokens": tokens, "norm": norm, "window": ln.get("window")})
    if not lines:
        return {"outputs": {"lines": [], "textDiff": []}, "metrics": {}}
    metrics: dict = {}
    diffs: list = []
    if all(ln["window"] for ln in lines):
        windows = {ln["id"]: ln["window"] for ln in lines}
    else:
        t0 = time.time()
        words = inputs.get("transcript") or transcribe(audio_path, params)
        metrics["transcribeSec"] = round(time.time() - t0, 2)
        windows, diffs = coarse_windows(lines, words, duration, anchors)
        for ln in lines:
            if ln["window"]:
                windows[ln["id"]] = ln["window"]
    t0 = time.time()
    engine = params.get("engine", "whisperx")
    if engine == "whisperx":
        fine = _fine_whisperx(lines, windows, audio_path, params)
    elif engine == "stable-ts":
        fine = _fine_stable_ts(lines, windows, audio_path, params)
    else:
        raise WorkerError("E_ARGS", f"Moteur d'alignement inconnu : {engine}", exit_code=2)
    metrics["alignSec"] = round(time.time() - t0, 2)
    result = build_lines(lines, fine, windows, audio, anchors)
    metrics["totalSec"] = round(time.time() - t_all, 2)
    progress("align", 1.0)
    import importlib.metadata as md
    tv = {}
    for p in ("whisperx", "faster-whisper", "stable-ts", "torch"):
        try:
            tv[p] = md.version(p)
        except md.PackageNotFoundError:
            pass
    return {"outputs": {"lines": result, "textDiff": diffs, "windows": windows}, "metrics": metrics, "toolVersions": tv}

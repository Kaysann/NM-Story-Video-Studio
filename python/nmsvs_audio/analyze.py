"""Analyse musicale (librosa) : tempo, battements, temps forts, énergie, structure, chroma.

Entrée : WAV stéréo préparé par la CLI (build/analysis/master.wav).
Les séries temporelles sont échantillonnées à pas fixe pour rester compactes en JSON.
"""
from __future__ import annotations

import librosa
import numpy as np
import soundfile as sf

from .contract import WorkerError, progress

SR = 22050
HOP = 512


def _resample_series(values: np.ndarray, src_hop: float, dst_hop: float, duration: float, agg=np.mean) -> list[float]:
    n = int(np.ceil(duration / dst_hop))
    out = []
    for i in range(n):
        a = int(i * dst_hop / src_hop)
        b = max(a + 1, int((i + 1) * dst_hop / src_hop))
        seg = values[a:b]
        out.append(float(agg(seg)) if len(seg) else 0.0)
    return out


def _norm(x: list[float]) -> list[float]:
    m = max(x) if x else 0
    return [round(v / m, 4) if m > 0 else 0.0 for v in x]


def _downbeats(beats_t: np.ndarray, y: np.ndarray) -> tuple[list[float], int, float]:
    """Choisit mesure (3 ou 4 temps) et phase maximisant l'énergie grave sur les temps forts supposés."""
    if len(beats_t) < 8:
        return [float(b) for b in beats_t[::4]], 4, 0.0
    S = np.abs(librosa.stft(y, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=SR)
    low = S[freqs < 200].sum(axis=0)
    onset_low = np.maximum(0, np.diff(low, prepend=low[0]))
    frames = librosa.time_to_frames(beats_t, sr=SR, hop_length=HOP)
    frames = np.clip(frames, 0, len(onset_low) - 1)
    strength = onset_low[frames]
    best = (-1.0, 4, 0)
    for meter in (4, 3):
        for phase in range(meter):
            s = float(strength[phase::meter].mean())
            # léger biais vers 4/4, de loin le plus fréquent
            score = s * (1.05 if meter == 4 else 1.0)
            if score > best[0]:
                best = (score, meter, phase)
    _, meter, phase = best
    conf = float(best[0] / (strength.mean() + 1e-9))
    return [float(b) for b in beats_t[phase::meter]], meter, conf


def _segments(y: np.ndarray, beats_f: np.ndarray, duration: float) -> list[dict]:
    """Segmentation agglomérative sur caractéristiques synchronisées aux battements, puis étiquetage par similarité."""
    if len(beats_f) < 16:
        return [{"start": 0.0, "end": round(duration, 3), "label": "A"}]
    chroma = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=HOP)
    mfcc = librosa.feature.mfcc(y=y, sr=SR, hop_length=HOP, n_mfcc=13)
    feats = np.vstack([librosa.util.normalize(chroma, axis=0), librosa.util.normalize(mfcc, axis=1)])
    sync = librosa.util.sync(feats, beats_f, aggregate=np.median)
    k = int(np.clip(round(duration / 20), 3, 14))
    k = min(k, sync.shape[1] - 1)
    bounds = librosa.segment.agglomerative(sync, k)
    bound_frames = librosa.util.fix_frames(beats_f[np.clip(bounds, 0, len(beats_f) - 1)], x_min=0)
    bound_times = librosa.frames_to_time(bound_frames, sr=SR, hop_length=HOP)
    times = sorted(set([0.0] + [float(t) for t in bound_times if 0 < t < duration] + [duration]))
    segs, means = [], []
    for a, b in zip(times[:-1], times[1:]):
        if b - a < 2.0 and segs:  # fusion des micro-segments
            segs[-1]["end"] = b
            continue
        fa, fb = librosa.time_to_frames([a, b], sr=SR, hop_length=HOP)
        m = feats[:, fa:max(fa + 1, fb)].mean(axis=1)
        segs.append({"start": a, "end": b})
        means.append(m / (np.linalg.norm(m) + 1e-9))
    labels: list[str] = []
    protos: list[np.ndarray] = []
    for m in means:
        sims = [float(m @ p) for p in protos]
        if sims and max(sims) > 0.97:
            labels.append(chr(65 + int(np.argmax(sims))))
        else:
            protos.append(m)
            labels.append(chr(65 + min(len(protos) - 1, 25)))
    for s, lab in zip(segs, labels):
        s["label"] = lab
        s["start"] = round(s["start"], 3)
        s["end"] = round(s["end"], 3)
    return segs


def run(inputs: dict, params: dict, work_dir: str) -> dict:
    path = inputs["audio"]
    try:
        info = sf.info(path)
        stereo, sr0 = sf.read(path, always_2d=True, dtype="float32")
    except Exception as e:  # noqa: BLE001
        raise WorkerError("E_ASSET_MISSING", f"Audio illisible : {e}") from e
    duration = float(info.frames / info.samplerate)
    progress("analyze", 0.05, "chargement")
    mono = stereo.mean(axis=1)
    y = librosa.resample(mono, orig_sr=sr0, target_sr=SR) if sr0 != SR else mono

    progress("analyze", 0.15, "tempo et battements")
    onset_env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    tempo, beats_f = librosa.beat.beat_track(onset_envelope=onset_env, sr=SR, hop_length=HOP)
    tempo = float(np.atleast_1d(tempo)[0])
    beats_t = librosa.frames_to_time(beats_f, sr=SR, hop_length=HOP)
    beat_strength = onset_env[np.clip(beats_f, 0, len(onset_env) - 1)] if len(beats_f) else np.array([0.0])
    tempo_conf = float(np.clip(beat_strength.mean() / (onset_env.mean() + 1e-9) / 3.0, 0, 1))
    downbeats, meter, _db_conf = _downbeats(beats_t, y)

    progress("analyze", 0.35, "onsets et énergie")
    onsets = librosa.onset.onset_detect(onset_envelope=onset_env, sr=SR, hop_length=HOP, units="time")
    frame_hop = HOP / SR
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    rms_s = _resample_series(rms, frame_hop, 0.05, duration)
    novelty = _resample_series(onset_env, frame_hop, 0.5, duration)

    # Bande vocale : énergie 300–3400 Hz du canal central moins celle du canal latéral (voix généralement centrée).
    progress("analyze", 0.5, "bande vocale")
    if stereo.shape[1] >= 2:
        mid = (stereo[:, 0] + stereo[:, 1]) / 2
        side = (stereo[:, 0] - stereo[:, 1]) / 2
    else:
        mid, side = stereo[:, 0], np.zeros_like(stereo[:, 0])
    mid = librosa.resample(mid, orig_sr=sr0, target_sr=SR) if sr0 != SR else mid
    side = librosa.resample(side, orig_sr=sr0, target_sr=SR) if sr0 != SR else side
    freqs = librosa.fft_frequencies(sr=SR)
    band = (freqs > 300) & (freqs < 3400)
    em = (np.abs(librosa.stft(mid, hop_length=HOP))[band] ** 2).sum(axis=0)
    es = (np.abs(librosa.stft(side, hop_length=HOP))[band] ** 2).sum(axis=0)
    vocal = np.sqrt(np.maximum(0, em - es))
    vocal_s = _norm(_resample_series(vocal, frame_hop, 0.1, duration))

    progress("analyze", 0.65, "chroma")
    chroma = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=HOP)
    n = int(np.ceil(duration / 0.5))
    chroma_s = []
    for i in range(n):
        a, b = int(i * 0.5 / frame_hop), int((i + 1) * 0.5 / frame_hop)
        c = chroma[:, a:max(a + 1, b)].mean(axis=1) if a < chroma.shape[1] else np.zeros(12)
        chroma_s.append([round(float(v), 3) for v in c])

    progress("analyze", 0.8, "structure")
    segments = _segments(y, beats_f, duration)
    progress("analyze", 1.0, "terminé")
    return {
        "outputs": {
            "analysis": {
                "version": 1,
                "durationSec": round(duration, 4),
                "sampleRate": int(info.samplerate),
                "channels": int(info.channels),
                "tempo": {"bpm": round(tempo, 2), "confidence": round(tempo_conf, 3)},
                "beats": [round(float(b), 4) for b in beats_t],
                "downbeats": [round(b, 4) for b in downbeats],
                "meter": meter,
                "onsets": [round(float(o), 4) for o in onsets],
                "rms": {"hopSec": 0.05, "values": [round(v, 5) for v in rms_s]},
                "novelty": {"hopSec": 0.5, "values": _norm(novelty)},
                "vocalBand": {"hopSec": 0.1, "values": vocal_s},
                "chroma": {"hopSec": 0.5, "values": chroma_s},
                "segments": segments,
            }
        },
        "toolVersions": {"librosa": librosa.__version__, "numpy": np.__version__},
    }

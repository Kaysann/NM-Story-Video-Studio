import json
import os
import subprocess
import sys

import numpy as np
import soundfile as sf

from nmsvs_audio.align import _interpolate, build_lines, coarse_windows
from nmsvs_audio.textnorm import align_sequences, line_tokens, normalize_token, number_to_words

PY_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def test_numbers_in_french():
    assert number_to_words(21) == "vingt et un"
    assert number_to_words(71) == "soixante et onze"
    assert number_to_words(80) == "quatre-vingts"
    assert number_to_words(97) == "quatre-vingt-dix-sept"
    assert number_to_words(200) == "deux cents"
    assert number_to_words(1987) == "mille neuf cent quatre-vingt-sept"


def test_normalize_token_keeps_mapping():
    assert normalize_token("L’amour,") == ["l'amour"]
    assert normalize_token("peut-être") == ["peut", "être"]
    assert normalize_token("«") == []
    tokens, norm = line_tokens("Les 3 phares, d’or !")
    assert tokens == ["Les", "3", "phares,", "d’or", "!"]
    assert norm == [(0, "les"), (1, "trois"), (2, "phares"), (3, "d'or")]


def test_align_sequences_tolerates_errors():
    ref = "sous le phare des vallées anciennes".split()
    hyp = "euh sous le phares des vallee ancienne oh".split()
    m = align_sequences(ref, hyp)
    assert m == [1, 2, 3, 4, 5, 6]


def _line(i, text):
    tokens, norm = line_tokens(text)
    return {"id": f"verse-1.l{i}", "text": text, "tokens": tokens, "norm": norm, "window": None}


def test_coarse_windows_interpolates_missing_lines():
    lines = [_line(1, "un deux trois"), _line(2, "quatre cinq"), _line(3, "six sept huit")]
    words = [{"w": w, "s": s, "e": s + 0.4} for w, s in [("un", 1.0), ("deux", 1.5), ("trois", 2.0), ("six", 8.0), ("sept", 8.5), ("huit", 9.0)]]
    win, diffs = coarse_windows(lines, words, 12.0, [])
    assert win["verse-1.l1"][0] == 0.0 and abs(win["verse-1.l1"][1] - 3.4) < 1e-6
    # ligne 2 non entendue : placée entre la fin de l1 et le début de l3
    # (intervalle [2,4 ; 8,0] élargi de la marge de ±1 s)
    assert abs(win["verse-1.l2"][0] - 1.4) < 1e-6 and abs(win["verse-1.l2"][1] - 9.0) < 1e-6
    assert any(d["lineId"] == "verse-1.l2" for d in diffs)


def test_coarse_windows_respects_locked_anchor():
    lines = [_line(1, "un deux trois")]
    words = [{"w": "un", "s": 5.0, "e": 5.3}, {"w": "deux", "s": 5.4, "e": 5.7}, {"w": "trois", "s": 5.8, "e": 6.2}]
    win, _ = coarse_windows(lines, words, 12.0, [{"id": "x.l1", "start": 2.0, "end": 4.6}])
    assert win["verse-1.l1"][0] >= 4.6


def test_interpolate_fills_gaps():
    words = [{"start": 1.0, "end": 1.2}, {"start": None, "end": None}, {"start": None, "end": None}, {"start": 2.0, "end": 2.3}]
    _interpolate(words, [0.5, 3.0])
    assert abs(words[1]["start"] - 1.2) < 1e-9 and abs(words[2]["end"] - 2.0) < 1e-9


def test_build_lines_extends_sustained_vowel():
    sr = 16000
    audio = np.zeros(sr * 6, dtype=np.float32)
    audio[sr * 1: int(sr * 3.5)] = 0.3 * np.sin(np.linspace(0, 2000, int(sr * 2.5)))  # voix tenue jusqu'à 3,5 s
    ln = _line(1, "la la")
    fine = {"verse-1.l1": [(1.0, 1.5, 0.9), (1.6, 2.0, 0.8)]}
    res = build_lines([ln], fine, {"verse-1.l1": [0.5, 3.0]}, audio, [])
    assert res[0]["start"] == 1.0
    assert 3.3 <= res[0]["end"] <= 3.6  # prolongée sur la note tenue
    assert res[0]["words"][1]["id"] == "verse-1.l1.w2"


def test_build_lines_fixes_stretched_first_word():
    sr = 16000
    audio = np.zeros(sr * 6, dtype=np.float32)
    audio[int(sr * 3.0): int(sr * 4.5)] = 0.3 * np.sin(np.linspace(0, 5000, int(sr * 1.5)))  # voix réelle dès 3,0 s
    ln = _line(1, "et les tambours")
    # « et » étiré par l'aligneur depuis 1,2 s (silence) jusqu'à 3,2 s
    fine = {"verse-1.l1": [(1.2, 3.2, 0.9), (3.25, 3.5, 0.9), (3.55, 4.2, 0.9)]}
    res = build_lines([ln], fine, {"verse-1.l1": [1.0, 5.0]}, audio, [])
    assert abs(res[0]["start"] - 3.0) < 0.06
    assert res[0]["words"][0]["confidence"] <= 0.5


def test_contract_cli_env_check_and_errors(tmp_path):
    req = tmp_path / "req.json"
    res = tmp_path / "res.json"
    req.write_text(json.dumps({"schemaVersion": 1, "command": "env-check", "inputs": {}, "params": {}, "workDir": str(tmp_path)}), encoding="utf-8")
    r = subprocess.run([sys.executable, "-m", "nmsvs_audio", "env-check", "--request", str(req), "--response", str(res)], cwd=PY_DIR)
    assert r.returncode == 0
    out = json.loads(res.read_text(encoding="utf-8"))
    assert out["status"] == "ok" and out["outputs"]["packages"]["librosa"]
    req.write_text(json.dumps({"schemaVersion": 1, "command": "nope", "inputs": {}, "params": {}, "workDir": "."}), encoding="utf-8")
    r = subprocess.run([sys.executable, "-m", "nmsvs_audio", "nope", "--request", str(req), "--response", str(res)], cwd=PY_DIR)
    assert r.returncode == 2
    assert json.loads(res.read_text(encoding="utf-8"))["error"]["code"] == "E_ARGS"


def test_analyze_on_click_track(tmp_path):
    from nmsvs_audio.analyze import run
    sr = 44100
    dur = 20
    y = np.zeros((sr * dur, 2), dtype=np.float32)
    for i, t in enumerate(np.arange(0, dur, 0.5)):  # 120 BPM, accent tous les 4 temps
        a = int(t * sr)
        amp = 0.9 if i % 4 == 0 else 0.4
        n = int(0.05 * sr)
        y[a:a + n, :] += (amp * np.sin(2 * np.pi * (60 if i % 4 == 0 else 1000) * np.arange(n) / sr))[:, None]
    p = tmp_path / "click.wav"
    sf.write(p, y, sr)
    out = run({"audio": str(p)}, {}, str(tmp_path))["outputs"]["analysis"]
    assert abs(out["tempo"]["bpm"] - 120) < 3 or abs(out["tempo"]["bpm"] - 60) < 2
    assert len(out["beats"]) > 20
    assert abs(out["durationSec"] - dur) < 0.01
    assert out["segments"][0]["start"] == 0.0 and abs(out["segments"][-1]["end"] - dur) < 0.01

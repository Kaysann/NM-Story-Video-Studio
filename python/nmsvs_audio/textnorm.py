"""Normalisation du texte pour l'alignement (français), avec correspondance vers les mots d'origine."""
from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

_UNITS = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze",
          "treize", "quatorze", "quinze", "seize"]
_TENS = {2: "vingt", 3: "trente", 4: "quarante", 5: "cinquante", 6: "soixante"}


def _below_100(n: int) -> str:
    if n <= 16:
        return _UNITS[n]
    if n < 20:
        return "dix-" + _UNITS[n - 10]
    t, u = divmod(n, 10)
    if t in (7, 9):  # soixante-dix…, quatre-vingt-dix…
        base = "soixante" if t == 7 else "quatre-vingt"
        rest = n - (60 if t == 7 else 80)
        sep = " et " if (t == 7 and rest == 11) else "-"
        return base + sep + _below_100(rest)
    if t == 8:
        return "quatre-vingts" if u == 0 else "quatre-vingt-" + _UNITS[u]
    if u == 0:
        return _TENS[t]
    if u == 1:
        return _TENS[t] + " et un"
    return _TENS[t] + "-" + _UNITS[u]


def number_to_words(n: int) -> str:
    """Nombres entiers 0–9999 en toutes lettres (suffisant pour des paroles)."""
    if n < 100:
        return _below_100(n)
    if n < 1000:
        h, r = divmod(n, 100)
        head = "cent" if h == 1 else _UNITS[h] + " cent" + ("s" if r == 0 else "")
        return head + ("" if r == 0 else " " + _below_100(r))
    if n < 10000:
        th, r = divmod(n, 1000)
        head = "mille" if th == 1 else _below_100(th) + " mille"
        return head + ("" if r == 0 else " " + number_to_words(r))
    return str(n)


_APOS = str.maketrans({"’": "'", "‘": "'", "`": "'", "ʼ": "'"})
_PUNCT = re.compile(r"[.,;:!?«»\"“”()\[\]…—–/*~_]+")


def normalize_token(tok: str) -> list[str]:
    """Un mot d'origine → zéro, un ou plusieurs mots normalisés (minuscules, sans ponctuation)."""
    t = unicodedata.normalize("NFC", tok).translate(_APOS).lower()
    t = _PUNCT.sub(" ", t)
    t = t.replace("-", " ").replace("œ", "oe").replace("æ", "ae")
    out: list[str] = []
    for part in t.split():
        if part.isdigit():
            out.extend(number_to_words(int(part)).replace("-", " ").split())
        elif part.strip("'"):
            out.append(part.strip("'") if part.count("'") == len(part) else part)
    return out


def line_tokens(text: str) -> tuple[list[str], list[tuple[int, str]]]:
    """Retourne (mots d'origine, [(index du mot d'origine, mot normalisé)])."""
    tokens = text.split()
    norm: list[tuple[int, str]] = []
    for i, tok in enumerate(tokens):
        for w in normalize_token(tok):
            norm.append((i, w))
    return tokens, norm


def similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def align_sequences(ref: list[str], hyp: list[str], gap: float = -0.4, threshold: float = 0.55) -> list[int | None]:
    """Needleman-Wunsch : pour chaque mot de `ref`, l'index du mot apparié dans `hyp` (ou None)."""
    n, m = len(ref), len(hyp)
    score = [[0.0] * (m + 1) for _ in range(n + 1)]
    back = [[0] * (m + 1) for _ in range(n + 1)]  # 0 diag, 1 haut, 2 gauche
    for i in range(1, n + 1):
        score[i][0] = i * gap
        back[i][0] = 1
    for j in range(1, m + 1):
        score[0][j] = j * gap
        back[0][j] = 2
    sim_cache: dict[tuple[str, str], float] = {}
    for i in range(1, n + 1):
        a = ref[i - 1]
        row, prev = score[i], score[i - 1]
        for j in range(1, m + 1):
            b = hyp[j - 1]
            key = (a, b)
            s = sim_cache.get(key)
            if s is None:
                s = similarity(a, b)
                sim_cache[key] = s
            d = prev[j - 1] + (2 * s - 1 if s >= threshold else -1.0)
            u = prev[j] + gap
            left = row[j - 1] + gap
            if d >= u and d >= left:
                row[j], back[i][j] = d, 0
            elif u >= left:
                row[j], back[i][j] = u, 1
            else:
                row[j], back[i][j] = left, 2
    res: list[int | None] = [None] * n
    i, j = n, m
    while i > 0 and j > 0:
        bk = back[i][j]
        if bk == 0:
            if similarity(ref[i - 1], hyp[j - 1]) >= threshold:
                res[i - 1] = j - 1
            i, j = i - 1, j - 1
        elif bk == 1:
            i -= 1
        else:
            j -= 1
    return res

"""Statistiques colorimétriques des illustrations et conversion sRGB (profils ICC)."""
from __future__ import annotations

import io
import os

import numpy as np
from PIL import Image, ImageCms

from .contract import WorkerError


def _to_srgb(img: Image.Image) -> tuple[Image.Image, str | None]:
    icc = img.info.get("icc_profile")
    desc = None
    if icc:
        try:
            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            desc = ImageCms.getProfileDescription(src).strip()
            if "srgb" not in desc.lower():
                img = ImageCms.profileToProfile(img.convert("RGB"), src, ImageCms.createProfile("sRGB"), outputMode="RGB")
        except Exception:  # noqa: BLE001 — profil corrompu : on garde les valeurs brutes
            desc = "illisible"
    return img.convert("RGB"), desc


def _srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    c = rgb / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = lin @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


def stats_for(path: str, convert_dir: str | None) -> dict:
    if not os.path.isfile(path):
        raise WorkerError("E_ASSET_MISSING", f"Image introuvable : {path}")
    with Image.open(path) as im:
        im.load()
        srgb, icc = _to_srgb(im)
    converted = None
    if icc and "srgb" not in icc.lower() and icc != "illisible" and convert_dir:
        os.makedirs(convert_dir, exist_ok=True)
        converted = os.path.join(convert_dir, os.path.splitext(os.path.basename(path))[0] + ".srgb.png")
        srgb.save(converted, "PNG")
    small = srgb.copy()
    small.thumbnail((512, 512))
    arr = np.asarray(small, dtype=np.float64)
    lab = _srgb_to_lab(arr).reshape(-1, 3)
    L = lab[:, 0]
    hsv = np.asarray(small.convert("HSV"), dtype=np.float64).reshape(-1, 3)
    return {
        "lumaMean": float(L.mean()),
        "lumaMedian": float(np.median(L)),
        "lumaP1": float(np.percentile(L, 1)),
        "lumaP99": float(np.percentile(L, 99)),
        "aMean": float(lab[:, 1].mean()),
        "bMean": float(lab[:, 2].mean()),
        "satMean": float(hsv[:, 1].mean() / 255.0),
        "icc": icc,
        "srgbPath": converted,
    }


def run(inputs: dict, params: dict, work_dir: str) -> dict:
    out = {}
    for item in inputs["images"]:
        out[item["id"]] = stats_for(item["path"], params.get("convertDir"))
    return {"outputs": {"images": out}}

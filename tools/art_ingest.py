#!/usr/bin/env python3
"""Slice AI-generated bulk art sheets into pack-ready WebP files and wire them into a pack.

    python3 tools/art_ingest.py <image> --sheet <sheet_id> --pack <packDir>
        [--csv SHEETS.csv] [--grid 3x3] [--ids a,b,c] [--kind icon|portrait|boss|location|ui]
        [--cutout] [--dry-run] [--contact out.png] [--json] [--tol 40] [--max-frames 24]

docs/ART_PIPELINE.md has the chat workflow. In short:

  1. The sheet row comes from SHEETS.csv (columns used: sheet_id, type, grid, cell_aspect, bg, contents,
     output, prompt; contents = ordered ids separated by `|` or `;`). --grid / --ids / --kind override.
     Grids are COLSxROWS; when the transpose fits the image and the cell aspect clearly better it is used
     (and reported). `GIF 8f` grids are animations.
  2. Grid detection: deskew (up to 3 degrees), then each of the N-1 column / M-1 row cuts snaps to the
     strongest gutter near its expected spot. A gutter is a line that is either background-coloured
     (projection of "differs from the sheet border colour") or uniform along its length (line standard
     deviation), so dark padding, white lines, coloured gutters and the empty space between sparse
     subjects all count. No gutter → a visible seam (abutting full-bleed cells) → even division. Cuts are
     searched relative to the previous cut, so uneven cells are fine.
  3. Per cell: uniform edge strips that end in a colour step are trimmed (gutter lines, letterbox bars),
     a quadratic background model is fitted to the cell border (gradients, flat chroma keys), and the
     subject bbox found. Crop modes: `subject` (tight square/aspect box with padding: icons, conditions),
     `fill` (largest box of the target aspect in the cell: portraits, splashes, and chroma-key sheets so
     every cell keeps the same framing), `trim` (subject + air, size as found).
  4. Output: <pack>/images/[subdir/]<id>.webp (WebP q85). Size, subfolder and alpha come from the CSV
     `output` column (e.g. "images/ui/<id>.webp 512x512 alpha"), else from the type / --kind profile.
     Bosses also get `<id>_sq.webp` (full-height square at 10-66 % of the width). Alpha is a flood fill of
     the background from the cell border that stops at the black ink (chroma green/blue keyed with
     despill; the dark-gradient version is kept as `<id>_bg.webp` when the source was not a chroma key).
  5. Animations (GIF / animated WebP, or a still "frame grid" fallback for an animation row): frames are
     cropped with one union box (or aligned on the subject centre for frame grids), duplicates dropped,
     capped, keyed, then written as `anim/<id>.webp` (animated, loop or once), `anim/<id>_0.webp` (still),
     `anim/<id>_strip.webp` (horizontal sprite strip for the TV) + `anim/<id>.json` (frames, fps, w, h,
     loop). Budget: squeezed toward 400 KB, warning above 1.5 MB.
  6. Wiring: items / monsters / npcs / locations / bosses `image` (bosses also `imageSquare`; boss_state
     `<boss>_p<N>` → `phases[N-1].image`, `<boss>_ko` → `imageKo`), icons.json ids by file convention,
     everything else (mascot, loot crates, dice, conditions, medals, sponsors, finale spots, floor
     backgrounds, rarity ornaments, fx, stingers, ...) into ui.json slots by id. Edits keep the JSON file's
     formatting. Unknown ids: the file is written and reported.
  7. A contact sheet PNG (detected grid + crop boxes over the source, then every slice with its id and
     status) is always written; --dry-run writes nothing else.

Requires Pillow + numpy (pip install --break-system-packages pillow numpy).
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageSequence

QUALITY = 85
ANIM_TARGET = 400_000  # ANIMATION.md budget: squeeze toward this
ANIM_BUDGET = 1_500_000  # warn above this
ANIM_EDGE = 512
MASCOT_EDGE = 384
BOSS_SQ_LEFT = 0.10  # boss square spans 10 % .. 66 % of the 16:9 width (ART_BIBLE_v2 "1:1 crop rule")
EMPTY_TOKENS = {"", "-", "_", "empty", "blank", "skip", "none"}


# ---------------------------------------------------------------- profiles

@dataclass(frozen=True)
class Profile:
    kind: str  # icon | portrait | boss | location | ui | anim (reported)
    mode: str  # subject | fill | trim
    size: tuple | None  # target (w, h); None = as found (capped)
    fill: float = 0.80  # subject mode: subject's longer side / frame side
    alpha: bool = False
    subdir: str = ""
    sq: int | None = None  # boss square side
    anchor: str = "center"  # fill mode: "subject-x" centres horizontally on the subject
    anim: bool = False


KIND_PROFILES = {
    "icon": Profile("icon", "subject", (512, 512)),
    "portrait": Profile("portrait", "fill", (600, 800), anchor="subject-x"),
    "boss": Profile("boss", "fill", (1600, 900), sq=864),
    "location": Profile("location", "fill", (1920, 1080)),
    "ui": Profile("ui", "trim", None, alpha=True, subdir="ui"),
    "anim": Profile("anim", "subject", (ANIM_EDGE, ANIM_EDGE), fill=1 / 1.12, alpha=True, subdir="anim", anim=True),
}

# SHEETS.csv `type` → base profile (the `output` column then sets size / subfolder / alpha).
TYPE_PROFILES = {
    "icon": KIND_PROFILES["icon"],
    "condition": Profile("icon", "subject", (256, 256), subdir="ui"),
    "boss": KIND_PROFILES["boss"],
    "boss_state": Profile("portrait", "fill", (768, 768), anchor="subject-x"),
    "monster": Profile("portrait", "fill", (768, 1024), anchor="subject-x"),
    "npc": Profile("portrait", "fill", (768, 1024), anchor="subject-x"),
    "monster_family": Profile("portrait", "fill", (512, 683), anchor="subject-x"),
    "avatar": Profile("portrait", "fill", (512, 683), anchor="subject-x", subdir="ui"),
    "location": KIND_PROFILES["location"],
    "background": KIND_PROFILES["location"],
    "stinger": Profile("location", "fill", (1920, 1080), subdir="ui"),
    # Chroma-key cut-outs: the whole cell (same framing in every cell of a set), keyed to alpha.
    **{t: Profile("ui", "fill", (512, 512), alpha=True, subdir="ui") for t in ("loot_box", "mascot", "spot", "logo", "dice", "medal", "sponsor")},
    "vfx_decal": Profile("ui", "fill", (512, 512), alpha=True, subdir="fx"),
    "ui_ornament": Profile("ui", "fill", (256, 256), alpha=True, subdir="ui"),
    "ui": KIND_PROFILES["ui"],
    "animation": KIND_PROFILES["anim"],
}
ASPECT_KIND = {"1:1": "icon", "3:4": "portrait", "2:3": "portrait", "16:9": "location", "3:2": "location"}

# The style anchors the art director asks Claude to keep (SHEETS.md "Anchor files").
ANCHORS = {"ICO-01": ("style_anchor_icons.png", None), "BOSS-01": ("style_anchor_boss.png", None),
           "LOOT-01": ("style_anchor_cutout.png", None), "MON-01": ("style_anchor_portrait.png", None),
           "LOC-01": ("style_anchor_location.png", None), "SYS-01": ("mascot_model.png", 0)}


# ---------------------------------------------------------------- small helpers

def parse_grid(s: str | None):
    if not s:
        return None
    m = re.match(r"^\s*(\d+)\s*[x×X*]\s*(\d+)\s*$", str(s))
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


def parse_aspect(s: str | None):
    if not s:
        return None
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)", str(s))
    if not m:
        return None
    return float(m.group(1)) / float(m.group(2))


def split_ids(s: str | None):
    if s is None:
        return []
    return [t.strip() for t in re.split(r"[|;,\n]", s)]


def read_sheet_row(csv_path: Path, sheet_id: str):
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            row = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
            if row.get("sheet_id") == sheet_id:
                return row
    return None


def key_color(bg: str | None):
    """'chroma green #00FF00' → (0, 255, 0); anything else → None."""
    m = re.search(r"chroma[^#]*#([0-9a-fA-F]{6})", bg or "")
    if not m:
        return None
    h = m.group(1)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def anim_spec(row: dict):
    """Frames / length / loop / fallback frame grid from an animation row (grid 'GIF 8f' + prompt)."""
    prompt = row.get("prompt", "")
    m = re.search(r"GIF\s*(\d+)\s*f", row.get("grid", ""), re.I)
    frames = int(m.group(1)) if m else None
    m = re.search(r"total about\s*([\d.]+)\s*s", prompt)
    total = float(m.group(1)) if m else None
    once = bool(re.search(r"plays once", prompt, re.I))
    g = re.search(r"in a (\d+) columns? x (\d+) rows? grid", prompt) or re.search(r"in a (\d+)\s*x\s*(\d+) grid", prompt)
    fgrid = (int(g.group(1)), int(g.group(2))) if g else None
    return {"frames": frames, "total": total, "loop": not once, "frame_grid": fgrid}


def profile_for_row(row: dict | None, base: Profile, id_: str) -> Profile:
    """Apply the CSV `output` column (size, subfolder, alpha, square) to a base profile."""
    if not row:
        return base
    out = row.get("output", "")
    p = base
    m = re.search(r"images/(?:([A-Za-z0-9_]+)/)?[^\s/]+\.webp(?:\s+(\d+)x(\d+))?", out)
    if m:
        p = replace(p, subdir=m.group(1) or "")
        if m.group(2):
            p = replace(p, size=(int(m.group(2)), int(m.group(3))))
    sq = re.search(r"_sq\.webp\s+(\d+)x\d+", out)
    if sq:
        p = replace(p, sq=int(sq.group(1)))
    if re.search(r"\balpha\b", out) or key_color(row.get("bg")):
        p = replace(p, alpha=True)
    if p.anim and id_.startswith("system_"):
        p = replace(p, size=(MASCOT_EDGE, MASCOT_EDGE))
    return p


def to_array(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert("RGB"), dtype=np.float32)


def border_ring(a: np.ndarray, frac=0.04):
    h, w = a.shape[:2]
    t = max(1, int(round(min(h, w) * frac)))
    return np.concatenate([a[:t].reshape(-1, 3), a[-t:].reshape(-1, 3), a[:, :t].reshape(-1, 3), a[:, -t:].reshape(-1, 3)])


def color_dist(a: np.ndarray, c) -> np.ndarray:
    return np.sqrt(((a - np.asarray(c, dtype=np.float32)) ** 2).sum(axis=-1))


def smooth(p: np.ndarray, k: int) -> np.ndarray:
    k = max(1, int(k) | 1)
    if k <= 1 or len(p) < k:
        return p
    ker = np.ones(k, dtype=np.float32) / k
    return np.convolve(np.pad(p, k // 2, mode="edge"), ker, mode="valid")


# ---------------------------------------------------------------- background model

def fit_background(a: np.ndarray, ring=0.08):
    """Quadratic surface per channel fitted to the border ring: handles radial / linear gradients."""
    h, w = a.shape[:2]
    t = max(2, int(round(min(h, w) * ring)))
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    xn, yn = xx / max(1, w - 1) - 0.5, yy / max(1, h - 1) - 0.5
    m = np.zeros((h, w), bool)
    m[:t], m[-t:], m[:, :t], m[:, -t:] = True, True, True, True
    step = max(1, int(m.sum() // 6000))
    xs, ys = xn[m][::step], yn[m][::step]
    A = np.stack([np.ones_like(xs), xs, ys, xs * xs, ys * ys, xs * ys], axis=1)
    pix = a[m][::step]
    # Robust: refit once without the worst 20 % (subject touching the edge).
    coef, *_ = np.linalg.lstsq(A, pix, rcond=None)
    res = np.abs(A @ coef - pix).sum(axis=1)
    keep = res <= np.quantile(res, 0.8) if len(res) > 20 else np.ones_like(res, bool)
    coef, *_ = np.linalg.lstsq(A[keep], pix[keep], rcond=None)
    full = np.stack([np.ones_like(xn), xn, yn, xn * xn, yn * yn, xn * yn], axis=-1)
    model = full @ coef
    edge = np.median(pix[keep], axis=0)
    return model.astype(np.float32), edge


def subject_mask(a: np.ndarray, tol: float):
    model, edge = fit_background(a)
    d = np.sqrt(((a - model) ** 2).sum(axis=-1))
    m = Image.fromarray(((d > tol) * 255).astype(np.uint8), "L")
    # Opening drops speckle / JPEG noise, closing keeps thin ink lines attached.
    m = m.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    return np.asarray(m) > 0, d, model, edge


def subject_bbox(a: np.ndarray, tol: float, min_frac=0.003):
    """Bbox (x0, y0, x1, y1) of the subject in a cell, or None when nothing stands out."""
    mask, _, _, edge = subject_mask(a, tol)
    h, w = mask.shape
    cols = mask.sum(axis=0)
    rows = mask.sum(axis=1)
    cthr = max(1, h * min_frac)
    rthr = max(1, w * min_frac)
    cx = np.nonzero(cols >= cthr)[0]
    ry = np.nonzero(rows >= rthr)[0]
    if not len(cx) or not len(ry):
        return None, edge
    box = (int(cx[0]), int(ry[0]), int(cx[-1]) + 1, int(ry[-1]) + 1)
    if (box[2] - box[0]) * (box[3] - box[1]) < 0.002 * w * h:
        return None, edge
    return box, edge


# ---------------------------------------------------------------- grid detection

@dataclass
class Grid:
    cols: int
    rows: int
    xs: list  # cell spans [(x0, x1)] in the (deskewed) sheet
    ys: list
    angle: float = 0.0
    how_x: list = field(default_factory=list)
    how_y: list = field(default_factory=list)
    transposed: bool = False
    bg: tuple = (0, 0, 0)

    def cells(self):
        return [(x0, y0, x1, y1) for (y0, y1) in self.ys for (x0, x1) in self.xs]


def activity(a: np.ndarray, tol: float):
    """Per-pixel 'is content' mask against the sheet background (border median)."""
    bg = np.median(border_ring(a, 0.01), axis=0)
    return (color_dist(a, bg) > tol).astype(np.float32), bg


def line_std(a: np.ndarray, axis: int) -> np.ndarray:
    """How much each column (axis=0) / row (axis=1) varies along its length (mean over channels).
    Gutter lines of any colour, and the padding between subjects, score low."""
    return a.std(axis=axis).mean(axis=-1)


def gutter_profile(a: np.ndarray, act: np.ndarray, axis: int) -> np.ndarray:
    """0 = surely a gutter, ~1 = typical content. min(activity, uniformity), both normalised."""
    n = a.shape[1 - axis]
    pa = smooth(act.mean(axis=axis), max(1, n // 300))
    pu = smooth(line_std(a, axis), max(1, n // 300))
    na = pa / max(1e-3, float(np.median(pa)))
    nu = pu / max(1e-3, float(np.median(pu)))
    return np.minimum(na, nu)


def estimate_angle(gray: Image.Image, max_deg=3.0, step=0.25):
    """Angle that makes gutters sharpest: the lowest-varying lines get lowest when aligned."""
    w, h = gray.size
    s = min(1.0, 500 / max(w, h))
    small = gray.resize((max(16, int(w * s)), max(16, int(h * s))), Image.BILINEAR) if s < 1 else gray
    fill = int(np.median(np.asarray(small)))
    sw, sh = small.size
    sin = math.sin(math.radians(max_deg))
    cy, cx = int(sw * sin) + 2, int(sh * sin) + 2  # rotated-in corners reach this far in

    def score(ang):
        """Sum over both axes of (2nd-percentile line std / median line std): lower = sharper gutters."""
        r = np.asarray(small.rotate(float(ang), resample=Image.BILINEAR, fillcolor=fill), dtype=np.float32)
        r = r[cy:sh - cy, cx:sw - cx]
        if r.shape[0] < 8 or r.shape[1] < 8:
            return 2.0
        tot = 0.0
        for ax in (0, 1):
            u = r.std(axis=ax)
            tot += float(np.percentile(u, 2)) / (float(np.median(u)) or 1.0)
        return tot

    zero = score(0.0)
    best, best_s = 0.0, zero
    for ang in np.arange(-max_deg, max_deg + 1e-6, step):
        if abs(ang) < 1e-9:
            continue
        sc = score(ang)
        if sc < best_s:
            best, best_s = float(ang), sc
    # Only rotate for a clear win (a straight sheet must stay untouched).
    if best == 0.0 or not (best_s < zero * 0.6 and zero - best_s > 0.02):
        return 0.0
    for ang in np.arange(best - step, best + step + 1e-6, step / 4):
        sc = score(ang)
        if sc < best_s:
            best, best_s = float(ang), sc
    return round(best, 3)


def find_cuts(p: np.ndarray, seam: np.ndarray, n: int, lo: int, hi: int):
    """Split [lo, hi) into n cells. Each of the n-1 cuts snaps to the lowest gutter-profile point near
    its expected spot (searched relative to the previous cut, so uneven cells are fine), else to a
    visible seam, else even. Returns cut positions (including lo, hi), how each was found, gutter widths."""
    cuts, how, bands = [lo], [], []
    seam_med = float(np.median(seam[lo:hi])) if hi > lo else 0.0
    for k in range(1, n):
        start = cuts[-1]
        cw = (hi - start) / (n - k + 1)
        exp = start + cw
        r = max(2, int(cw * 0.3))
        a, b = int(max(start + 1, exp - r)), int(min(hi - 1, exp + r))
        win = p[a:b]
        cut, kind = int(round(exp)), "even"
        if len(win):
            i = int(np.argmin(win))
            m = float(win[i])
            if m < 0.45:
                lim = m + max(0.05, 0.25 * (1 - m))
                l = r_ = a + i
                while l > a and p[l - 1] <= lim:
                    l -= 1
                while r_ < b - 1 and p[r_ + 1] <= lim:
                    r_ += 1
                cut, kind = (l + r_ + 1) // 2, "gutter"
                bands.append(r_ + 1 - l)
            else:
                sw = seam[a:b]
                j = int(np.argmax(sw))
                if float(sw[j]) > max(8.0, 3.0 * seam_med):
                    cut, kind = a + j + 1, "seam"
        cuts.append(cut)
        how.append(kind)
    cuts.append(hi)
    return cuts, how, bands


def detect_grid(img: Image.Image, cols: int, rows: int, tol: float = 40.0, deskew=True) -> tuple[Grid, Image.Image]:
    a = to_array(img)
    act, bg = activity(a, tol)
    angle = estimate_angle(img.convert("L")) if deskew and (cols > 1 or rows > 1) else 0.0
    if angle:
        img = img.rotate(angle, resample=Image.BICUBIC, fillcolor=tuple(int(round(c)) for c in bg))
        a = to_array(img)
        act, bg = activity(a, tol)
    h, w = act.shape
    gx = gutter_profile(a, act, 0)
    gy = gutter_profile(a, act, 1)
    # Seams (abutting full-bleed cells): mean jump between neighbouring columns / rows.
    sx = np.append(np.abs(np.diff(a, axis=1)).mean(axis=(0, 2)), 0)
    sy = np.append(np.abs(np.diff(a, axis=0)).mean(axis=(1, 2)), 0)

    def outer(p, n_cells, size):
        """Outer margin: a uniform run at the sheet edge (kept short of a third of a cell)."""
        lim = size / n_cells / 3
        lo = 0
        while lo < lim and p[lo] < 0.12:
            lo += 1
        hi = size
        while size - hi < lim and p[hi - 1] < 0.12:
            hi -= 1
        return (lo if lo < lim else 0), (hi if size - hi < lim else size)

    x0, x1 = outer(gx, cols, w)
    y0, y1 = outer(gy, rows, h)
    xc, hx, _ = find_cuts(gx, sx, cols, x0, x1)
    yc, hy, _ = find_cuts(gy, sy, rows, y0, y1)
    # Margins only steer where the cuts are expected; outer cells still run to the sheet edge (a
    # dark margin and a cell's own dark padding look the same; per-cell trimming handles real bars).
    xc[0], xc[-1], yc[0], yc[-1] = 0, w, 0, h
    xs = list(zip(xc[:-1], xc[1:]))
    ys = list(zip(yc[:-1], yc[1:]))
    return Grid(cols, rows, xs, ys, angle, hx, hy, bg=tuple(int(c) for c in bg)), img


def grid_strength(img: Image.Image, cols: int, rows: int, tol: float) -> float:
    g, _ = detect_grid(img, cols, rows, tol, deskew=False)
    hows = g.how_x + g.how_y
    return sum(1 for x in hows if x != "even") / max(1, len(hows))


def choose_orientation(img: Image.Image, grid, cell_aspect, n_ids, tol):
    """COLSxROWS as declared, or transposed when that clearly fits the sheet better."""
    c, r = grid
    if c == r:
        return grid, False
    w, h = img.size
    if cell_aspect:
        fit = lambda cc, rr: abs(math.log((w / cc) / (h / rr) / cell_aspect))
        a, b = fit(c, r), fit(r, c)
        if b + 0.15 < a:
            return (r, c), True
        if a + 0.15 < b:
            return grid, False
    sa, sb = grid_strength(img, c, r, tol), grid_strength(img, r, c, tol)
    if sb > sa + 0.2:
        return (r, c), True
    return grid, False


# ---------------------------------------------------------------- per-cell crop
def trim_uniform_edges(a: np.ndarray, std_thr=8.0, max_frac=0.2):
    """Strip near-uniform rows / columns from the cell edges when their colour is foreign to the cell
    (gutter lines, borders, letterbox bars). A uniform run in the cell's own background colour (a dark
    gradient fading to the edge, flat chroma padding) is the padding the crop needs and stays."""
    h, w = a.shape[:2]
    m = min(h, w)
    t0, t1 = max(1, int(m * 0.08)), max(2, int(m * 0.14))
    inset = np.concatenate([a[t0:t1, t0:w - t0].reshape(-1, 3), a[h - t1:h - t0, t0:w - t0].reshape(-1, 3),
                            a[t0:h - t0, t0:t1].reshape(-1, 3), a[t0:h - t0, w - t1:w - t0].reshape(-1, 3)])
    own = np.median(inset, axis=0) if len(inset) else np.zeros(3)
    rs = a.std(axis=1).max(axis=-1)
    cs = a.std(axis=0).max(axis=-1)
    rm = a.mean(axis=1)
    cm = a.mean(axis=0)

    def run(stds, means, n, lim, rev):
        j = 0
        idx = (lambda i: n - 1 - i) if rev else (lambda i: i)
        while j < lim and stds[idx(j)] < std_thr and float(np.sqrt(((means[idx(j)] - own) ** 2).sum())) > 40:
            j += 1
        return j

    top = run(rs, rm, h, int(h * max_frac), False)
    bot = h - run(rs, rm, h, int(h * max_frac), True)
    left = run(cs, cm, w, int(w * max_frac), False)
    right = w - run(cs, cm, w, int(w * max_frac), True)
    return left, top, right, bot


def fit_box(cx, cy, bw, bh, W, H):
    """Place a bw x bh box centred on (cx, cy), shifted to stay inside W x H (if it fits)."""
    x0 = min(max(0, cx - bw / 2), max(0, W - bw))
    y0 = min(max(0, cy - bh / 2), max(0, H - bh))
    return int(round(x0)), int(round(y0)), int(round(x0 + bw)), int(round(y0 + bh))


def crop_with_fill(img: Image.Image, box, fill):
    """Crop that may extend past the image; outside pixels get `fill`."""
    x0, y0, x1, y1 = box
    W, H = img.size
    if x0 >= 0 and y0 >= 0 and x1 <= W and y1 <= H:
        return img.crop(box)
    mode = img.mode
    canvas = Image.new(mode, (x1 - x0, y1 - y0), tuple(fill) + (0,) if mode == "RGBA" else tuple(fill))
    canvas.paste(img, (-x0, -y0))
    return canvas


def plan_crop(cell: Image.Image, prof, tol: float, subject=None):
    """Crop box (cell coordinates; may exceed the cell for subject crops, padded with background)."""
    a = to_array(cell)
    W, H = cell.size
    box, edge = subject if subject is not None else subject_bbox(a, tol)
    info = {"subject": box}
    if prof.mode == "fill":
        ar = prof.size[0] / prof.size[1]
        bw, bh = (W, W / ar) if W / H <= ar else (H * ar, H)
        cx = (box[0] + box[2]) / 2 if (prof.anchor == "subject-x" and box) else W / 2
        return fit_box(cx, H / 2, bw, bh, W, H), edge, info
    if box is None:
        box = (int(W * 0.05), int(H * 0.05), int(W * 0.95), int(H * 0.95))
        info["warn"] = "no subject found, using the whole cell"
    bx0, by0, bx1, by1 = box
    bw, bh = bx1 - bx0, by1 - by0
    cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
    if prof.mode == "subject":
        ar = prof.size[0] / prof.size[1] if prof.size else 1.0
        need_w = max(bw, bh * ar) / prof.fill
        need_h = need_w / ar
        if need_w <= W and need_h <= H:
            return fit_box(cx, cy, need_w, need_h, W, H), edge, info
        # Not enough room for the full padding: use what the cell has (subject still whole).
        s = min(W / need_w, H / need_h)
        if need_w * s >= bw * 1.02 and need_h * s >= bh * 1.02:
            return fit_box(cx, cy, need_w * s, need_h * s, W, H), edge, info
        return (int(round(cx - need_w / 2)), int(round(cy - need_h / 2)), int(round(cx + need_w / 2)), int(round(cy + need_h / 2))), edge, info
    pad = max(4, int(0.06 * max(bw, bh)))  # trim: subject + a little air, size as found
    return (max(0, bx0 - pad), max(0, by0 - pad), min(W, bx1 + pad), min(H, by1 + pad)), edge, info
def resize_to(img: Image.Image, prof: Profile, cap: int = 1024):
    """Scale to the profile size (or cap the longer side). Returns (image, upscale factor)."""
    w, h = img.size
    if prof.size is None:
        s = min(1.0, cap / max(w, h))
        return (img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS) if s < 1 else img), 1.0
    up = max(prof.size[0] / w, prof.size[1] / h)
    return img.resize(prof.size, Image.LANCZOS), up


def boss_square(img: Image.Image, side_out: int):
    W, H = img.size
    side = min(H, W)
    x0 = min(int(round(W * BOSS_SQ_LEFT)), W - side)
    return img.crop((x0, 0, x0 + side, side)).resize((side_out, side_out), Image.LANCZOS)


# ---------------------------------------------------------------- background removal

def cutout(img: Image.Image, tol: float, key=None, feather: float = 0.8) -> Image.Image:
    """Transparent background. Background = the fitted border model (or the chroma `key`); pixels close
    to it *and connected to the border* fade out (soft edge), so dark ink and key-coloured details inside
    the subject stay opaque. Chroma keys get a wider tolerance, a 1 px choke and green/blue despill."""
    rgb = img.convert("RGB")
    a = to_array(rgb)
    if key is not None:
        model = np.broadcast_to(np.asarray(key, np.float32), a.shape)
        lo, hi = 45.0, 110.0
    else:
        model, _ = fit_background(a)
        lo, hi = tol * 0.6, tol * 1.4
    d = np.sqrt(((a - model) ** 2).sum(axis=-1))
    cand = d < hi
    h, w = cand.shape
    s = min(1.0, 256 / max(h, w))
    sm = np.asarray(Image.fromarray((cand * 255).astype(np.uint8)).resize((max(2, int(w * s)), max(2, int(h * s))), Image.NEAREST)) > 0
    reach = np.zeros_like(sm)
    reach[0, :], reach[-1, :], reach[:, 0], reach[:, -1] = sm[0, :], sm[-1, :], sm[:, 0], sm[:, -1]
    for _ in range(sm.shape[0] * 2 + sm.shape[1] * 2):
        grow = reach.copy()
        grow[1:] |= reach[:-1]
        grow[:-1] |= reach[1:]
        grow[:, 1:] |= reach[:, :-1]
        grow[:, :-1] |= reach[:, 1:]
        grow &= sm
        if np.array_equal(grow, reach):
            break
        reach = grow
    reach_full = np.asarray(Image.fromarray((reach * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)) > 127
    alpha = np.clip((d - lo) / max(1e-3, hi - lo), 0, 1)
    alpha = np.where(reach_full & cand, alpha, 1.0)
    am = Image.fromarray((alpha * 255).astype(np.uint8), "L")
    if key is not None:
        am = am.filter(ImageFilter.MedianFilter(3)).filter(ImageFilter.MinFilter(3))  # GIF dither, 1 px choke
        # Despill: near the edge, pull the key channel down to the other two.
        ch = int(np.argmax(key))
        edge = np.asarray(am.filter(ImageFilter.MaxFilter(5))) > np.asarray(am.filter(ImageFilter.MinFilter(5)))
        others = [i for i in range(3) if i != ch]
        lim = np.maximum(a[..., others[0]], a[..., others[1]])
        a2 = a.copy()
        spill = edge & (a[..., ch] > lim)
        a2[..., ch] = np.where(spill, lim, a[..., ch])
        rgb = Image.fromarray(a2.astype(np.uint8), "RGB")
    if feather > 0:
        am = am.filter(ImageFilter.GaussianBlur(feather))
    out = rgb.convert("RGBA")
    out.putalpha(am)
    return out


# ---------------------------------------------------------------- frames

def flatten(fr: Image.Image, under) -> Image.Image:
    """RGBA → RGB over a colour (GIF transparency becomes the key / background colour)."""
    if fr.mode != "RGBA" or fr.getextrema()[3][0] == 255:
        return fr.convert("RGB")
    base = Image.new("RGB", fr.size, tuple(int(c) for c in under))
    base.paste(fr, (0, 0), fr)
    return base


def load_frames(path: Path):
    """[(frame, duration ms)], animated?"""
    im = Image.open(path)
    if not getattr(im, "is_animated", False) or getattr(im, "n_frames", 1) <= 1:
        im.load()
        return [(im.convert("RGBA") if im.mode in ("RGBA", "LA", "P", "PA") else im.convert("RGB"), 0)], False
    frames = []
    for fr in ImageSequence.Iterator(im):
        frames.append((fr.convert("RGBA"), int(fr.info.get("duration", im.info.get("duration", 100)) or 100)))
    return frames, True


def dedupe_frames(frames, thr=0.6, probe=None):
    """Merge consecutive frames that look the same (mean abs difference < thr), adding durations.
    `probe(frame)` gives the image to compare (e.g. the final crop), default the frame itself."""
    out = []
    prev = None
    for fr, dur in frames:
        a = np.asarray((probe(fr) if probe else fr).convert("RGB"), dtype=np.int16)
        if prev is not None and a.shape == prev.shape and float(np.abs(a - prev).mean()) < thr:
            out[-1] = (out[-1][0], out[-1][1] + dur)
            continue
        out.append((fr, dur))
        prev = a
    return out


def cap_frames(frames, max_frames):
    if len(frames) <= max_frames:
        return frames
    total = sum(d for _, d in frames)
    idx = np.linspace(0, len(frames), max_frames, endpoint=False).astype(int)
    each = max(20, int(total / max_frames))
    return [(frames[i][0], each) for i in idx]


def save_webp(img: Image.Image, path: Path, quality=QUALITY):
    path.parent.mkdir(parents=True, exist_ok=True)
    if img.mode == "RGBA" and img.getextrema()[3][0] < 255:
        img.save(path, "WEBP", quality=quality, method=6, alpha_quality=90)
    else:
        img.convert("RGB").save(path, "WEBP", quality=quality, method=6)
    return path.stat().st_size


def encode_anim(frames, quality, loop):
    buf = io.BytesIO()
    imgs = [f for f, _ in frames]
    durs = [max(20, d) for _, d in frames]
    imgs[0].save(buf, "WEBP", save_all=True, append_images=imgs[1:], duration=durs, loop=0 if loop else 1,
                 quality=quality, method=4, minimize_size=True)
    return buf.getvalue()


def save_anim(frames, path: Path, warnings: list, loop=True):
    """Animated WebP: squeeze toward 400 KB (quality, then every other frame); warn above 1.5 MB."""
    q, cur = QUALITY, frames
    data = encode_anim(cur, q, loop)
    while len(data) > ANIM_TARGET:
        if q > 60:
            q -= 10
        elif len(cur) > 6:
            cur = [(cur[i][0], cur[i][1] + (cur[i + 1][1] if i + 1 < len(cur) else 0)) for i in range(0, len(cur), 2)]
        else:
            break
        data = encode_anim(cur, q, loop)
    if len(data) > ANIM_BUDGET:
        warnings.append(f"animated file is {len(data) / 1e6:.2f} MB (> 1.5 MB budget): TVs may stutter")
    elif q != QUALITY or cur is not frames:
        warnings.append(f"animation squeezed (quality {q}, {len(cur)} frames, {len(data) // 1024} KB)")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return len(data), cur


def save_strip(frames, path: Path):
    w, h = frames[0][0].size
    strip = Image.new("RGBA", (w * len(frames), h), (0, 0, 0, 0))
    for i, (f, _) in enumerate(frames):
        strip.paste(f.convert("RGBA"), (i * w, 0))
    strip.save(path, "WEBP", quality=QUALITY, method=6, alpha_quality=90)
    return path.stat().st_size


# ---------------------------------------------------------------- JSON edits that keep formatting

class _Spans:
    """Minimal JSON parser that remembers where every value sits in the text: path → (start, end)."""

    def __init__(self, text: str):
        self.t, self.i, self.spans, self.keys = text, 0, {}, {}
        self.ws()
        if self.t.startswith("﻿", self.i):
            self.i += 1
        self.value(())

    def ws(self):
        while self.i < len(self.t) and self.t[self.i] in " \t\r\n":
            self.i += 1

    def value(self, path):
        self.ws()
        start, c = self.i, self.t[self.i]
        if c == "{":
            self.i += 1
            self.keys[path] = []
            self.ws()
            if self.t[self.i] == "}":
                self.i += 1
            else:
                while True:
                    self.ws()
                    k = self.string()
                    self.ws()
                    self.i += 1  # ':'
                    self.keys[path].append(k)
                    self.value(path + (k,))
                    self.ws()
                    c = self.t[self.i]
                    self.i += 1
                    if c == "}":
                        break
        elif c == "[":
            self.i += 1
            self.ws()
            n = 0
            if self.t[self.i] == "]":
                self.i += 1
            else:
                while True:
                    self.value(path + (n,))
                    n += 1
                    self.ws()
                    c = self.t[self.i]
                    self.i += 1
                    if c == "]":
                        break
        elif c == '"':
            self.string()
        else:
            m = re.compile(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null").match(self.t, self.i)
            self.i = m.end()
        self.spans[path] = (start, self.i)

    def string(self):
        m = re.compile(r'"(?:[^"\\]|\\.)*"').match(self.t, self.i)
        self.i = m.end()
        return json.loads(m.group(0))


def _get(data, path):
    for k in path:
        data = data[k]
    return data


def set_json_paths(path: Path, edits: list) -> bool:
    """edits = [(json path tuple, value)]; parents must exist. Keeps the file's formatting; falls back to
    a full pretty rewrite if the surgical edit would not round-trip. Returns True when the file changed."""
    text = path.read_text(encoding="utf-8")
    data = json.loads(text.lstrip("﻿"))
    todo = []
    for p, v in edits:
        try:
            parent = _get(data, p[:-1])
        except (KeyError, IndexError, TypeError):
            continue
        if isinstance(parent, dict) and parent.get(p[-1]) == v:
            continue
        if isinstance(parent, list) and p[-1] < len(parent) and parent[p[-1]] == v:
            continue
        parent[p[-1]] = v
        todo.append((p, v))
    if not todo:
        return False
    new = text
    try:
        for p, v in todo:
            sp = _Spans(new)
            lit = json.dumps(v, ensure_ascii=False)
            if p in sp.spans:
                s, e = sp.spans[p]
                new = new[:s] + lit + new[e:]
                continue
            keys = sp.keys[p[:-1]]
            ps, pe = sp.spans[p[:-1]]
            if not keys:
                new = new[:ps + 1] + f'"{p[-1]}": {lit}' + new[ps + 1:]
                continue
            after = "id" if "id" in keys else keys[-1]
            if "image" in keys and p[-1] != "image":
                after = "image"
            e = sp.spans[p[:-1] + (after,)][1]
            new = new[:e] + f', "{p[-1]}": {lit}' + new[e:]
        ok = json.loads(new.lstrip("﻿")) == data
    except Exception:  # noqa: BLE001 - any parser surprise → safe full rewrite
        ok = False
    if not ok:
        new = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    path.write_text(new, encoding="utf-8")
    return True


# ---------------------------------------------------------------- pack wiring

LIB_FILES = {"items": "icon", "monsters": "portrait", "npcs": "portrait", "bosses": "boss", "locations": "location"}


def load_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8").lstrip("﻿"))
    except FileNotFoundError:
        return None


class PackIndex:
    def __init__(self, pack: Path):
        self.pack = pack
        self.where = {}  # id → (file stem, index)
        self.bosses = {}  # boss id → (index, phase count)
        for stem in LIB_FILES:
            data = load_json(pack / f"{stem}.json")
            if isinstance(data, list):
                for i, e in enumerate(data):
                    if isinstance(e, dict) and isinstance(e.get("id"), str):
                        self.where.setdefault(e["id"], (stem, i))
                        if stem == "bosses":
                            self.bosses[e["id"]] = (i, len(e.get("phases") or []))
        self.icons = set()
        ic = load_json(pack / "icons.json")
        if isinstance(ic, dict):
            for c in ic.get("categories", []):
                if isinstance(c, dict):
                    if isinstance(c.get("base"), str):
                        self.icons.add(c["base"])
                    for v in c.get("variants", []) or []:
                        if isinstance(v, dict) and isinstance(v.get("id"), str):
                            self.icons.add(v["id"])
            if isinstance(ic.get("fallback"), str):
                self.icons.add(ic["fallback"])

    def kind_of(self, id_: str):
        if id_ in self.icons:
            return "icon"
        if id_ in self.where:
            return LIB_FILES[self.where[id_][0]]
        if boss_state(self, id_):
            return "portrait"
        if ui_slot(id_):
            return "ui"
        return None


def boss_state(idx: PackIndex, id_: str):
    """'porter_grim_p2' → (boss index, ('phases', 1, 'image')); 'porter_grim_ko' → (i, ('imageKo',))."""
    m = re.match(r"^(.+)_(p(\d+)|ko)$", id_)
    if not m or m.group(1) not in idx.bosses:
        return None
    i, n = idx.bosses[m.group(1)]
    if m.group(2) == "ko":
        return i, ("imageKo",)
    k = int(m.group(3)) - 1
    return (i, ("phases", k, "image")) if 0 <= k < n else None


ANIM_SLOTS = {"system_talk": ("mascot", "talking"), "system_laugh": ("mascot", "laughing"), "system_idle": ("mascot", "idle"),
              "coin_spin": ("fx", "coin"), "sponsor_seal_sting": ("fx", "sponsor_sting")}
FLOOR_SCENES = {"arena": "combat", "combat": "combat", "boss": "boss", "lobby": "lobby", "explore": "explore", "studio": "lobby"}


def ui_slot(id_: str):
    """id → path in ui.json (tuple), or None. Ids as written by the art director's SHEETS.csv."""
    if id_ in ANIM_SLOTS:
        return ANIM_SLOTS[id_]
    if id_ in ("logo", "logo_emblem"):
        return ("logo",)
    m = re.match(r"^logo_emblem_([a-z0-9]+)$", id_)
    if m:
        return ("logoOptions", m.group(1))
    m = re.match(r"^system_(.+?)(?:_anim)?$", id_)
    if m:
        return ("mascot", m.group(1))
    m = re.match(r"^loot_(.+)_(closed|open|opening|idle|rattle)$", id_)
    if m:
        return ("lootBoxes", m.group(1), "idle" if m.group(2) == "rattle" else m.group(2))
    m = re.match(r"^cond_(.+)$", id_)
    if m:
        return ("conditions", "default" if m.group(1) == "generic" else m.group(1))
    m = re.match(r"^die_(d\d+)(?:_(.+))?$", id_)
    if m:
        return ("dice", m.group(1), m.group(2) or "body")
    m = re.match(r"^fin_(.+)$", id_)
    if m:
        return ("finale", m.group(1))
    m = re.match(r"^medal_(.+)$", id_)
    if m:
        return ("medals", "default" if m.group(1) == "generic" else m.group(1))
    m = re.match(r"^sponsor_(.+)$", id_)
    if m:
        return ("sponsors", m.group(1))
    m = re.match(r"^orn_(.+)$", id_)
    if m:
        return ("rarityFrames", m.group(1))
    m = re.match(r"^fx_(.+?)(?:_anim)?$", id_)
    if m:
        return ("fx", m.group(1))
    m = re.match(r"^bg_(?:([a-z]+)_)?f(\d+|default)$", id_)
    if m:
        return ("floors", m.group(2), FLOOR_SCENES.get(m.group(1) or "", m.group(1) or "default"))
    m = re.match(r"^bg_([a-z]+)$", id_)
    if m:
        return ("floors", "default", FLOOR_SCENES.get(m.group(1), m.group(1)))
    m = re.match(r"^stinger_(.+)$", id_)
    if m:
        return ("stingers", m.group(1))
    m = re.match(r"^empty_(.+)$", id_)
    if m:
        return ("empty", m.group(1))
    m = re.match(r"^avatar_(.+)$", id_)
    if m:
        return ("avatars", m.group(1))
    m = re.match(r"^amb_(.+)$", id_)
    if m:
        return ("anim", id_)
    return None


def set_ui(pack: Path, slot: tuple, value) -> bool:
    """Write one asset into ui.json. An animation landing on a slot that holds a still keeps that still
    as the reduced-motion fallback ({src: anim, still: old})."""
    p = pack / "ui.json"
    data = load_json(p) or {}
    node = data
    for k in slot[:-1]:
        nxt = node.get(k)
        if not isinstance(nxt, dict):
            nxt = {"default": nxt} if isinstance(nxt, (str, list)) else {}
            node[k] = nxt
        node = nxt
    leaf = slot[-1]
    old = node.get(leaf)
    if isinstance(value, dict) and isinstance(old, str):
        value = {**value, "still": old}
    elif isinstance(value, dict) and isinstance(old, dict) and old.get("still") and not old.get("strip"):
        value = {**value, "still": old["still"]}
    elif isinstance(value, str) and isinstance(old, dict) and old.get("strip"):
        value = {**old, "still": value}  # a still arriving after the animation
    if slot[0] == "sponsors" and isinstance(old, dict) and "src" not in old and "image" in old:
        value = {**old, "image": value}
    if old == value:
        return False
    node[leaf] = value
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True


# ---------------------------------------------------------------- contact sheet

def _font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def checker(size, sq=12):
    w, h = size
    im = Image.new("RGB", size, (60, 60, 70))
    d = ImageDraw.Draw(im)
    for y in range(0, h, sq):
        for x in range((y // sq) % 2 * sq, w, sq * 2):
            d.rectangle([x, y, x + sq - 1, y + sq - 1], fill=(90, 90, 100))
    return im


SOFT_WARN = ("upscaled", "animation squeezed", "reference cell")


def contact_sheet(src: Image.Image, grid: Grid, results, out: Path, title: str):
    th = 220
    font, small, big = _font(15), _font(12), _font(20)
    s = 520 / max(src.size)
    prev = src.convert("RGB").resize((max(1, int(src.width * s)), max(1, int(src.height * s))), Image.BILINEAR)
    d = ImageDraw.Draw(prev)
    for (x0, y0, x1, y1) in grid.cells():
        d.rectangle([x0 * s, y0 * s, x1 * s - 1, y1 * s - 1], outline=(255, 230, 0), width=2)
    for r in results:
        if r.get("crop_abs"):
            x0, y0, x1, y1 = r["crop_abs"]
            d.rectangle([x0 * s, y0 * s, x1 * s - 1, y1 * s - 1], outline=(0, 255, 230), width=1)
    tiles = []
    for r in results:
        im = r.get("preview")
        if im is None:
            continue
        t = im.copy()
        t.thumbnail((th, th), Image.LANCZOS)
        bg = checker((th, th)) if t.mode == "RGBA" else Image.new("RGB", (th, th), (24, 20, 32))
        bg.paste(t, ((th - t.width) // 2, (th - t.height) // 2), t if t.mode == "RGBA" else None)
        tiles.append((bg, r))
    strips = [r for r in results if r.get("strip_preview") is not None]
    cols = max(1, min(6, len(tiles)))
    rows_n = math.ceil(len(tiles) / cols) if tiles else 0
    tw, tht = th + 16, th + 70
    strip_h = sum(min(160, r["strip_preview"].height) + 30 for r in strips)
    W = max(prev.width + 40, cols * tw + 24, 900 if strips else 0)
    H = 70 + prev.height + 30 + rows_n * tht + 20 + strip_h
    sheet = Image.new("RGB", (W, H), (14, 11, 20))
    d = ImageDraw.Draw(sheet)
    how = "/".join(sorted(set(grid.how_x + grid.how_y))) or "single cell"
    d.text((16, 12), title, fill=(255, 255, 255), font=big)
    d.text((16, 40), f"grid {grid.cols}x{grid.rows}{' (transposed)' if grid.transposed else ''}  deskew {grid.angle:+.2f} deg  cuts: {how}"
           "   [yellow = cells, cyan = crops; tile border: green ok, amber note/unknown, red problem]", fill=(200, 200, 210), font=font)
    sheet.paste(prev, (16, 70))
    y = 70 + prev.height + 30
    for i, (tile, r) in enumerate(tiles):
        x = 12 + (i % cols) * tw
        yy = y + (i // cols) * tht
        sheet.paste(tile, (x, yy))
        hard = [w for w in r.get("warnings", []) if not w.startswith(SOFT_WARN)]
        col = (255, 90, 90) if hard else (255, 200, 0) if (not r.get("wired") or r.get("warnings")) else (0, 255, 200)
        d.rectangle([x - 1, yy - 1, x + th, yy + th], outline=col, width=2)
        d.text((x, yy + th + 4), f"{r.get('cell', i) + 1}. {r['id']}"[:34], fill=(255, 255, 255), font=font)
        d.text((x, yy + th + 24), f"{r['kind']} {r.get('size', '')} {r.get('status', '')}"[:40], fill=col, font=small)
        if r.get("warnings"):
            d.text((x, yy + th + 40), r["warnings"][0][:40], fill=(255, 120, 120) if hard else (255, 200, 0), font=small)
    y += rows_n * tht + 10
    for r in strips:
        st = r["strip_preview"].copy()
        st.thumbnail((W - 32, 160), Image.LANCZOS)
        d.text((16, y), f"{r['id']}: {r.get('frames')} frames, {'loop' if r.get('loop', True) else 'once'}", fill=(255, 255, 255), font=font)
        bg = checker(st.size)
        bg.paste(st, (0, 0), st if st.mode == "RGBA" else None)
        sheet.paste(bg, (16, y + 20))
        y += st.height + 30
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, "PNG")
    return out


# ---------------------------------------------------------------- main pipeline

def work_dir() -> Path:
    env = os.environ.get("ART_WORK_DIR")
    if env:
        return Path(env)
    p = Path("/home/claude/work/art")
    return p if p.parent.exists() else Path(tempfile.gettempdir()) / "art_ingest"


def resolve_profile(id_, row, kind, idx: PackIndex, cell_aspect_txt):
    if kind:
        base = KIND_PROFILES[kind]
    elif row and row.get("type") in TYPE_PROFILES:
        base = TYPE_PROFILES[row["type"]]
    else:
        k = idx.kind_of(id_) or ASPECT_KIND.get((cell_aspect_txt or "").replace(" ", "")) or "icon"
        base = KIND_PROFILES[k]
    return profile_for_row(row, base, id_) if row else base


def wire(idx: PackIndex, pack: Path, id_: str, rel: str, prof: Profile, extra: dict, dry_run: bool):
    """Point the pack at the new file. Returns (target label or None)."""
    if id_ in idx.where:
        stem, i = idx.where[id_]
        edits = [((i, "image"), rel)]
        if stem == "bosses" and extra.get("sq"):
            edits.append(((i, "imageSquare"), extra["sq"]))
        if not dry_run:
            set_json_paths(pack / f"{stem}.json", edits)
        return f"{stem}.json"
    bs = boss_state(idx, id_)
    if bs:
        i, sub = bs
        if not dry_run:
            set_json_paths(pack / "bosses.json", [((i,) + sub, rel)])
        return "bosses.json " + ".".join(str(s) for s in sub)
    if id_ in idx.icons:
        return "icons.json (by file name)"
    slot = ui_slot(id_)
    if slot:
        value = extra.get("anim") or rel
        if not dry_run:
            set_ui(pack, slot, value)
        return "ui.json " + ".".join(slot)
    return None


def ingest(image: Path, sheet_id: str, pack: Path, csv_path: Path | None = None, grid=None, ids=None, kind=None,
           dry_run=False, contact: Path | None = None, tol=40.0, max_frames=24, cut=None, log=print):
    """Runs the whole pipeline. Returns a report dict (also used by the tests)."""
    row = read_sheet_row(csv_path, sheet_id) if csv_path and Path(csv_path).exists() else None
    if csv_path and not row and (grid is None or ids is None):
        log(f"warning: sheet {sheet_id!r} not found in {csv_path}")
    is_anim_row = bool(row and (row.get("type") == "animation" or re.match(r"GIF", row.get("grid", ""), re.I))) or kind == "anim"
    spec = anim_spec(row) if row else {"frames": None, "total": None, "loop": True, "frame_grid": None}
    key = key_color((row or {}).get("bg"))
    cell_aspect = parse_aspect((row or {}).get("cell_aspect"))
    id_list = ids if ids is not None else split_ids((row or {}).get("contents"))
    if not [i for i in id_list if i.lower() not in EMPTY_TOKENS]:
        id_list = [sheet_id]

    frames, animated = load_frames(image)
    under = key or tuple(int(c) for c in np.median(border_ring(to_array(frames[0][0].convert("RGB")), 0.01), axis=0))
    frames = [(flatten(f, under), d) for f, d in frames]
    frame_grid = None
    if is_anim_row and not animated:
        # The prompt's fallback: one still with N key frames in a grid → slice, align, animate.
        frame_grid = grid or spec["frame_grid"] or (4, 2)
        grid = frame_grid
    if grid is None:
        grid = parse_grid((row or {}).get("grid")) or (1, 1)
    if frame_grid is None and len(id_list) > grid[0] * grid[1]:
        raise SystemExit(f"{len(id_list)} ids but the grid {grid[0]}x{grid[1]} has only {grid[0] * grid[1]} cells")

    if animated:
        pick = frames[:: max(1, len(frames) // 8)]
        probe = Image.fromarray(np.max(np.stack([to_array(f) for f, _ in pick]), axis=0).astype(np.uint8), "RGB")
    else:
        probe = frames[0][0].convert("RGB")
    (gc, gr), transposed = choose_orientation(probe, grid, None if frame_grid else cell_aspect, len(id_list), tol)
    g, rotated_probe = detect_grid(probe, gc, gr, tol)
    g.transposed = transposed
    if transposed:
        log(f"note: grid {grid[0]}x{grid[1]} read as {gc}x{gr} (fits the sheet better)")
    report = {"sheet": sheet_id, "type": (row or {}).get("type"), "image": str(image), "grid": f"{gc}x{gr}", "transposed": transposed,
              "angle": g.angle, "cuts": {"x": g.how_x, "y": g.how_y}, "animated": animated or bool(frame_grid),
              "frame_grid": bool(frame_grid), "slices": [], "unknown": [], "dry_run": dry_run}

    def prep(fr):
        return fr if g.angle == 0 else fr.rotate(g.angle, resample=Image.BICUBIC, fillcolor=tuple(int(c) for c in under))

    rot = [(prep(f), d) for f, d in frames]
    idx = PackIndex(pack)
    images_dir = pack / "images"
    results = []

    if frame_grid:
        anim_id = id_list[0]
        prof = resolve_profile(anim_id, row, "anim" if kind is None else kind, idx, None)
        prof = replace(prof, anim=True, alpha=True if prof.alpha or key else prof.alpha)
        total_ms = (spec["total"] or 1.0) * 1000
        cells = []
        for c in g.cells():
            im = rot[0][0].crop(c)
            bx, _e = subject_bbox(to_array(im), tol)
            if bx:
                cells.append((im, bx))
        dur = int(total_ms / max(1, len(cells)))
        r = process_anim(anim_id, [(im, dur) for im, _ in cells], prof, key, tol, max_frames, spec["loop"], images_dir, dry_run,
                         align=[bx for _, bx in cells])
        r["cell"] = 0
        r["crop_abs"] = None
        results.append(r)
    else:
        for i, cell in enumerate(g.cells()):
            if i >= len(id_list):
                break
            id_ = id_list[i].strip()
            if id_.lower() in EMPTY_TOKENS:
                continue
            if not re.match(r"^[A-Za-z0-9_-]{1,64}$", id_):
                results.append({"id": id_, "kind": "?", "cell": i, "warnings": ["invalid id (letters, digits, _ and - only)"], "status": "skipped"})
                continue
            prof = resolve_profile(id_, row, kind, idx, (row or {}).get("cell_aspect"))
            if animated and not prof.anim:
                # Moving UI art (mascot, fx, ...) gets the animation profile; moving item / bestiary art
                # keeps its own framing and size.
                prof = replace(KIND_PROFILES["anim"], alpha=prof.alpha or key is not None or prof.kind == "ui") if prof.kind == "ui" else replace(prof, anim=True)
                if row:
                    prof = profile_for_row(row, prof, id_)
            if cut and prof.kind == "icon":
                prof = replace(prof, alpha=True)
            if cut is False:
                prof = replace(prof, alpha=False)
            r = process_cell(id_, i, cell, rot, prof, key, tol, max_frames, spec["loop"], images_dir, dry_run, keep_bg=key is None)
            results.append(r)

    for r in results:
        if r.get("skip") or not r.get("rel"):
            continue
        target = wire(idx, pack, r["id"], r["rel"], r["profile"], r.get("extra", {}), dry_run)
        r["wired"] = bool(target)
        r["target"] = target
        r["status"] = ("would write" if dry_run else "written") + ("" if target else " (unknown id)")
        if not target:
            report["unknown"].append(r["id"])

    # Style anchors the art director wants kept (SHEETS.md "Anchor files").
    if not dry_run and sheet_id in ANCHORS and csv_path:
        name, cell_no = ANCHORS[sheet_id]
        dest = Path(csv_path).parent / name
        if cell_no is None:
            frames[0][0].convert("RGB").save(dest)
        else:
            rot[0][0].crop(g.cells()[cell_no]).convert("RGB").save(dest)
        report["anchor"] = str(dest)

    if len(id_list) > len(g.cells()) and not frame_grid:
        report["unused_ids"] = id_list[len(g.cells()):]
    out = contact or (work_dir() / f"{sheet_id}_contact.png")
    contact_sheet(rotated_probe, g, results, out, f"{sheet_id}  ({image.name}){'  type ' + row['type'] if row and row.get('type') else ''}")
    report["contact"] = str(out)
    for r in results:
        report["slices"].append({k: v for k, v in r.items() if k not in ("preview", "strip_preview", "profile", "extra")} | {"kind": r["profile"].kind if r.get("profile") else r.get("kind")})
    return report


def _render(f, inner, box, prof, key, tol, fill, alpha):
    src = f.crop(inner).convert("RGB")
    if alpha:
        src = cutout(src, tol, key)  # on the whole cell: its border ring is clean background
    return resize_to(crop_with_fill(src, box, fill), prof)


def process_cell(id_, i, cell, rot, prof, key, tol, max_frames, loop, images_dir: Path, dry_run, keep_bg=True):
    r = {"id": id_, "cell": i, "profile": prof, "kind": prof.kind, "warnings": [], "files": []}
    x0, y0, x1, y1 = cell
    base = rot[0][0].crop(cell)
    bl, bt, br, bb = trim_uniform_edges(to_array(base))
    inner = (x0 + bl, y0 + bt, x0 + br, y0 + bb)
    cell_img = rot[0][0].crop(inner)
    if prof.anim and len(rot) > 1:
        boxes = [b for b in (subject_bbox(to_array(f.crop(inner)), tol)[0] for f, _ in rot) if b]
        union = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)) if boxes else None
        _b, edge = subject_bbox(to_array(cell_img), tol)
        box, edge, info = plan_crop(cell_img, prof, tol, subject=(union, edge))
    else:
        box, edge, info = plan_crop(cell_img, prof, tol)
    if info.get("warn"):
        r["warnings"].append(info["warn"])
    r["crop_abs"] = (inner[0] + box[0], inner[1] + box[1], inner[0] + box[2], inner[1] + box[3])
    fill = tuple(int(c) for c in (key or edge))
    if id_.endswith("_ref"):
        main, _ = _render(rot[0][0], inner, box, prof, key, tol, fill, False)
        r.update(preview=main, skip=True, status="reference cell, not saved")
        r["warnings"].append("reference cell: consistency check only, not saved")
        return r
    if prof.anim and len(rot) > 1:
        fr = [(f, d) for f, d in rot]
        return process_anim(id_, fr, prof, key, tol, max_frames, loop, images_dir, dry_run, inner=inner, box=box, fill=fill, r=r)
    main, up = _render(rot[0][0], inner, box, prof, key, tol, fill, False)
    if up > 1.5:
        r["warnings"].append(f"upscaled x{up:.1f}: low detail, consider a bigger sheet")
    r["size"] = f"{main.width}x{main.height}"
    primary = _render(rot[0][0], inner, box, prof, key, tol, fill, True)[0] if prof.alpha else main.convert("RGB")
    r["preview"] = primary
    rel = f"{prof.subdir}/{id_}.webp" if prof.subdir else f"{id_}.webp"
    r["rel"] = rel
    if prof.alpha and prof.kind == "icon" and not key:
        # Icons stay opaque on their gradient; the cut-out is an extra.
        primary, extra_cut = main.convert("RGB"), _render(rot[0][0], inner, box, prof, key, tol, fill, True)[0]
        r["preview"] = primary
    else:
        extra_cut = None
    extra = {}
    if not dry_run:
        r["bytes"] = save_webp(primary, images_dir / rel)
        r["files"].append(rel)
        if prof.alpha and keep_bg and extra_cut is None:
            bg_rel = rel[:-5] + "_bg.webp"
            save_webp(main.convert("RGB"), images_dir / bg_rel)
            r["files"].append(bg_rel)
        if extra_cut is not None:
            cut_rel = rel[:-5] + "_cut.webp"
            save_webp(extra_cut, images_dir / cut_rel)
            r["files"].append(cut_rel)
    if prof.sq:
        sq_rel = rel[:-5] + "_sq.webp"
        extra["sq"] = sq_rel
        if not dry_run:
            save_webp(boss_square(main.convert("RGB"), prof.sq), images_dir / sq_rel)
            r["files"].append(sq_rel)
    r["extra"] = extra
    return r


def process_anim(id_, frames, prof, key, tol, max_frames, loop, images_dir: Path, dry_run, inner=None, box=None, fill=None, r=None, align=None):
    """frames: full frames (with inner/box: one crop for all) or cell images aligned on their subject
    bbox (align = [bbox per frame]). Writes anim webp + _0 still + _strip + .json."""
    r = r or {"id": id_, "profile": prof, "kind": "anim", "warnings": [], "files": []}
    r["profile"] = prof
    if align is not None:
        # Frame-grid fallback: one canvas = largest subject bbox + padding, every frame centred on its subject.
        bw = max(b[2] - b[0] for b in align)
        bh = max(b[3] - b[1] for b in align)
        side = max(bw, bh) / prof.fill
        crops = []
        for (im, d), b in zip(frames, align):
            cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
            bx = (int(round(cx - side / 2)), int(round(cy - side / 2)), int(round(cx + side / 2)), int(round(cy + side / 2)))
            _bb, edge = subject_bbox(to_array(im), tol)
            f = tuple(int(c) for c in (key or edge))
            src = cutout(im.convert("RGB"), tol, key) if prof.alpha else im.convert("RGB")
            crops.append((resize_to(crop_with_fill(src, bx, f), prof)[0], d))
        raw = dedupe_frames(crops)
        fr = cap_frames(raw, max_frames)
    else:
        raw = dedupe_frames(frames, probe=lambda f: _render(f, inner, box, prof, key, tol, fill, False)[0])
        raw = cap_frames(raw, max_frames)
        fr = [(_render(f, inner, box, prof, key, tol, fill, prof.alpha)[0].convert("RGBA"), d) for f, d in raw]
    r["frames"] = len(fr)
    r["loop"] = loop
    r["size"] = f"{fr[0][0].width}x{fr[0][0].height}"
    r["preview"] = fr[0][0]
    sub = prof.subdir
    pre = f"{sub}/" if sub else ""
    rel = f"{pre}{id_}.webp"
    r["rel"] = rel
    if len(fr) == 1:
        r["warnings"].append("all frames identical: saved as a still")
        if not dry_run:
            r["bytes"] = save_webp(fr[0][0], images_dir / rel)
            r["files"].append(rel)
        r["extra"] = {}
        return r
    w, h = fr[0][0].size
    strip = Image.new("RGBA", (w * len(fr), h), (0, 0, 0, 0))
    for k, (f, _) in enumerate(fr):
        strip.paste(f, (k * w, 0))
    r["strip_preview"] = strip
    still_rel, strip_rel, meta_rel = f"{pre}{id_}_0.webp", f"{pre}{id_}_strip.webp", f"{pre}{id_}.json"
    total = sum(d for _, d in fr)
    fps = round(len(fr) * 1000 / max(1, total), 2)
    if not dry_run:
        n, fr2 = save_anim(fr, images_dir / rel, r["warnings"], loop)
        r["bytes"] = n
        save_webp(fr[0][0], images_dir / still_rel)
        save_strip(fr, images_dir / strip_rel)
        meta = {"frames": len(fr), "fps": fps, "w": w, "h": h, "loop": loop}
        (images_dir / meta_rel).write_text(json.dumps(meta) + "\n", encoding="utf-8")
        r["files"] += [rel, still_rel, strip_rel, meta_rel]
    r["extra"] = {"anim": {"src": rel, "still": still_rel, "strip": strip_rel, "frames": len(fr), "fps": fps, "w": w, "h": h, "loop": loop}}
    return r


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image", type=Path)
    ap.add_argument("--sheet", required=True, help="sheet_id (row in SHEETS.csv; also the id of a 1x1 sheet without contents)")
    ap.add_argument("--pack", required=True, type=Path)
    ap.add_argument("--csv", type=Path, help="SHEETS.csv (default: <pack>/../../art/SHEETS.csv when present)")
    ap.add_argument("--grid", help="COLSxROWS, overrides the CSV (for an animation row given as a still: the frame grid)")
    ap.add_argument("--ids", help="ids in reading order separated by , ; or |, overrides the CSV ('-' = empty cell)")
    ap.add_argument("--kind", choices=list(KIND_PROFILES), help="force one profile for every slice (default: CSV type, then pack, then cell aspect)")
    ap.add_argument("--cutout", action="store_true", default=None, help="icons: also write <id>_cut.webp with a transparent background")
    ap.add_argument("--no-cutout", dest="cutout", action="store_false", help="never key to alpha")
    ap.add_argument("--dry-run", action="store_true", help="only write the contact sheet")
    ap.add_argument("--contact", type=Path, help="contact sheet path (default: $ART_WORK_DIR or /home/claude/work/art)")
    ap.add_argument("--tol", type=float, default=40.0, help="colour distance that counts as 'not background' (default 40)")
    ap.add_argument("--max-frames", type=int, default=24)
    ap.add_argument("--json", action="store_true", help="print the report as JSON")
    a = ap.parse_args(argv)
    if not a.image.exists():
        sys.exit(f"no such image: {a.image}")
    if not (a.pack / "pack.json").exists():
        sys.exit(f"not a pack folder (no pack.json): {a.pack}")
    csv_path = a.csv
    if csv_path is None:
        guess = a.pack.resolve().parent.parent / "art" / "SHEETS.csv"
        csv_path = guess if guess.exists() else None
    grid = parse_grid(a.grid)
    if a.grid and not grid:
        sys.exit(f"bad --grid {a.grid!r}, expected e.g. 3x3")
    rep = ingest(a.image, a.sheet, a.pack, csv_path, grid, split_ids(a.ids) if a.ids else None, a.kind,
                 a.dry_run, a.contact, a.tol, a.max_frames, a.cutout)
    if a.json:
        print(json.dumps(rep, indent=2, default=str))
        return rep
    print(f"sheet {rep['sheet']}{' (' + rep['type'] + ')' if rep.get('type') else ''}: grid {rep['grid']}{' (transposed)' if rep['transposed'] else ''}, "
          f"deskew {rep['angle']:+.2f} deg, cuts x={','.join(rep['cuts']['x']) or '-'} y={','.join(rep['cuts']['y']) or '-'}"
          f"{', frame grid → animation' if rep['frame_grid'] else ', animated' if rep['animated'] else ''}")
    for s in rep["slices"]:
        extra = f" {s['frames']} frames{'' if s.get('loop', True) else ' once'}" if s.get("frames") else ""
        size = f" {s['bytes'] / 1024:.0f} KB" if s.get("bytes") else ""
        print(f"  {s['id']:<30} {s['kind']:<9} {s.get('size', ''):<10}{size}{extra}  {s.get('status', '')}  -> {s.get('target') or '-'}")
        for w in s.get("warnings", []):
            print(f"      ! {w}")
    if rep["unknown"]:
        print("Unknown ids (file written, nothing wired; check spelling or add the entry):", ", ".join(rep["unknown"]))
    if rep.get("unused_ids"):
        print("More ids than cells, unused:", ", ".join(rep["unused_ids"]))
    if rep.get("anchor"):
        print(f"style anchor saved: {rep['anchor']}")
    print(f"contact sheet: {rep['contact']}")
    if rep["dry_run"]:
        print("dry run: nothing written to the pack")
    return rep


if __name__ == "__main__":
    main()

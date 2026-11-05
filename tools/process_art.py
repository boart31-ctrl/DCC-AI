#!/usr/bin/env python3
"""Turn raw generated item art into pack-ready images.

Usage:
    python3 tools/process_art.py <pack_dir> [--size 512]

Reads <pack_dir>/images/raw/ and writes <pack_dir>/images/<id>.webp.

File naming in raw/:
    rubber_duck.png                          one item per image
    rubber_duck__torch__map__boots.png       2x2 grid, ids in reading order
                                             (top-left, top-right, bottom-left, bottom-right)
    a__b.png                                 1x2 grid (left, right)

Each tile is center-cropped to a square, trimmed of uniform borders, resized and saved as WebP.
Unknown ids (not in items.json) are reported but still written.
"""
import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops

EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def trim_border(img, tolerance=12):
    """Cut away a near-uniform frame (generators often add margins)."""
    rgb = img.convert("RGB")
    bg = Image.new("RGB", rgb.size, rgb.getpixel((0, 0)))
    diff = ImageChops.difference(rgb, bg).convert("L").point(lambda p: 255 if p > tolerance else 0)
    box = diff.getbbox()
    if not box:
        return img
    w, h = img.size
    # Only trim if we keep most of the picture; otherwise the "border" is the art itself.
    if (box[2] - box[0]) * (box[3] - box[1]) < 0.35 * w * h:
        return img
    return img.crop(box)


def square(img):
    w, h = img.size
    s = min(w, h)
    left, top = (w - s) // 2, (h - s) // 2
    return img.crop((left, top, left + s, top + s))


def split(img, n):
    w, h = img.size
    if n == 1:
        return [img]
    if n == 2:
        return [img.crop((0, 0, w // 2, h)), img.crop((w // 2, 0, w, h))]
    if n == 4:
        hw, hh = w // 2, h // 2
        return [img.crop((x, y, x + hw, y + hh)) for y in (0, hh) for x in (0, hw)]
    raise ValueError(f"grid of {n} not supported (use 1, 2 or 4 ids)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pack_dir")
    ap.add_argument("--size", type=int, default=512)
    args = ap.parse_args()

    pack = Path(args.pack_dir)
    raw, out = pack / "images" / "raw", pack / "images"
    if not raw.is_dir():
        sys.exit(f"No raw folder: {raw}")
    known = set()
    items_file = pack / "items.json"
    if items_file.exists():
        known = {i["id"] for i in json.loads(items_file.read_text(encoding="utf-8"))}

    done, unknown = 0, []
    for f in sorted(raw.iterdir()):
        if f.suffix.lower() not in EXTS:
            continue
        ids = f.stem.split("__")
        try:
            tiles = split(Image.open(f), len(ids))
        except ValueError as e:
            print(f"skip {f.name}: {e}")
            continue
        for item_id, tile in zip(ids, tiles):
            tile = square(trim_border(tile)).resize((args.size, args.size), Image.LANCZOS)
            tile.convert("RGB").save(out / f"{item_id}.webp", "WEBP", quality=88, method=6)
            done += 1
            if known and item_id not in known:
                unknown.append(item_id)

    print(f"{done} images written to {out}")
    if unknown:
        print("Not in items.json (check spelling):", ", ".join(unknown))
    if known:
        missing = sorted(i for i in known if not (out / f"{i}.webp").exists())
        print(f"{len(known) - len(missing)}/{len(known)} items have art.")
        if missing:
            print("Still missing:", ", ".join(missing))


if __name__ == "__main__":
    main()

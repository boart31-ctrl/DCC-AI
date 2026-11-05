#!/usr/bin/env python3
"""Turn raw generated item art into pack-ready images.

Usage:
    python3 tools/process_art.py <pack_dir> [--also <other_pack_dir> ...] [--size 512]

Reads <pack_dir>/images/raw/ and writes <pack_dir>/images/<id>.webp.
Ids that belong to an --also pack (by its items.json) are written to that pack instead.

File naming in raw/:
    rubber_duck.png                          one item per image
    rubber_duck__torch__map__boots.png       2x2 grid, ids in reading order
    grid__rubber_duck__torch__map__boots.png same, optional "grid" prefix
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
    if n in (3, 4):  # 3 ids = 2x2 grid with the last cell empty
        hw, hh = w // 2, h // 2
        return [img.crop((x, y, x + hw, y + hh)) for y in (0, hh) for x in (0, hw)][:n]
    raise ValueError(f"grid of {n} not supported (use 1 to 4 ids)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pack_dir")
    ap.add_argument("--also", action="append", default=[], help="another pack whose ids get routed there")
    ap.add_argument("--size", type=int, default=512)
    args = ap.parse_args()

    pack = Path(args.pack_dir)
    raw, out = pack / "images" / "raw", pack / "images"
    if not raw.is_dir():
        sys.exit(f"No raw folder: {raw}")
    def ids_of(p):
        f = Path(p) / "items.json"
        return {i["id"] for i in json.loads(f.read_text(encoding="utf-8"))} if f.exists() else set()

    known = ids_of(pack)
    route = {}  # id -> images dir of another pack
    for other in args.also:
        for i in ids_of(other):
            route.setdefault(i, Path(other) / "images")

    done, unknown = 0, []
    for f in sorted(raw.iterdir()):
        if f.suffix.lower() not in EXTS:
            continue
        ids = f.stem.split("__")
        if ids[0] == "grid":
            ids = ids[1:]
        try:
            tiles = split(Image.open(f), len(ids))
        except ValueError as e:
            print(f"skip {f.name}: {e}")
            continue
        for item_id, tile in zip(ids, tiles):
            tile = square(trim_border(tile)).resize((args.size, args.size), Image.LANCZOS)
            dest = out if item_id in known else route.get(item_id, out)
            dest.mkdir(parents=True, exist_ok=True)
            tile.convert("RGB").save(dest / f"{item_id}.webp", "WEBP", quality=88, method=6)
            done += 1
            if item_id not in known and item_id not in route:
                unknown.append(item_id)

    print(f"{done} images written")
    if unknown and (known or route):
        print("Not in items.json (check spelling):", ", ".join(unknown))
    if known:
        missing = sorted(i for i in known if not (out / f"{i}.webp").exists())
        print(f"{len(known) - len(missing)}/{len(known)} items have art.")
        if missing:
            print("Still missing:", ", ".join(missing))


if __name__ == "__main__":
    main()

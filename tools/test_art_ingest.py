#!/usr/bin/env python3
"""Tests for tools/art_ingest.py on synthetic sheets (no real art needed).

    python3 tools/test_art_ingest.py        (or: python3 -m unittest tools/test_art_ingest.py)

Every synthetic cell gets a subject in its own hue, so a test can tell whether slice N really came
from cell N (ordering), whether the subject is whole (border of the slice is background) and centred.
"""
import colorsys
import json
import warnings
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import art_ingest as ai  # noqa: E402

EDGE = (14, 11, 20)
CENTRE = (43, 33, 64)


def hue_color(i, n):
    r, g, b = colorsys.hsv_to_rgb((i / max(1, n)) % 1.0, 0.9, 1.0)
    return int(r * 255), int(g * 255), int(b * 255)


def gradient_cell(w, h):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2) / 1.42
    r = np.clip(r, 0, 1)[..., None]
    c = np.array(CENTRE, np.float32) * (1 - r) + np.array(EDGE, np.float32) * r
    return Image.fromarray(c.astype(np.uint8), "RGB")


def subject(cell, color, frac=0.6, shape="ellipse", offset=(0, 0)):
    w, h = cell.size
    d = ImageDraw.Draw(cell)
    s = min(w, h) * frac
    cx, cy = w / 2 + offset[0], h / 2 + offset[1]
    box = [cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2]
    if shape == "ellipse":
        d.ellipse(box, fill=color, outline=(0, 0, 0), width=max(2, int(s / 40)))
    else:
        d.rectangle(box, fill=color, outline=(0, 0, 0), width=max(2, int(s / 40)))
    # A highlight + dark ink detail inside (must not be cut out).
    d.ellipse([cx - s / 8, cy - s / 8, cx + s / 16, cy + s / 16], fill=(255, 255, 255))
    d.line([cx - s / 4, cy + s / 5, cx + s / 4, cy + s / 5], fill=(5, 5, 8), width=max(2, int(s / 30)))
    return cell


def make_sheet(cols, rows, cell=(300, 300), gutters=None, margin=(0, 0, 0, 0), gutter_color=EDGE, noise=0.0,
               angle=0.0, full_bleed=False, jitter=0, seed=1, frac=0.6):
    """gutters: (list of col gutter widths, list of row gutter widths); uneven allowed."""
    rng = np.random.default_rng(seed)
    gx, gy = gutters or ([0] * (cols - 1), [0] * (rows - 1))
    cw = [cell[0] + int(rng.integers(-jitter, jitter + 1)) for _ in range(cols)]
    ch = [cell[1] + int(rng.integers(-jitter, jitter + 1)) for _ in range(rows)]
    W = margin[0] + sum(cw) + sum(gx) + margin[2]
    H = margin[1] + sum(ch) + sum(gy) + margin[3]
    sheet = Image.new("RGB", (W, H), gutter_color)
    n = cols * rows
    y = margin[1]
    for r in range(rows):
        x = margin[0]
        for c in range(cols):
            i = r * cols + c
            if full_bleed:
                im = Image.new("RGB", (cw[c], ch[r]), tuple(int(v * 0.35) for v in hue_color(i, n)))
                subject(im, hue_color(i, n), frac=0.55)
            else:
                im = subject(gradient_cell(cw[c], ch[r]), hue_color(i, n), frac=frac)
            sheet.paste(im, (x, y))
            x += cw[c] + (gx[c] if c < cols - 1 else 0)
        y += ch[r] + (gy[r] if r < rows - 1 else 0)
    if noise:
        a = np.asarray(sheet, np.float32) + rng.normal(0, noise, (H, W, 3))
        sheet = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    if angle:
        sheet = sheet.rotate(angle, resample=Image.BICUBIC, fillcolor=gutter_color)
    return sheet


def hue_of(rgb):
    h, s, v = colorsys.rgb_to_hsv(*[c / 255 for c in rgb])
    return h, s, v


def dominant(im):
    """Most saturated common colour of an image (the subject's fill)."""
    a = np.asarray(im.convert("RGB")).reshape(-1, 3)
    hsv = np.array([colorsys.rgb_to_hsv(*(p / 255)) for p in a[:: max(1, len(a) // 4000)]])
    sat = hsv[(hsv[:, 1] > 0.6) & (hsv[:, 2] > 0.6)]
    if not len(sat):
        return None
    hist, edges = np.histogram(sat[:, 0], bins=72, range=(0, 1))
    k = int(np.argmax(hist))
    return (edges[k] + edges[k + 1]) / 2


def hue_close(a, b, tol=0.04):
    d = abs(a - b) % 1.0
    return min(d, 1 - d) < tol


def make_pack(root: Path):
    pack = root / "pack"
    (pack / "images").mkdir(parents=True)
    (pack / "pack.json").write_text(json.dumps({"id": "t", "name": "T"}))
    (pack / "items.json").write_text(json.dumps([{"id": f"item_{i}", "name": f"I{i}", "rarity": "common"} for i in range(16)], indent=2))
    (pack / "monsters.json").write_text('[\n  { "id": "goblin_0", "name": "G", "hpSlots": 3, "attacks": [ { "name": "Stab", "toHit": 2, "damage": "1d4" } ] },\n  { "id": "goblin_1", "name": "G1", "image": "old.webp" }\n]\n')
    (pack / "bosses.json").write_text(json.dumps([{"id": "big_boss", "name": "Big", "phases": [{"name": "One", "image": "phase.webp"}]}], indent=2))
    (pack / "icons.json").write_text(json.dumps({"fallback": "icon_trinket", "categories": [{"id": "boots", "base": "icon_boots", "variants": [{"id": "icon_boots_winged"}]}]}))
    return pack


class Base(unittest.TestCase):
    def setUp(self):
        warnings.simplefilter("ignore", ResourceWarning)
        self.tmp = Path(tempfile.mkdtemp(prefix="art_ingest_test_"))
        self.pack = make_pack(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_sheet(self, img, cols, rows, ids, **kw):
        p = self.tmp / "sheet.png"
        img.save(p)
        rep = ai.ingest(p, "s1", self.pack, None, (cols, rows), ids, kw.pop("kind", "icon"),
                        contact=self.tmp / "contact.png", log=lambda *_: None, **kw)
        return rep

    def check_icons(self, rep, n, ids=None):
        ids = ids or [f"item_{i}" for i in range(n)]
        self.assertEqual(len(rep["slices"]), len(ids))
        for i, id_ in enumerate(ids):
            f = self.pack / "images" / f"{id_}.webp"
            self.assertTrue(f.exists(), f"{id_} written")
            im = Image.open(f).convert("RGB")
            self.assertEqual(im.size, (512, 512))
            h = dominant(im)
            want = hue_of(hue_color(i, n))[0]
            self.assertIsNotNone(h, f"{id_}: subject colour present")
            self.assertTrue(hue_close(h, want), f"{id_}: slice comes from cell {i} (hue {h:.3f} vs {want:.3f})")
            # Subject whole: the outer ring of the slice is background-dark, not subject colour.
            a = np.asarray(im, np.float32)
            ring = np.concatenate([a[:6].reshape(-1, 3), a[-6:].reshape(-1, 3), a[:, :6].reshape(-1, 3), a[:, -6:].reshape(-1, 3)])
            self.assertLess(float(np.percentile(ring.max(axis=1), 95)), 120, f"{id_}: subject not cut at the edge")
            # Roughly centred: the saturated mass's centroid near the middle.
            hsv_mask = (a.max(axis=2) - a.min(axis=2)) > 120
            ys, xs = np.nonzero(hsv_mask)
            self.assertLess(abs(xs.mean() - 256), 60, f"{id_}: centred x")
            self.assertLess(abs(ys.mean() - 256), 60, f"{id_}: centred y")
            # Fills a sensible part of the frame (bible: ~70-80 %).
            span = max(xs.max() - xs.min(), ys.max() - ys.min()) / 512
            self.assertGreater(span, 0.55, f"{id_}: subject large enough ({span:.2f})")
            self.assertLess(span, 0.97, f"{id_}: subject has padding ({span:.2f})")


class GridTests(Base):
    def test_3x3_uneven_gutters(self):
        img = make_sheet(3, 3, cell=(320, 320), gutters=([14, 30], [8, 22]))
        rep = self.run_sheet(img, 3, 3, [f"item_{i}" for i in range(9)])
        self.assertIn("gutter", rep["cuts"]["x"])
        self.check_icons(rep, 9)

    def test_4x4_noise_and_offset(self):
        img = make_sheet(4, 4, cell=(256, 256), gutters=([10, 12, 9], [11, 10, 12]), margin=(37, 12, 9, 41), noise=6, jitter=6)
        rep = self.run_sheet(img, 4, 4, [f"item_{i}" for i in range(16)])
        self.check_icons(rep, 16)

    def test_2x5_portrait_full_bleed_white_lines(self):
        img = make_sheet(2, 5, cell=(300, 400), gutters=([12], [10, 14, 10, 12]), gutter_color=(250, 250, 250), full_bleed=True)
        ids = [f"mob_{i}" for i in range(10)]
        rep = self.run_sheet(img, 2, 5, ids, kind="portrait")
        for i, id_ in enumerate(ids):
            im = Image.open(self.pack / "images" / f"{id_}.webp").convert("RGB")
            self.assertEqual(im.size, (600, 800))
            a = np.asarray(im, np.float32)
            # No white gutter line left on any edge.
            for edge in (a[:3], a[-3:], a[:, :3], a[:, -3:]):
                self.assertLess(float(edge.mean()), 200, f"{id_}: gutter trimmed")
            self.assertTrue(hue_close(dominant(im), hue_of(hue_color(i, 10))[0]), f"{id_}: order")
        self.assertEqual(sorted(rep["unknown"]), sorted(ids))

    def test_grid_transposed_automatically(self):
        img = make_sheet(2, 5, cell=(300, 300), gutters=([16], [16] * 4))
        p = self.tmp / "t.png"
        img.save(p)
        csvp = self.tmp / "SHEETS.csv"
        csvp.write_text('sheet_id,wave,grid,cell_aspect,total_px,contents,prompt\nw1,1,5x2,1:1,632x1564,' + ";".join(f"item_{i}" for i in range(10)) + ',"x"\n')
        rep = ai.ingest(p, "w1", self.pack, csvp, contact=self.tmp / "c.png", log=lambda *_: None)
        self.assertTrue(rep["transposed"])
        self.assertEqual(rep["grid"], "2x5")
        self.check_icons(rep, 10)

    def test_1x2_seamless_and_kind_from_pack(self):
        # No gutter at all: two full-bleed cells side by side, split on the seam / evenly.
        img = make_sheet(1, 2, cell=(400, 300), full_bleed=True)
        img = img.transpose(Image.Transpose.TRANSPOSE)  # 2 cols x 1 row of 300x400
        rep = self.run_sheet(img, 2, 1, ["goblin_0", "goblin_1"], kind=None)
        self.assertEqual([s["kind"] for s in rep["slices"]], ["portrait", "portrait"])
        mons = json.loads((self.pack / "monsters.json").read_text())
        self.assertEqual(mons[0]["image"], "goblin_0.webp")
        self.assertEqual(mons[1]["image"], "goblin_1.webp")
        # Formatting kept: the inline attacks array is still on one line.
        self.assertIn('"attacks": [ { "name": "Stab"', (self.pack / "monsters.json").read_text())

    def test_slight_tilt(self):
        img = make_sheet(3, 3, cell=(300, 300), gutters=([18, 18], [18, 18]), margin=(20, 20, 20, 20), angle=1.5)
        rep = self.run_sheet(img, 3, 3, [f"item_{i}" for i in range(9)])
        self.assertAlmostEqual(abs(rep["angle"]), 1.5, delta=0.3)
        self.check_icons(rep, 9)

    def test_icons_white_gutters_and_border(self):
        img = make_sheet(3, 3, cell=(300, 300), gutters=([10, 12], [12, 9]), margin=(14, 14, 14, 14), gutter_color=(245, 245, 245))
        rep = self.run_sheet(img, 3, 3, [f"item_{i}" for i in range(9)])
        self.check_icons(rep, 9)

    def test_3x3_abutting_full_bleed(self):
        img = make_sheet(3, 3, cell=(300, 400), full_bleed=True, jitter=8)
        ids = [f"m_{i}" for i in range(9)]
        rep = self.run_sheet(img, 3, 3, ids, kind="portrait")
        self.assertNotIn("even", rep["cuts"]["x"] + rep["cuts"]["y"])
        for i, id_ in enumerate(ids):
            im = Image.open(self.pack / "images" / f"{id_}.webp").convert("RGB")
            self.assertTrue(hue_close(dominant(im), hue_of(hue_color(i, 9))[0]), f"{id_}: order")
            # No strip of a neighbour's (differently tinted) background on the edges.
            a = np.asarray(im, np.float32)
            body = np.median(a[300:500, 20:60].reshape(-1, 3), axis=0)
            for edge in (a[:, :4], a[:, -4:], a[:4], a[-4:]):
                self.assertLess(float(np.abs(np.median(edge.reshape(-1, 3), axis=0) - body).max()), 20, f"{id_}: clean edge")

    def test_sparse_icons_no_visible_gutter(self):
        # Same background everywhere, small subjects: the "gutter" is just padding.
        img = make_sheet(3, 3, cell=(340, 340), frac=0.45)
        rep = self.run_sheet(img, 3, 3, [f"item_{i}" for i in range(9)])
        self.check_icons(rep, 9)

    def test_empty_cells_and_unknown(self):
        img = make_sheet(2, 2, cell=(300, 300), gutters=([12], [12]))
        rep = self.run_sheet(img, 2, 2, ["item_0", "-", "icon_boots", "nope_id"])
        ids = [s["id"] for s in rep["slices"]]
        self.assertEqual(ids, ["item_0", "icon_boots", "nope_id"])
        self.assertEqual(rep["unknown"], ["nope_id"])
        self.assertTrue((self.pack / "images" / "icon_boots.webp").exists())
        self.assertEqual(json.loads((self.pack / "items.json").read_text())[0]["image"], "item_0.webp")


class OutputTests(Base):
    def test_dry_run_writes_only_contact(self):
        img = make_sheet(2, 2, cell=(300, 300), gutters=([12], [12]))
        before = (self.pack / "items.json").read_text()
        rep = self.run_sheet(img, 2, 2, ["item_0", "item_1", "item_2", "item_3"], dry_run=True)
        self.assertEqual(list((self.pack / "images").iterdir()), [])
        self.assertEqual((self.pack / "items.json").read_text(), before)
        self.assertTrue(Path(rep["contact"]).exists())
        c = Image.open(rep["contact"])
        self.assertGreater(c.width, 400)

    def test_boss_16_9_and_square(self):
        img = Image.new("RGB", (1536, 1024), (10, 8, 16))
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, 1535, 70], fill=(0, 0, 0))  # letterbox-ish top bar
        d.ellipse([380, 250, 780, 850], fill=(255, 40, 120))  # boss left of centre (~38 %)
        p = self.tmp / "boss.png"
        img.save(p)
        rep = ai.ingest(p, "big_boss", self.pack, None, (1, 1), None, None, contact=self.tmp / "c.png", log=lambda *_: None)
        self.assertEqual(rep["slices"][0]["kind"], "boss")
        im = Image.open(self.pack / "images" / "big_boss.webp")
        self.assertEqual(im.size, (1600, 900))
        sq = Image.open(self.pack / "images" / "big_boss_sq.webp").convert("RGB")
        SQ = ai.KIND_PROFILES["boss"].sq
        self.assertEqual(sq.size, (SQ, SQ))
        a = np.asarray(sq, np.float32)
        self.assertGreater(a[SQ // 2, SQ // 2, 0], 200, "boss inside the 10-66 % square")
        b = json.loads((self.pack / "bosses.json").read_text())[0]
        self.assertEqual(b["image"], "big_boss.webp")
        self.assertEqual(b["imageSquare"], "big_boss_sq.webp")
        self.assertEqual(b["phases"][0]["image"], "phase.webp", "nested image untouched")

    def test_location_16_9(self):
        img = make_sheet(1, 1, cell=(1536, 1024), full_bleed=True)
        rep = self.run_sheet(img, 1, 1, ["loc_x"], kind="location")
        self.assertEqual(Image.open(self.pack / "images" / "loc_x.webp").size, (1920, 1080))
        self.assertEqual(rep["unknown"], ["loc_x"])

    def test_ui_cutout_and_ui_json(self):
        img = make_sheet(2, 2, cell=(300, 300), gutters=([14], [14]))
        ids = ["system_smug", "loot_gold_closed", "cond_bleeding", "bg_arena_f1"]
        rep = self.run_sheet(img, 2, 2, ids, kind=None)
        self.assertEqual({s["kind"] for s in rep["slices"]}, {"ui"})
        m = Image.open(self.pack / "images" / "ui" / "system_smug.webp")
        self.assertEqual(m.mode, "RGBA")
        a = np.asarray(m)
        self.assertLess(int(a[2, 2, 3]), 30, "corner transparent")
        cy, cx = a.shape[0] // 2, a.shape[1] // 2
        self.assertEqual(int(a[cy, cx, 3]), 255, "subject opaque")
        # Dark ink line inside the subject stays opaque (not keyed away).
        yy, xx = np.mgrid[0:a.shape[0], 0:a.shape[1]]
        ink = (a[..., :3].max(axis=2) < 40) & (np.hypot(yy - cy, xx - cx) < a.shape[0] * 0.3)
        self.assertGreater(int(ink.sum()), 50, "test sees the ink line")
        self.assertGreater(float(a[..., 3][ink].mean()), 200)
        self.assertTrue((self.pack / "images" / "ui" / "system_smug_bg.webp").exists(), "dark-gradient version kept")
        ui = json.loads((self.pack / "ui.json").read_text())
        self.assertEqual(ui["mascot"]["smug"], "ui/system_smug.webp")
        self.assertEqual(ui["lootBoxes"]["gold"]["closed"], "ui/loot_gold_closed.webp")
        self.assertEqual(ui["conditions"]["bleeding"], "ui/cond_bleeding.webp")
        self.assertEqual(ui["floors"]["1"]["combat"], "ui/bg_arena_f1.webp")

    def test_icon_cutout_flag(self):
        img = make_sheet(1, 1, cell=(512, 512))
        self.run_sheet(img, 1, 1, ["item_0"], cut=True)
        self.assertEqual(Image.open(self.pack / "images" / "item_0.webp").mode, "RGB")
        self.assertEqual(Image.open(self.pack / "images" / "item_0_cut.webp").mode, "RGBA")

    def test_ui_slot_mapping(self):
        u = ai.ui_slot
        self.assertEqual(u("logo_emblem"), ("logo",))
        self.assertEqual(u("logo_emblem_b"), ("logoOptions", "b"))
        self.assertEqual(u("system_neutral"), ("mascot", "neutral"))
        self.assertEqual(u("system_glitch_anim"), ("mascot", "glitch"))
        self.assertEqual(u("system_talk"), ("mascot", "talking"))
        self.assertEqual(u("loot_sponsor_closed"), ("lootBoxes", "sponsor", "closed"))
        self.assertEqual(u("loot_legendary_rattle"), ("lootBoxes", "legendary", "idle"))
        self.assertEqual(u("die_d20"), ("dice", "d20", "body"))
        self.assertEqual(u("die_d20_nat20"), ("dice", "d20", "nat20"))
        self.assertEqual(u("cond_sponsors_blessing"), ("conditions", "sponsors_blessing"))
        self.assertEqual(u("cond_generic"), ("conditions", "default"))
        self.assertEqual(u("fin_victory"), ("finale", "victory"))
        self.assertEqual(u("medal_death_adjacent"), ("medals", "death_adjacent"))
        self.assertEqual(u("sponsor_cryo_cola"), ("sponsors", "cryo_cola"))
        self.assertEqual(u("orn_legendary"), ("rarityFrames", "legendary"))
        self.assertEqual(u("fx_impact"), ("fx", "impact"))
        self.assertEqual(u("fx_fire_anim"), ("fx", "fire"))
        self.assertEqual(u("bg_studio"), ("floors", "default", "lobby"))
        self.assertEqual(u("bg_arena_f0"), ("floors", "0", "combat"))
        self.assertEqual(u("stinger_boss"), ("stingers", "boss"))
        self.assertIsNone(u("goblin"))

    def test_json_edit_keeps_formatting(self):
        f = self.tmp / "b.json"
        src = '[\n  { "id": "a", "name": "A",\n    "phases": [ { "name": "One" }, { "name": "Two", "image": "x.webp" } ],\n    "attacks": [ { "n": 1 } ] }\n]\n'
        f.write_text(src)
        self.assertTrue(ai.set_json_paths(f, [((0, "image"), "a.webp"), ((0, "phases", 0, "image"), "p1.webp"), ((0, "phases", 1, "image"), "p2.webp")]))
        out = f.read_text()
        self.assertIn('"attacks": [ { "n": 1 } ]', out)
        d = json.loads(out)
        self.assertEqual(d[0]["image"], "a.webp")
        self.assertEqual([p["image"] for p in d[0]["phases"]], ["p1.webp", "p2.webp"])
        self.assertFalse(ai.set_json_paths(f, [((0, "image"), "a.webp")]), "no change → no write")


class CsvTests(Base):
    """Rows in the art director's SHEETS.csv format."""
    HEAD = "order,sheet_id,wave,type,title,grid,canvas,cell_aspect,total_px,bg,anchor,contents,output,prompt\n"

    def csv(self, *rows):
        p = self.tmp / "art" / "SHEETS.csv"
        p.parent.mkdir(exist_ok=True)
        with open(p, "w", newline="") as f:
            f.write(self.HEAD)
            import csv as _csv
            w = _csv.writer(f)
            for r in rows:
                w.writerow(r)
        return p

    def chroma_sheet(self, cols, rows, key=(0, 255, 0), cell=300, n=None):
        img = Image.new("RGB", (cols * cell, rows * cell), key)
        d = ImageDraw.Draw(img)
        for i in range(n or cols * rows):
            x, y = (i % cols) * cell, (i // cols) * cell
            fills = [(230, 30, 40), (255, 140, 0), (240, 40, 200), (40, 80, 255), (150, 40, 230), (255, 225, 0), (255, 255, 255), (120, 60, 20), (0, 200, 255)]
            d.ellipse([x + 70, y + 60, x + 230, y + 240], fill=fills[i % len(fills)], outline=(0, 0, 0), width=8)
            d.rectangle([x + 140, y + 140, x + 160, y + 160], fill=key)  # key colour *inside* the subject
        return img

    def test_chroma_loot_row(self):
        csvp = self.csv(["3", "LOOT-01", "1", "loot_box", "Loot", "3x2", "3:2", "1:1", "1536x1024", "chroma green #00FF00", "",
                         "loot_bronze_closed | loot_silver_closed | loot_gold_closed | loot_bronze_open | loot_silver_open | loot_gold_open",
                         "images/ui/<id>.webp 512x512 alpha", "p"])
        p = self.tmp / "loot.png"
        self.chroma_sheet(3, 2).save(p)
        rep = ai.ingest(p, "LOOT-01", self.pack, csvp, contact=self.tmp / "c.png", log=lambda *_: None)
        self.assertEqual(len(rep["slices"]), 6)
        im = Image.open(self.pack / "images" / "ui" / "loot_gold_open.webp")
        self.assertEqual(im.size, (512, 512))
        a = np.asarray(im.convert("RGBA")).astype(int)
        self.assertEqual(int(a[5, 5, 3]), 0, "key removed")
        ys, xs = np.nonzero(a[..., 3] > 128)
        self.assertTrue(0.4 < (xs.max() - xs.min()) / 512 < 0.75, "whole-cell framing kept (not a tight crop)")
        self.assertEqual(int(a[256, 256, 3]), 255, "key-coloured hole inside the subject survives")
        vis = a[..., 3] > 128
        green = (a[..., 1] > a[..., 0] + 60) & (a[..., 1] > a[..., 2] + 60) & vis
        hole = np.zeros_like(green)
        hole[200:320, 200:320] = True  # the key-coloured square inside the subject (kept on purpose)
        self.assertLess(int((green & ~hole).sum()), 40, "no green fringe left")
        self.assertFalse((self.pack / "images" / "ui" / "loot_gold_open_bg.webp").exists(), "no _bg for chroma sheets")
        ui = json.loads((self.pack / "ui.json").read_text())
        self.assertEqual(ui["lootBoxes"]["silver"]["open"], "ui/loot_silver_open.webp")

    def test_frame_grid_fallback_and_anchor(self):
        prompt = "FRAMES: 8 frames, total about 0.8 s, a seamless loop. ALTERNATIVE: ONE still image of 8 key frames in a 4 columns x 2 rows grid"
        csvp = self.csv(["8", "ANIM-02", "1", "animation", "talk", "GIF 8f", "1:1", "1:1", "512x512+", "chroma green #00FF00", "",
                         "system_talk", "images/anim/system_talk.webp (animated, alpha) + system_talk_0.webp (still) + system_talk_strip.webp + .json", prompt],
                        ["6", "SYS-01", "1", "mascot", "m", "3x3", "1:1", "1:1", "2048x2048", "chroma green #00FF00", "",
                         "system_neutral | system_smug | system_delighted | system_angry | system_bored | system_suspicious | system_glitch | system_shocked | system_fake_sad",
                         "images/ui/<id>.webp 512x512 alpha (cell 1 = mascot_model.png)", "p"])
        # A still in the fallback layout: 8 frames, the subject jitters a few px from cell to cell.
        img = Image.new("RGB", (4 * 256, 2 * 256), (0, 255, 0))
        d = ImageDraw.Draw(img)
        for i in range(8):
            x, y = (i % 4) * 256 + (i % 3) * 4, (i // 4) * 256 + (i % 2) * 5
            d.ellipse([x + 60, y + 60, x + 196, y + 196], fill=(200, 40, 220), outline=(0, 0, 0), width=6)
            d.rectangle([x + 100, y + 150, x + 156, y + 150 + (i % 4) * 6 + 2], fill=(20, 230, 255))  # the "mouth"
        p = self.tmp / "talk.png"
        img.save(p)
        rep = ai.ingest(p, "ANIM-02", self.pack, csvp, contact=self.tmp / "c.png", log=lambda *_: None)
        self.assertTrue(rep["frame_grid"])
        s = rep["slices"][0]
        self.assertEqual(s["frames"], 8)
        anim = Image.open(self.pack / "images" / "anim" / "system_talk.webp")
        self.assertTrue(anim.is_animated)
        self.assertEqual(anim.size, (ai.MASCOT_EDGE, ai.MASCOT_EDGE))
        meta = json.loads((self.pack / "images" / "anim" / "system_talk.json").read_text())
        self.assertEqual(meta["frames"], 8)
        self.assertTrue(meta["loop"])
        self.assertAlmostEqual(meta["fps"], 10, delta=0.5)
        strip = Image.open(self.pack / "images" / "anim" / "system_talk_strip.webp")
        self.assertEqual(strip.size, (8 * ai.MASCOT_EDGE, ai.MASCOT_EDGE))
        # Aligned: the subject's centre is in the same place in every frame (±2 px).
        cs = []
        for k in range(8):
            fr = np.asarray(strip.crop((k * ai.MASCOT_EDGE, 0, (k + 1) * ai.MASCOT_EDGE, ai.MASCOT_EDGE)))
            ys, xs = np.nonzero(fr[..., 3] > 128)
            cs.append((xs.mean(), ys.mean()))
        cs = np.array(cs)
        self.assertLess(float(np.ptp(cs[:, 0])), 3)
        ui = json.loads((self.pack / "ui.json").read_text())
        self.assertEqual(ui["mascot"]["talking"]["strip"], "anim/system_talk_strip.webp")
        self.assertEqual(ui["mascot"]["talking"]["still"], "anim/system_talk_0.webp")
        # Then the SYS-01 sheet: style anchor (cell 1) saved next to SHEETS.csv.
        q = self.tmp / "sys.png"
        self.chroma_sheet(3, 3).save(q)
        rep = ai.ingest(q, "SYS-01", self.pack, csvp, contact=self.tmp / "c2.png", log=lambda *_: None)
        self.assertTrue((self.tmp / "art" / "mascot_model.png").exists())
        w, h = Image.open(self.tmp / "art" / "mascot_model.png").size
        self.assertLess(abs(w - 300) + abs(h - 300), 24)
        ui = json.loads((self.pack / "ui.json").read_text())
        self.assertEqual(ui["mascot"]["neutral"], "ui/system_neutral.webp")

    def test_boss_states_and_reference_cells(self):
        csvp = self.csv(["26", "BST-01", "2", "boss_state", "b", "2x2", "1:1", "1:1", "2048x2048", "violet gradient per cell", "",
                         "big_boss_p1 | big_boss_ko | big_boss_p9 | stray_ref", "images/<id>.webp 768x768", "p"])
        p = self.tmp / "bst.png"
        make_sheet(2, 2, cell=(400, 400), gutters=([16], [16])).save(p)
        rep = ai.ingest(p, "BST-01", self.pack, csvp, contact=self.tmp / "c.png", log=lambda *_: None)
        b = json.loads((self.pack / "bosses.json").read_text())[0]
        self.assertEqual(b["phases"][0]["image"], "big_boss_p1.webp")
        self.assertEqual(b["imageKo"], "big_boss_ko.webp")
        self.assertEqual(Image.open(self.pack / "images" / "big_boss_p1.webp").size, (768, 768))
        self.assertIn("big_boss_p9", rep["unknown"], "no phase 9 → reported")
        self.assertFalse((self.pack / "images" / "stray_ref.webp").exists(), "_ref cells are not saved")


class AnimTests(Base):
    def make_gif(self, n=12, dup=3, cols=1, rows=1):
        frames = []
        for k in range(n):
            sheet = Image.new("RGB", (300 * cols + 12 * (cols - 1), 300 * rows), EDGE)
            for c in range(cols):
                cell = gradient_cell(300, 300)
                d = ImageDraw.Draw(cell)
                x = 90 + (k // dup) * 12  # moves every `dup` frames → duplicates to drop
                d.ellipse([x, 100, x + 90, 190], fill=hue_color(c, 4), outline=(0, 0, 0), width=3)
                sheet.paste(cell, (c * 312, 0))
            sheet.putpixel((k % 5, 0), (k * 3 % 255, 0, 0))  # never byte-identical (GIF writer would merge)
            frames.append(sheet.convert("P", palette=Image.Palette.ADAPTIVE))
        p = self.tmp / "anim.gif"
        frames[0].save(p, save_all=True, append_images=frames[1:], duration=80, loop=0)
        return p

    def test_animated_gif(self):
        p = self.make_gif()
        rep = ai.ingest(p, "a1", self.pack, None, (1, 1), ["system_talk"], None, contact=self.tmp / "c.png", log=lambda *_: None)
        self.assertTrue(rep["animated"])
        s = rep["slices"][0]
        self.assertEqual(s["frames"], 4, "12 frames, every 3 identical → 4")
        out = Image.open(self.pack / "images" / "anim" / "system_talk.webp")
        self.assertTrue(getattr(out, "is_animated", False))
        self.assertEqual(out.n_frames, 4)
        # One crop for all frames: every frame has the same size, and the moving ball is never cut.
        sizes = set()
        for k in range(out.n_frames):
            out.seek(k)
            sizes.add(out.size)
        self.assertEqual(len(sizes), 1)
        self.assertTrue((self.pack / "images" / "anim" / "system_talk_strip.webp").exists())
        st = Image.open(self.pack / "images" / "anim" / "system_talk_0.webp")
        self.assertFalse(getattr(st, "is_animated", False))
        ui = json.loads((self.pack / "ui.json").read_text())
        self.assertEqual(ui["mascot"]["talking"]["src"], "anim/system_talk.webp")
        self.assertEqual(ui["mascot"]["talking"]["still"], "anim/system_talk_0.webp")
        self.assertEqual(ui["mascot"]["talking"]["frames"], 4)
        self.assertLess(s["bytes"], ai.ANIM_TARGET)

    def test_animated_grid_and_cap(self):
        p = self.make_gif(n=30, dup=1, cols=2)
        rep = ai.ingest(p, "a2", self.pack, None, (2, 1), ["item_0", "item_1"], "icon", contact=self.tmp / "c.png", max_frames=8, log=lambda *_: None)
        self.assertEqual(json.loads((self.pack / "items.json").read_text())[1]["image"], "item_1.webp")
        for s in rep["slices"]:
            self.assertLessEqual(s["frames"], 8)
            im = Image.open(self.pack / "images" / f"{s['id']}.webp")
            self.assertEqual(im.size, (512, 512))
            self.assertTrue(im.is_animated)

    def test_identical_frames_become_still(self):
        p = self.make_gif(n=4, dup=10)
        rep = ai.ingest(p, "a3", self.pack, None, (1, 1), ["item_3"], "icon", contact=self.tmp / "c.png", log=lambda *_: None)
        self.assertIn("all frames identical: saved as a still", rep["slices"][0]["warnings"])
        self.assertFalse(getattr(Image.open(self.pack / "images" / "item_3.webp"), "is_animated", False))


class CliTests(Base):
    def test_cli_with_csv_default_location(self):
        art = self.tmp / "art"
        art.mkdir()
        # <pack>/../../art/SHEETS.csv → put the pack at tmp/packs/x
        packs = self.tmp / "packs"
        packs.mkdir()
        shutil.move(str(self.pack), str(packs / "x"))
        pack = packs / "x"
        (art / "SHEETS.csv").write_text('sheet_id,wave,grid,cell_aspect,total_px,contents,prompt\nicons_01,1,2x2,1:1,1024x1024,item_0;item_1;item_2;item_3,"p"\n')
        img = make_sheet(2, 2, cell=(500, 500), gutters=([24], [24]))
        p = self.tmp / "in.png"
        img.save(p)
        rep = ai.main([str(p), "--sheet", "icons_01", "--pack", str(pack), "--contact", str(self.tmp / "c.png")])
        self.assertEqual(len(rep["slices"]), 4)
        self.assertEqual(json.loads((pack / "items.json").read_text())[3]["image"], "item_3.webp")


if __name__ == "__main__":
    unittest.main(verbosity=2)

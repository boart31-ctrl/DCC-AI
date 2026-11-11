# Art pipeline: bulk sheets → pack

How generated art gets from a chat image to the TV with almost no hand work. The GM generates **bulk sheets**
(nine monsters in a 3x3 grid, item icons, one boss splash, a GIF) from the prompts in the private repo's
`art/SHEETS.csv`. They send each one to Claude in chat with its `sheet_id`. Claude slices, cleans, converts and wires it
into the pack with `tools/art_ingest.py`, checks a contact sheet, and pushes. Cloudflare then redeploys.

```
image + sheet_id ─► art_ingest --dry-run ─► look at contact sheet ─► art_ingest ─► validate ─► commit + push ─► Cloudflare build
                         ▲                         │ wrong?
                         └── fix flags / ask GM ───┘
```

## 0. Once per session

```bash
pip install --break-system-packages pillow numpy      # usually present already
cd /home/claude/dcc-ai                                # public engine (this repo)
PACK=/home/claude/dcc-ai-private/packs/dcc            # private pack
mkdir -p /home/claude/work/art/in                     # incoming images + contact sheets (not committed)
```

`art_ingest.py` finds `SHEETS.csv` at `<pack>/../../art/SHEETS.csv` by itself; pass `--csv` for any other path.

## 1. Receive

Save the image the GM sent as `/home/claude/work/art/in/<sheet_id>.<png|webp|jpg|gif>`. Keep the original
format: a GIF must stay a GIF, because its frames are the animation. If the GM did not say which sheet it is,
ask. The sheet_id decides the grid, the ids and their order, the output sizes and where everything is wired.

## 2. Dry run and contact sheet

```bash
python3 tools/art_ingest.py /home/claude/work/art/in/MON-01.png --sheet MON-01 --pack $PACK --dry-run
```

It prints one line per slice (id, kind, size, target) and writes `/home/claude/work/art/<sheet_id>_contact.png`.
Open the contact sheet with the image viewer (the Read tool) and check:

| Look at | Good | If not |
|---|---|---|
| Header: `grid CxR`, `cuts:` | `gutter` or `seam` for every cut. `even` is fine only when cells really are equal | wrong grid → `--grid 3x3`; a `(transposed)` note you disagree with → pass `--grid` |
| Yellow boxes over the source | one per cell, on the gaps between subjects | uneven or tilted sheet, see "Detection" below; worst case ask for a regenerate |
| Cyan boxes | around each subject with air, nothing cut off | subject cut → `--tol 30` (faint subject) or `--tol 55` (noisy background) |
| Tile order and ids | tile N shows the subject the CSV lists as id N | model drew them in another order → `--ids a,b,c,...` (use `-` for an empty cell) |
| Cut-outs (checkerboard tiles) | clean edge at the black ink, no green / blue halo, key-coloured details inside kept | halo → `--tol` up a bit; holes in the subject → ask for a thicker ink outline |
| Tile border colour | green = written and wired; amber = note (upscaled, unknown id); red = problem | read the warning under the tile |
| Animations (strip at the bottom) | frames in order, subject steady, loop / once as the sheet says | drift or a jump → ask for the frame-grid ALTERNATIVE from the prompt (see 5) |

Upscale notes (`upscaled x1.7`) mean the cell was smaller than the target. Acceptable up to about x1.5, after that
ask the GM for a bigger canvas (the CSV `total_px` column says what to aim for).

## 3. Ingest

Same command without `--dry-run`. It writes the WebP files under `<pack>/images/` and edits the JSON:

- `items.json`, `monsters.json`, `npcs.json`, `locations.json`, `bosses.json`: the entry with that id gets
  `"image"` (bosses also `"imageSquare"`; `<boss>_p1..pN` → `phases[N-1].image`, `<boss>_ko` → `"imageKo"`).
  Edits are surgical: the rest of the file keeps its formatting.
- `icons.json` ids: nothing to edit; the file name *is* the link (`images/<icon id>.webp`). Items that point at
  that icon (`"icon"` / `"iconCategory"`) pick it up automatically.
- everything else goes into `ui.json` (see the id table below).
- ids the pack does not know: the file is still written and listed under "Unknown ids". Usually a typo in the
  CSV or a new monster or NPC the pack has no entry for yet. Add the entry (with `"image": "<id>.webp"`) or rename.
- Style anchors (`ICO-01`, `BOSS-01`, `LOOT-01`, `MON-01`, `LOC-01`, `SYS-01` cell 1) are also saved next to
  `SHEETS.csv` (`style_anchor_*.png`, `mascot_model.png`), as SHEETS.md asks.

Re-running a sheet overwrites its files. That is the way to apply a fix.

## 4. Validate, commit, push

```bash
node tools/build_cloud.mjs $PACK /tmp/check-build     # same loader as production; prints pack warnings
python3 tools/test_art_ingest.py                      # only if the tool itself was changed
cd /home/claude/dcc-ai-private
git add packs/dcc/images packs/dcc/*.json art/*.png
git commit -m "Art: MON-01 monster portraits"
git push                                              # Cloudflare builds and deploys in about a minute
```

`build_cloud` must end with `build_cloud: <pack> ... → /tmp/check-build`. A warning such as
`ui mascot.angry: images/ui/system_angry.webp not found` means a JSON points at a file that is not there yet.
Nothing breaks (the TV keeps its CSS look there), but check whether a sheet was skipped.
If you changed the engine (this repo), push it first, then run `npm run update-engine` in the private repo and
commit its `package-lock.json`, so the deploy uses the new engine.

## 5. Animations

Input can be a GIF or animated WebP (ChatGPT GIF output), or, when the GIF drifts, the **frame-grid fallback**
every animation prompt offers ("ONE still image of 8 key frames in a 4 columns x 2 rows grid"). Send either one
with the animation's sheet_id. The tool notices a still for an animation row, reads the grid from the prompt
(override with `--grid 4x2`), slices the frames and aligns them on the subject's centre.

GIF frames are composited (GIF transparency becomes the key colour), cropped with one union box over all frames
(so the subject never jumps), deduplicated (consecutive identical frames merge their durations), capped
(`--max-frames`, default 24), keyed to alpha, and written as:

| file | used by |
|---|---|
| `anim/<id>.webp` | animated WebP, loops (or plays once when the prompt says "plays once") |
| `anim/<id>_0.webp` | first frame: reduced motion, phones, GM desk |
| `anim/<id>_strip.webp` + `anim/<id>.json` | horizontal sprite strip + `{frames, fps, w, h, loop}`; the TV animates it with `transform` + `steps()` |

The animated file is squeezed toward 400 KB (lower quality, then every other frame). Above 1.5 MB you get a
warning: the TV may stutter. Mascot animations are 384 px, others up to 512 px. In `ui.json` the animation lands on
its slot and keeps an earlier still of that slot as its `still` (for example `system_talk` → `mascot.talking`).

## Detection, in short

1. **Deskew.** Sheets are rotated in 0.25° steps (±3°, then refined). The angle that makes the most uniform
   rows / columns sharpest wins, but only if it clearly beats 0°.
2. **Gutter profile.** For every column (and row): how much of it differs from the sheet's border colour,
   and how much it varies along its length. Both are normalised; the gutter score is the lower one. So a dark
   gap, a white line, a coloured gutter and the empty space between sparse subjects on a shared background all
   count as gutters.
3. **Snap to N×M.** The grid comes from the CSV (`COLSxROWS`; the transpose is used when it clearly fits the image
   and `cell_aspect` better). Each cut is searched within ±30 % of a cell around its expected spot, measured
   from the previous cut, so uneven cells do not add up. Best gutter → its centre. No gutter → the strongest
   colour seam (abutting full-bleed pictures). Neither → even division.
4. **Per cell.** Uniform edge strips in a colour foreign to the cell are trimmed (half gutters, borders,
   letterbox bars). A quadratic background model is fitted to the cell's border ring (dark radial gradients, flat
   chroma green or blue). The subject is everything that differs by more than `--tol`, after a 3 px opening that
   drops noise.
5. **Crop modes.** `subject` (icons, condition icons): a box of the target aspect around the subject, subject ≈ 80 %
   of the frame, padded with background when the cell is too tight. `fill` (portraits, splashes, locations,
   chroma cut-outs like crates, mascot moods and medals): the largest target-aspect box inside the cell, so every
   cell of a set keeps the same framing. Portraits centre horizontally on the subject. Bosses: a 16:9 splash
   plus `_sq`, a full-height square from 10 % to 66 % of the width (ART_BIBLE "1:1 crop rule").
6. **Alpha.** A flood fill of "close to the background" from the cell border that stops at the black ink, a soft
   edge between 0.6×tol and 1.4×tol, and for chroma keys a 1 px choke, a 3 px median against GIF dither, and
   despill (the key channel is clamped to the other two near the edge). Key-coloured pixels inside the subject
   are not touched. Non-chroma cut-outs also keep the dark-gradient version as `<id>_bg.webp`.

## Profiles (from `SHEETS.csv` `type`; the `output` column overrides size, folder and alpha)

| type | crop | default size | folder | alpha |
|---|---|---|---|---|
| icon | subject | 512² | `images/` | no (`--cutout` adds `_cut.webp`) |
| condition | subject | 256² | `ui/` | no |
| monster, npc | fill 3:4 | 768×1024 | `images/` | no |
| monster_family, avatar | fill 3:4 | 512×683 | `images/`, `ui/` | no |
| boss | fill 16:9 + square | 1920×1080 + 864² (no CSV: 1600×900 + 864²) | `images/` | no |
| boss_state | fill 1:1 | 768² | `images/` | no |
| location, background | fill 16:9 | 1920×1080 | `images/` | no |
| stinger | fill 16:9 | 1920×1080 | `ui/` | no |
| loot_box, mascot, spot, logo, dice, medal, sponsor | fill 1:1 | 512² | `ui/` | yes (key from `bg`) |
| vfx_decal | fill 1:1 | 512² | `fx/` | yes |
| ui_ornament | fill 1:1 | 256² | `ui/` | yes |
| animation | subject (union of frames) | 512² (mascot 384²) | `anim/` | yes |

Without a CSV row: `--kind icon|portrait|boss|location|ui|anim`, else the kind is guessed from the pack (which file
knows the id) and the cell aspect.

## Ids → where they are wired

| id pattern | goes to |
|---|---|
| item / monster / npc / location / boss id | that entry's `image` (boss + `imageSquare`) |
| `<boss>_p<N>`, `<boss>_ko` | `bosses.json` `phases[N-1].image`, `imageKo` |
| `icon_*` (in icons.json) | file name only |
| `system_<mood>`, `system_<x>_anim`, `system_talk` / `system_idle` / `system_laugh` | `ui.json mascot.<mood>` (`talking`, `idle`, `laughing`) |
| `loot_<tier>_<closed\|open\|opening\|rattle>` | `lootBoxes.<tier>.<state>` (`rattle` → `idle`) |
| `die_<dN>`, `die_<dN>_<skin>` | `dice.<dN>.body`, `dice.<dN>.<skin>` |
| `cond_<buff id>`, `cond_generic` | `conditions.<buff id>`, `conditions.default` |
| `fin_<outcome>`, `fin_mvp` | `finale.<outcome>`, `finale.mvp` |
| `medal_<group>`, `medal_generic` | `medals.<group slug>`, `medals.default` |
| `sponsor_<id>` | `sponsors.<id>` |
| `orn_<rarity>` | `rarityFrames.<rarity>` |
| `fx_<name>`, `fx_<name>_anim` | `fx.<name>` |
| `bg_arena_f<N>`, `bg_<scene>_f<N>`, `bg_studio` | `floors.<N>.combat`, `floors.<N>.<scene>`, `floors.default.lobby` |
| `logo_emblem`, `logo_emblem_<x>` | `logo`, `logoOptions.<x>` (GM picks: re-run that cell with `--ids` as `logo_emblem`, or edit ui.json) |
| `stinger_*`, `empty_*`, `avatar_*`, `amb_*`, `coin_spin`, `sponsor_seal_sting` | `stingers`, `empty`, `avatars`, `anim`, `fx.coin`, `fx.sponsor_sting` (stored; not displayed yet) |
| `*_ref` | reference cell: shown on the contact sheet, never saved |

## Flags

| flag | meaning |
|---|---|
| `--csv PATH` | SHEETS.csv (default `<pack>/../../art/SHEETS.csv`) |
| `--grid CxR` | columns x rows, overrides the CSV (for an animation still: its frame grid) |
| `--ids a,b,-,d` | ids in reading order (`,` `;` or `\|`), `-` skips a cell |
| `--kind K` | force a profile for every slice |
| `--cutout` / `--no-cutout` | icons: also write a transparent `_cut.webp` / never key to alpha |
| `--tol N` | background distance (default 40) |
| `--max-frames N` | animation frame cap (default 24) |
| `--contact PATH` | contact sheet path (default `$ART_WORK_DIR` or `/home/claude/work/art`) |
| `--json` | machine-readable report |

## Tests

`python3 tools/test_art_ingest.py` builds synthetic sheets and checks the results: 3x3 with uneven gutters,
4x4 with noise, jitter and margins, 2x5 full-bleed with white lines, 3x3 abutting cells (seams), 1x2 without
gutters, a 1.5° tilt, sparse icons, a transposed grid, chroma-key crates (key-coloured detail inside kept, no
fringe), boss splash + square, boss phases, animated GIF (duplicates dropped, one crop, still + strip), frame
cap, frame-grid fallback with alignment, JSON edits that keep formatting, and ui.json slots.

#!/usr/bin/env python3
"""Sound pads from recordings / ElevenLabs Sound Effects into a pack (audio/sfx/ + sfx.json).

    python3 tools/sfx_ingest.py list   --pack <packDir> --plan <sfx_plan.json> --out <SFX_LIST.md>
    python3 tools/sfx_ingest.py ingest <audio>... --pack <packDir> --plan <sfx_plan.json>
                                       [--start 1 | --only id,id] [--dry-run]
    python3 tools/sfx_ingest.py status --pack <packDir> --plan <sfx_plan.json>

sfx_plan.json: { "pads": [{ id, label, group, route (front|rear|center|all), sub (0..1), secs, prompt, replace? }] }.
`replace: true` = same id as a built-in (synthesised) pad, which it overrides; its Shift hotkey is kept.

ingest  Files named <id>.<ext> go to that pad. Otherwise files are sorted by the timestamp in their name
        (or by name) and mapped onto the plan in order, from --start (1-based) or onto the --only ids.
        Each file: leading/trailing silence trimmed (keeps the tail of a reverb), 8 ms fade-in /
        60 ms fade-out, stereo kept, loudness normalised (EBU R128, -16 LUFS short sounds use peak),
        true peak -1 dBTP, mp3 192 kbps → <pack>/audio/sfx/<id>.mp3; sfx.json upserted (label, group,
        route, sub). --dry-run prints the mapping and measurements only.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(2)


def ff() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        die("ffmpeg not found")
    return exe


def load_plan(p: Path) -> list[dict]:
    if not p.exists():
        die(f"{p} missing")
    pads = json.loads(p.read_text(encoding="utf-8")).get("pads", [])
    ids = [x["id"] for x in pads]
    if len(ids) != len(set(ids)):
        die("duplicate ids in plan")
    return pads


def stamp(p: Path):
    m = re.search(r"\d{4}-\d\d-\d\dT\d\d_\d\d_\d\d", p.name)
    return (m.group(0) if m else "~", p.name)


def probe(path: Path) -> dict:
    r = subprocess.run([ff(), "-hide_banner", "-i", str(path), "-af", "silencedetect=n=-50dB:d=0.15,ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True)
    err = r.stderr
    dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    secs = int(dur.group(1)) * 3600 + int(dur.group(2)) * 60 + float(dur.group(3)) if dur else 0.0
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", err)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", err)]
    lufs = re.findall(r"I:\s+(-?[\d.]+) LUFS", err)
    peak = re.findall(r"Peak:\s+(-?[\d.]+) dBFS", err)
    # leading silence = a silence that starts at ~0; trailing = one that never ends or ends at the end
    lead = ends[0] if starts and starts[0] < 0.02 and ends else 0.0
    tail = secs
    if starts and (len(starts) > len(ends) or (ends and ends[-1] >= secs - 0.05)):
        tail = starts[-1]
    if tail <= lead:
        lead, tail = 0.0, secs
    return {"secs": secs, "lead": lead, "tail": tail, "lufs": float(lufs[-1]) if lufs else None, "peak": float(peak[-1]) if peak else None}


def render(src: Path, out: Path, m: dict) -> None:
    a = max(0.0, m["lead"] - 0.02)
    b = min(m["secs"], m["tail"] + 0.35)  # keep a little of the decay
    length = max(0.1, b - a)
    fo = min(0.06, length / 4)
    chain = [f"atrim=start={a:.3f}:end={b:.3f}", "asetpts=N/SR/TB", "afade=t=in:d=0.008",
             f"afade=t=out:st={max(0.0, length - fo):.3f}:d={fo:.3f}"]
    if length >= 1.0:
        chain.append("loudnorm=I=-16:TP=-1:LRA=11")
    else:  # too short for an integrated measurement: peak-normalise
        gain = -1.0 - (m["peak"] if m["peak"] is not None else -1.0)
        chain.append(f"volume={gain:.2f}dB")
    out.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run([ff(), "-v", "error", "-y", "-i", str(src), "-af", ",".join(chain), "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k", str(out)],
                       capture_output=True, text=True)
    if r.returncode:
        die(f"ffmpeg failed on {src.name}: {r.stderr[:300]}")


def upsert(pack: Path, done: list[dict]) -> None:
    p = pack / "sfx.json"
    cur = json.loads(p.read_text(encoding="utf-8")) if p.exists() else []
    by = {e["id"]: e for e in cur}
    for d in done:
        e = by.get(d["id"]) or {"id": d["id"]}
        e.update({"label": d["label"], "file": f"{d['id']}.mp3", "group": d.get("group", ""), "route": d.get("route", "front"), "sub": d.get("sub", 0)})
        if d["id"] not in by:
            cur.append(e)
            by[d["id"]] = e
    p.write_text(json.dumps(cur, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def cmd_ingest(a) -> None:
    pack, plan = Path(a.pack), load_plan(Path(a.plan))
    ids = {x["id"]: x for x in plan}
    files = [Path(f) for f in a.audio]
    for f in files:
        if not f.exists():
            die(f"{f} not found")
    named = all(f.stem in ids for f in files)
    if named:
        pairs = [(f, ids[f.stem]) for f in files]
    else:
        files.sort(key=stamp)
        if a.only:
            want = [i.strip() for i in a.only.split(",") if i.strip()]
            bad = [i for i in want if i not in ids]
            if bad:
                die(f"not in plan: {', '.join(bad)}")
            targets = [ids[i] for i in want]
        else:
            targets = plan[a.start - 1:]
        if len(files) > len(targets):
            die(f"{len(files)} files but only {len(targets)} pads from #{a.start}")
        if a.only and len(files) != len(targets):
            die(f"{len(files)} files for {len(targets)} --only ids")
        pairs = list(zip(files, targets))
    print(f"{'#':>3}  {'pad':22} {'file':42} {'secs':>5} {'trim→':>6} {'LUFS':>6}  route/sub")
    meas = []
    for n, (f, pad) in enumerate(pairs, 1):
        m = probe(f)
        meas.append(m)
        want = pad.get("secs") or 0
        flag = "  DLOUHÉ?" if want and m["tail"] - m["lead"] > want * 2.5 + 1 else ""
        print(f"{n:>3}  {pad['id']:22} {f.name[-42:]:42} {m['secs']:5.1f} {m['tail'] - m['lead']:6.1f} {m['lufs'] if m['lufs'] is not None else '':>6}  {pad.get('route', 'front')}/{pad.get('sub', 0)}{flag}")
    if a.dry_run:
        print("dry run: nothing written")
        return
    for (f, pad), m in zip(pairs, meas):
        render(f, pack / "audio" / "sfx" / f"{pad['id']}.mp3", m)
    upsert(pack, [p for _, p in pairs])
    print(f"wrote {len(pairs)} pads to {pack / 'audio' / 'sfx'}/, sfx.json updated")


def cmd_list(a) -> None:
    pack, plan = Path(a.pack), load_plan(Path(a.plan))
    done = {p.stem for p in (pack / "audio" / "sfx").glob("*.mp3")} if (pack / "audio" / "sfx").exists() else set()
    o = ["# Zvuky: co vygenerovat (ElevenLabs Sound Effects)", "",
         "Jdi **v tomhle pořadí**. U každého zvuku nastav délku (sekundy), vygeneruj a **stáhni jen nejlepší variantu**.",
         "Přeskočený zvuk mi napiš. `nahrazuje` = vymění dnešní syntetický pad (klávesová zkratka zůstane).",
         "Kam hraje: **rear** = zadní reproduktory (publikum za zády), **all** = všude, **center** = střed, **Sub** = pošle bas do subwooferu.", ""]
    group = None
    for n, p in enumerate(plan, 1):
        if p.get("group") != group:
            group = p.get("group")
            o += [f"## {group}", ""]
        tick = " ✅" if p["id"] in done else ""
        extra = " · nahrazuje" if p.get("replace") else ""
        sub = f" · Sub {p['sub']}" if p.get("sub") else ""
        o += [f"**{n}. {p['label']}** · `{p['id']}` · {p.get('secs', '')} s · {p.get('route', 'front')}{sub}{extra}{tick}", "```", p["prompt"], "```", ""]
    Path(a.out).write_text("\n".join(o), encoding="utf-8")
    print(f"{len(plan)} pads → {a.out}")


def cmd_status(a) -> None:
    pack, plan = Path(a.pack), load_plan(Path(a.plan))
    d = pack / "audio" / "sfx"
    have = {p.stem for p in d.glob("*.mp3")} if d.exists() else set()
    for n, p in enumerate(plan, 1):
        print(f"{n:>3} {'✓' if p['id'] in have else ' '} {p['id']}")
    print(f"{sum(p['id'] in have for p in plan)}/{len(plan)} done")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("list", "ingest", "status"):
        p = sub.add_parser(name)
        p.add_argument("--pack", required=True)
        p.add_argument("--plan", required=True)
        if name == "list":
            p.add_argument("--out", required=True)
        if name == "ingest":
            p.add_argument("audio", nargs="+")
            p.add_argument("--start", type=int, default=1)
            p.add_argument("--only")
            p.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    {"list": cmd_list, "ingest": cmd_ingest, "status": cmd_status}[a.cmd](a)


if __name__ == "__main__":
    main()

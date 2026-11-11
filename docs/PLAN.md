# Implementation plan — web edition (v3)

Goal: TV (its own browser, TCL; Xbox Edge as fallback) = the show, **picture only**;
notebook = GM desk + **all audio** (wired to the soundbar: Spotify app, SFX pads, System voice);
phones = character sheets. Free hosting, auto-deploy from GitHub, nothing to install,
state survives for months. AI work (recaps, new items, quips) happens offline in chat and
lands in the repo — the site needs no API key.

## Architecture

- **One Cloudflare account (free plan).** Static site + one Worker with a SQLite-backed
  Durable Object per campaign = the authoritative game server (the existing isomorphic
  engine, `server/engine.js`, runs inside it). WebSockets to TV / GM / phones.
- **Deploy:** Cloudflare builds from the *private* repo on every push (engine pulled from the
  public repo at build time). Push = live in about a minute.
- **Persistence:** every action is applied and written to SQLite before it is acknowledged;
  append-only action log; automatic restore points (session start/end + every 10 min);
  "Export session" and "Export campaign" buttons; "Restore" on the GM desk.
- **Content pipeline:** packs (items, quips, bosses, mobs, NPCs, images) are files in the
  private repo. Homebrew made live on the GM desk lives in the DB and can be exported back
  into the repo.

## Access

- GM: secret link (long token), stored on the notebook. TV: its own link, pairing by a
  4-letter code shown on the TV and typed on the GM desk (no typing URLs with a controller
  beyond the short address).
- Players: **personal character link** (secret token) shown as QR on the GM desk; the phone
  remembers it ("Add to Home Screen"). Lost phone/link → GM regenerates the QR. Fallback:
  join page → pick character → GM approves once.
- GM always sees and can edit every sheet. No race/class for now (hidden in builder,
  kept in data for the floor 3–5 add-on).
- Hardening: all writes validated by the engine, per-connection rate limits, tokens only,
  `noindex`, no public write endpoints, no secrets in the client, Cloudflare in front.

## Phases

1. **Server + deploy** — Worker/Durable Object adapter around the engine, SQLite persistence,
   restore points, tokens, pairing, CI tests, deploy from GitHub. Existing GM/player/TV UI
   running on the real URL.
2. **TV as a directed show** — scene system controlled from the GM desk: Lobby, Exploration,
   **Boss Battle** (intro sting, boss art, name card, HP bar, phases, defeat), Loot,
   Recap, Floor countdown, big dice rolls, announcements. Neon theme switch for GM/phones.
3. **Bestiary + combat** — bosses, mobs, NPCs as library kinds (art, stats, HP slots, notes),
   synced combat tracker (replaces the local one), reveal-to-TV button.
4. **Sound desk (on the notebook)** — SFX pads from repo files, System voice via ElevenLabs
   (key stored as a server secret, never in the browser): pre-render known lines once and cache,
   regenerate an edited achievement in 1–2 s, free-text announcements. Music stays in the
   Spotify app on the notebook (optional playlist buttons later). Live table listening is
   dropped (latency, mixed CZ/EN, cost).
   *Built:* Show → Sound (16 original procedural pads + pack `sfx.json`, Shift hotkeys, per-pad/master
   volume, ducking while the System speaks), announcement box, Settings → Voice, pre-render with a
   character estimate, LRU voice cache (Node files / Durable Object SQLite). Protocol: PROTOCOL.md §3c.
5. **Art pipeline** — icon library: base icon per item category + variants; any item/boss/
   mob/NPC picks an image; prompts in one comic-colour dark-fantasy style; images sent in
   chat are cropped, converted and committed; missing art falls back to the category icon.
6. **Session memory** — session log, GM notes, "Export session" file → chat → recap,
   "Previously on…", new content committed → shown at next session start.
7. **Playground + demo** — seeded demo campaign (4 crawlers, 3 bosses, mobs, items, music
   scenes) and a GM cheat-sheet; "Floor 0" test one-shot.

## Needed from the GM

- Cloudflare account + connect the private GitHub repo (guided, ~15 min, once).
- ElevenLabs API key (phase 4).
- Images generated from supplied prompts; rule corrections once the book arrives.

## Known risks

- TCL TV browser may be slow/old → the TV page stays light; Xbox Edge as fallback.
- Web audio is stereo; the soundbar upmixes (no real Atmos objects).
- Free-plan daily request limits: fine for one table; state is batched over WebSocket.

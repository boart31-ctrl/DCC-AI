# The System — spec

A free, local-first "game show AI" for tabletop RPG nights. One laptop next to the TV runs everything;
players join from their phones over home Wi-Fi. The GM stays in control at all times.

The engine is system-agnostic. Setting-specific content (achievements, loot, quips, voice lines, art)
lives in **content packs**. This repo ships a small original demo pack. Packs built from commercial
books belong in your own private repo and are never published here.

## Principles

1. **GM is king.** Every automatic thing can be stopped with one tap. The GM panel has a big
   `AUTO: ON/OFF` switch and a `QUIET` mode.
2. **Less is more.** Spontaneous AI lines are rationed by a per-session budget (default 6).
   Rarity is what makes them land.
3. **Never talk over people.** Lines wait in a queue and play in natural pauses. GM buttons play now.
4. **Local-first.** Game state lives on the host machine. No database on the internet, no accounts.
   Only optional AI calls leave the house.
5. **Zero cost by default.** Without any API key the tool is fully playable: GM buttons play
   pre-rendered audio from the pack, or the browser's built-in speech as a fallback.
6. **Privacy.** Audio is never stored. Transcripts (phase 3) live in memory for one session only.
7. **Minimal input.** Players scan a QR code on the TV, type a 4-digit PIN, done.

## Screens

| Route    | Device              | Purpose |
|----------|---------------------|---------|
| `/gm`    | GM phone or tablet  | Big buttons: classic quips, award achievement, open loot box, secret message, viewers, AUTO switch, mode |
| `/play`  | Each player's phone | Own character card, inventory, achievements, secret messages. Designed to lie face-down: vibrates on events |
| `/stage` | Laptop → HDMI → TV  | The "broadcast": viewer counter, chat ticker, achievement and loot animations, QR to join. Plays all audio through the soundbar |

## Core mechanics (phase 1)

- **Achievements** — GM picks from the pack or types a custom one. Shown on stage + the player's phone,
  voice line plays.
- **Loot boxes** — tiers (bronze/silver/gold/legendary…). Opening rolls on the pack's loot table with
  weights; result revealed on stage with animation, item lands in the player's inventory.
- **Quips** — categorised voice lines (`nat1`, `nat20`, `death`, `levelup`, `boss`, `fail`, `idle`…).
  GM button picks a random unused line from the category (no repeats within a session).
- **Secret messages** — GM sends a private message to one player (e.g. a sponsor offer).
- **Audience** — a viewer count that reacts to events, plus a fake chat ticker. Hype thresholds can
  trigger a sponsor box.
- **Session memory** — every event is logged to `data/` on the host so later sessions (and recaps) can
  reference history.

## Voice timing rules

| Priority | Source                         | Plays |
|----------|--------------------------------|-------|
| P0       | GM button                      | Immediately (interrupts nothing but its own queue) |
| P1       | Game event (achievement, loot) | Next pause; max wait 20 s, then dropped if stale |
| P2       | Spontaneous AI comment         | Only if AUTO is on, budget > 0, mode allows; shown on GM panel 5 s first with a VETO button |

Modes: `roleplay` (everything allowed), `combat` (only P0 + crits), `quiet` (P0 only).
Max line length ~8 s. Background music ducks while the System speaks.

## Cost strategy

- Quips are rendered once to audio files (offline script) → GM buttons cost nothing forever.
- Live AI only for P2 comments and custom achievement text, using the cheapest capable model,
  short prompts, cached system prompt, hard per-session cap.
- Speech-to-text (phase 3) runs only while AUTO is on.

## Architecture

```
server/        Node 22, single process, no framework. HTTP static + WebSocket (ws).
  index.js     entry: loads pack, starts HTTP+WS, prints join QR/URLs + GM link
  state.js     game state, reducers for every action, per-role views
  pack.js      content pack loader + validation
  quips.js     quip picker (no repeats) + voice queue / priority / budget
  ai.js        optional AI provider (disabled without key)
web/           Plain HTML/CSS/JS, no build step. PWA manifest. /gm /play /stage
packs/demo/    Original demo content pack (public)
data/          Runtime logs and saves (gitignored)
docs/          PROTOCOL.md, CONTENT_PACKS.md, HARDWARE.md
```

Auth: GM link contains a random token printed on startup. Players join with a room code + 4-digit PIN
set by the GM per player. Stage uses its own token. All on the local network.

## Roadmap

| Phase | Content | Status |
|-------|---------|--------|
| 0 | Spec, protocol, repo hygiene, secret scanning | in progress |
| 1 | Engine, GM panel, player app, stage, achievements, loot, quips, secrets | in progress |
| 2 | Audience + sponsor mechanics polish, pre-rendered voice pipeline, music ducking | — |
| — | **Milestone: "Floor 0" test one-shot** | — |
| 3 | The System listens: live STT (CZ/EN mix), AI director with veto, speaker attribution | — |
| 4 | Surround: sounds moving around the table (5.1/7.1 via HDMI) | — |
| 5 | Dice cam, cross-session memory callbacks, episode audio recaps | — |
| 6 | Public launch: docs, demo video, pack import guide | — |

## Legal

This is an unofficial fan tool. It contains no text, art or rules from any commercial game.
Use content packs only with material you own.

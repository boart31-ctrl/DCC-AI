# Hosted edition (claude.ai Artifact)

Same game, no install. The whole tool is one published claude.ai Artifact. The GM opens it from
claude.ai, players open the share link on their phones. No server, no Node, no API key — the
Artifact runtime provides storage (`db`), live presence (`room`), identity (`user`) and Claude
itself (`sample`).

## Roles

| Who | Detected by | Sees |
|---|---|---|
| GM | `user.isOwner()` | GM desk (the same desk as `/gm`) + "Open TV view" button + Campaign tab (memory, recap, prep) |
| TV / stage | owner with `#stage` in the URL (second window dragged to the TV) | The broadcast (same as `/stage`), speaks lines with browser TTS |
| Player | anyone else, signed in to claude.ai | Lobby until the GM assigns them a character, then the phone sheet (same as `/play`) |

Players need a (free) claude.ai account and must be signed in; the GM shares the artifact by link.
Outside viewers can only *read* — every write is done by the GM's page. That is a feature: the GM's
browser is the game server.

## Engine in the browser

The GM page runs the same reducers as the Node server (`server/engine.js`, isomorphic: no Node
imports). Every GM action → `reduce(state, action)` → write projections to `db`:

| db path | Read | Write | Content |
|---|---|---|---|
| `engine/state` | owner | owner | Full authoritative state (players, inventories, messages, session, quip usage, log) |
| `public/view` | view | owner | Public projection: pack meta, audience, feed, players summary, recap teaser |
| `pv/<userId>` | that player (+owner) | owner | That player's private projection (`view` for role player) incl. `events` (last 20 events addressed to them, with ids, for takeovers) |
| `stage/feed` | owner | owner | Stage projection + play queue (stage is the GM's own window) |
| `campaign/story` | owner | owner | Running "story so far" (markdown) |
| `sessions/<id>` | owner | owner | Archived session: event log, GM notes, AI summary, "Previously on…" text |
| `prep/next` | owner | owner | Prep for the next session: GM + AI plan, prepared cards |
| `data/users/<id>/notes` | that player only | that player | Player's private notes (needs Contributor; otherwise notes stay in the browser) |

Rules declared at publish:
```json
{ "db": { "rules": [
  { "path": "", "read": "owner", "write": "owner" },
  { "path": "public", "read": "view", "write": "owner" },
  { "path": "pv", "read": "owner", "write": "owner" },
  { "path": "pv/{self}", "read": "view", "write": "owner" },
  { "path": "data/users/{self}", "read": "view", "write": "interact" }
] } }
```
`self` rules are access control, not encryption: the GM (owner) can read everything, which is fine.

## Assigning players

Every open page sets `room` presence `{ role, sheetId? }`. The GM desk shows a **Lobby**: people who
have the link open (names via `user` profile scope). GM taps a person → picks a character (or "new
character") → the engine stores `player.userId`, and the page starts writing `pv/<userId>`.
No PINs, no room codes in the hosted edition.

## Memory and prep (Campaign tab, GM only)

- **End session** → archives the log to `sessions/<id>`, asks Claude (`sample`) for a short factual
  summary + a dramatic "Previously on…" in the System's voice, appends the summary to
  `campaign/story`. GM can edit both before saving.
- **Start session** → "Previously on…" shown on the TV and phones, optional System voice-over.
- **Prep next session** → a chat with Claude that sees: story so far, last summaries, party sheets,
  inventories, achievements earned, pack catalog, GM notes. Claude can create **prepared cards** via
  page tools: `prepare_achievement`, `prepare_loot`, `prepare_message`, `prepare_line`, `add_note`.
  Cards appear on the GM desk next session as one-tap buttons (and can be edited or deleted).
- **During play** → "Write it for me": GM types what happened in a few words, Claude returns a
  book-style achievement (title, desc, reward) in the pack's voice; GM approves before it fires.

AI costs nothing extra: it runs on the GM's own Claude plan through the Artifact runtime.

## Build

`tools/build_artifact.mjs <packDir> <outDir>` bundles `artifact/` + `web/css` + engine + the chosen
pack (normalized to JSON) into a folder ready to publish. The DCC build is made from the private repo
pack and published privately; nothing from it lands in this repo.

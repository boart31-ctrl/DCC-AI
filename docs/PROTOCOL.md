# WebSocket protocol (v1)

Single WebSocket endpoint: `ws(s)://<host>:<port>/ws`. All messages are JSON objects with a `t` (type) field.
The server is authoritative. Clients send **actions**; the server replies with **views** (role-filtered
state snapshots) and **events** (one-shot things to animate or play).

## 1. Handshake

Client → server, first message:

```json
{ "t": "hello", "role": "gm",     "token": "<gmToken>" }
{ "t": "hello", "role": "stage",  "token": "<stageToken>" }
{ "t": "hello", "role": "player", "room": "ABCD", "pin": "1234" }
```

Server → client:

```json
{ "t": "welcome", "role": "player", "playerId": "p_x7", "view": { ... } }
{ "t": "error", "code": "bad_auth" | "bad_request" | "not_found" | "rate_limited", "msg": "..." }
```

After `bad_auth` the server closes the socket. Players are rate-limited: 5 failed PINs per IP per minute.
Tokens and the room code are printed on server start and also available to the GM in its view.

## 2. Views

Server pushes `{ "t": "view", "view": {...} }` to every client after each state change (debounced ~50 ms).
Each role gets its own projection.

### Common fields
```json
{
  "room": "ABCD",
  "session": { "id": "s_...", "startedAt": 0, "mode": "roleplay", "auto": false, "budgetLeft": 6, "voice": "host" },
  "pack": { "id": "demo", "name": "Demo Pack", "version": "1.0.0", "systemName": "The System", "notifyPrefix": "New achievement!", "lootTiers": [ {"id":"bronze","name":"Bronze Box","color":"#cd7f32"} ],
            "stats": [ {"id":"str","label":"Strength","abbr":"STR"} ], "resources": [ {"id":"hp","label":"Health","color":"#ff3355"} ],
            "voices": [ {"id":"host","label":"Game-show host"} ] },
  "audience": { "viewers": 1200, "hype": 0.3 },
  "feed": [ { "id": "e_...", "at": 0, "kind": "achievement", "playerId": "p_x7", "text": "..." } ],
  "players": [ { "id": "p_x7", "name": "Carl", "color": "#ff7a00", "level": 1, "achievementCount": 3, "connected": true } ]
}
```
`feed` = last 30 public events.

### Player view adds
```json
{
  "me": {
    "id": "p_x7", "name": "Carl", "color": "#ff7a00", "level": 1,
    "title": "Level 1 Crawler", "klass": "Brawler", "race": "Human",
    "stats": { "str": 3, "dex": 2 },
    "resources": { "hp": { "cur": 12, "max": 15 } },
    "gold": 0, "notes": "",
    "inventory": [ { "uid": "i_...", "itemId": "rubber_duck", "name": "...", "desc": "...", "flavor": "", "rarity": "common", "image": "/pack/images/rubber_duck.webp", "at": 0 } ],
    "achievements": [ { "uid": "a_...", "achId": "first_blood", "title": "...", "desc": "...", "reward": "", "group": "", "at": 0 } ],
    "secrets": [ { "id": "m_...", "at": 0, "from": "Sponsor", "text": "...", "read": false } ],
    "messages": [ { "id": "m_...", "at": 0, "from": "The System", "text": "...", "group": true, "read": false } ]
  }
}
```
`messages` = every message addressed to this player, oldest first: private ones (`group: false`) and
group ones (`group: true`, sent to `all` or to several players). `secrets` = only the private ones
(kept for backwards compatibility). `read` is per player. `flavor`, `reward`, `group` are `""` when the
pack does not set them; `achId` is `null` for custom achievements.

### GM view adds
```json
{
  "gm": {
    "joinUrl": "http://192.168.1.20:7777/play?room=ABCD",
    "stageUrl": "http://192.168.1.20:7777/stage#<stageToken>",
    "pins": { "p_x7": "1234" },
    "playersFull": [ /* same shape as player `me` for each player */ ],
    "quipCategories": [ { "id": "nat1", "label": "Nat 1", "left": 14 } ],
    "achievementsCatalog": [ { "id": "first_blood", "title": "...", "desc": "..." } ],
    "pendingAuto": [ { "id": "q_...", "text": "...", "playsAt": 0 } ],
    "queue": [ { "id": "q_...", "priority": 1, "text": "..." } ],
    "messages": [ { "id": "m_...", "at": 0, "from": "...", "text": "...", "to": "all" | ["p_x7"], "group": true, "onStage": false, "readBy": ["p_x7"] } ],
    "aiAvailable": false
  }
}
```
`gm.prepCards` = `[ { "id": "c_...", "kind": "achievement", "label": "...", "payload": {...}, "createdAt": 0, "used": false, "usedAt": null } ]`.
`gm.playersFull[]` entries also carry `userId` (hosted edition; `null` otherwise). Every view has top-level `recap` (string).
`gm.messages` = last 50 messages of the session, all recipients. The server keeps at most 200 messages
(oldest dropped). `achievementsCatalog` entries also carry `reward` and `group`.

### Stage view
Common fields + `"joinUrl"` (for the QR code) + `"queueLength"`.

## 3. GM actions (client → server)

Every action may carry `"rid"` (request id); the server answers `{ "t": "ack", "rid": "...", "ok": true }`
or `{ "t": "ack", "rid": "...", "ok": false, "error": "..." }`.

| `t` | Fields | Effect |
|-----|--------|--------|
| `player.add` | `name`, `color?`, `pin?`, `userId?` | Creates player; random 4-digit PIN if none |
| `player.update` | `playerId`, `name?`, `color?`, `level?`, `pin?`, `userId?` (hosted edition: string ≤ 64, unique, or `null` to unassign), `title?`, `klass?`, `race?`, `gold?`, `notes?` | |
| `player.stat` | `playerId`, `stat`, `value` **or** `delta` | Changes a stat defined in pack `stats`; event `stat` to that player + gm |
| `player.resource` | `playerId`, `res`, `cur?`, `max?`, `delta?` | Changes hp/mana etc. (clamped 0..max) |
| `player.remove` | `playerId` | |
| `ach.award` | `playerId`, `achId` **or** `title`+`desc?`+`reward?` | Adds achievement, event `achievement`, P1 voice line (pack `voice` for that achievement, else quip category `achievement`) |
| `loot.open` | `playerId`, `tier` | Rolls pack loot table for tier, adds item, event `loot` |
| `item.give` | `playerId`, `itemId` | Direct give, no animation |
| `item.remove` | `playerId`, `uid` | |
| `quip.play` | `category` **or** `quipId` | P0: plays immediately on stage |
| `say` | `text` | P0: GM typed text, spoken via TTS fallback |
| `msg.send` | `to`: `"all"` or `[playerId, ...]`, `text` (max 1000), `from?` (default pack `systemName`), `onStage?`: bool | Message to one, several or all players. Event `message` to recipients + gm. If `onStage` and it is a group message, stage also gets event `announcement` (text only, no audio — use `say` for voice) |
| `secret.send` | `playerId`, `text`, `from?` | Alias for `msg.send` with `to: [playerId]` |
| `audience.bump` | `delta` (int, may be negative) | Viewers change, hype recalculated |
| `sponsor.box` | `playerId`, `tier?`, `sponsor?` | Loot box framed as a sponsor gift, event `sponsor` |
| `session.mode` | `mode`: `roleplay`/`combat`/`quiet` | |
| `session.auto` | `on`: bool | Master AUTO switch. Off also clears `pendingAuto` |
| `session.budget` | `value` | Set remaining auto budget |
| `session.voice` | `voice` (id from pack `voices`) | Switches the System voice live; stage applies it to the next line |
| `auto.veto` | `id` | Cancels a pending P2 line |
| `queue.clear` | — | Stop everything: drops queue, sends `stop` to stage |
| `session.recap` | `text` (max 4000) | Sets `session.recap` ("Previously on…"), shown to everyone as top-level `recap` in every view. Cleared by `session.new` |
| `prep.card.add` | `kind`: `achievement`/`loot`/`message`/`line`, `payload` (object), `label?` | Stores a prepared one-tap card; ack `result.id`. Payload = the fields of `ach.award` / `loot.open` / `msg.send` / `say` |
| `prep.card.remove` | `id` | |
| `prep.card.fire` | `id`, `playerId?`, `to?` | Runs the card's action with its payload (`playerId`/`to` override it), marks the card `used`. Same events/voice lines as the underlying action |
| `session.new` | — | Archives current session to `data/`, starts fresh (keeps players + inventories) |

## 4. Player actions

| `t` | Fields | Effect |
|-----|--------|--------|
| `secret.read` | `id` | Marks a message read for this player (private or group) |
| `me.notes` | `text` (max 2000 chars) | Player edits own notes |
| `ping` | — | Keepalive, server answers `pong` |

Players cannot change state otherwise.

## 5. Stage actions

| `t` | Fields | Effect |
|-----|--------|--------|
| `audio.done` | `id` | Stage finished playing a queued line → server releases the next one |
| `audio.pause` | `silent`: bool | (phase 3) table-silence detector; server only releases P1/P2 while `silent` is true. In phase 1 the server treats the table as silent |

## 6. Events (server → clients)

`{ "t": "event", "event": { "id", "at", "kind", ...payload } }`

| `kind` | Payload | Who receives |
|--------|---------|--------------|
| `achievement` | `playerId`, `achId`, `title`, `desc`, `reward`, `group` | all |
| `stat` | `playerId`, `stat`, `from`, `to` | that player + gm + stage |
| `loot` | `playerId`, `tier`, `item` (full inventory item, incl. `flavor`) | all |
| `sponsor` | `playerId`, `sponsor`, `tier`, `item` | all |
| `message` | `id` (= message id), `group`, `from`, `to` | recipients + gm (phone vibrates; text arrives in view) |
| `announcement` | `messageId`, `from`, `text` | stage (only for `msg.send` with `onStage: true` and a group recipient) |
| `secret` | `playerId`, `messageId` | legacy: also sent for every private message, to that player + gm |
| `viewers` | `viewers`, `delta` | stage, gm |
| `chat` | `user`, `text` | stage |

Audio for stage only:
```json
{ "t": "play", "id": "q_...", "priority": 0, "text": "line text", "audio": "/pack/audio/nat1_03.mp3" | null, "voice": { "id": "host", "lang": "en-US", "rate": 1.05, "pitch": 0.8, "prefer": ["Daniel", "Google UK English Male"] } }
{ "t": "stop" }
```
If `audio` is null the stage speaks `text` with the browser's `speechSynthesis` (English voice).
The stage must send `audio.done` when finished or after a 12 s safety timeout.

## 7. Static routes

| Route | Serves |
|-------|--------|
| `/`, `/gm`, `/play`, `/stage` | `web/` pages |
| `/pack/*` | files from the active content pack directory (images, audio) — read-only, no path traversal |
| `/manifest.webmanifest`, `/sw.js` | PWA |
| `/qr?text=...` | SVG QR code generated server-side (no external service) |

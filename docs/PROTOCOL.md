# WebSocket protocol (v1, with RULESET v2 sheets)

Single WebSocket endpoint: `ws(s)://<host>:<port>/ws`. All messages are JSON objects with a `t` (type) field.
The server is authoritative. Clients send **actions**; the server replies with **views** (role-filtered
state snapshots) and **events** (one-shot things to animate or play).

## 1. Handshake

The same protocol is spoken by the Node server (`server/index.js`) and the Cloudflare edition
(`cloud/worker.js`, one Durable Object per campaign). Both run `server/host.js`.

Client → server, first message (one of):

```json
{ "t": "hello", "role": "gm",     "key": "<GM_KEY>" }
{ "t": "hello", "role": "player", "token": "<playerToken>" }
{ "t": "hello", "role": "player", "claim": true, "name": "Lucie" }
{ "t": "hello", "role": "stage",  "pair": true }
{ "t": "hello", "role": "stage",  "tvToken": "<tvToken>" }
{ "t": "hello", "role": "stage",  "key": "<GM_KEY>" }
```

Legacy forms (Node edition only, kept for backwards compatibility):

```json
{ "t": "hello", "role": "gm",     "token": "<gmToken>" }
{ "t": "hello", "role": "stage",  "token": "<stageToken>" }
{ "t": "hello", "role": "player", "room": "ABCD", "pin": "1234" }
```

Server → client:

```json
{ "t": "welcome", "role": "player", "playerId": "p_x7", "view": { ... } }
{ "t": "error", "code": "bad_auth" | "bad_request" | "not_found" | "forbidden" | "rate_limited" | "busy" | "denied" | "internal", "msg": "..." }
```

After `bad_auth` / `rate_limited` the server closes the socket (code 4001). `bad_request` keeps it open.
`{"t":"ping"}` is answered with `{"t":"pong"}` at any time (also before `hello`).

### 1a. Access model

| Who | How |
|-----|-----|
| GM | Secret `GM_KEY` (Cloudflare secret; Node: `.env`). The GM page asks once, keeps it in `localStorage` (`system.gmKey`), sends `hello {role:'gm', key}`. Constant-time compare. 5 failures per minute per IP → `rate_limited` (even for the right key). No key configured → nobody gets in (`bad_auth`, msg mentions `GM_KEY`). |
| Player | Every player gets a random link token (32 url-safe chars) when created. The GM sees `gm.playersFull[].joinUrl` = `<origin>/p/<token>` (QR on the desk). The page at `/p/<token>` stores the token (`localStorage` `system.playerToken`) so "Add to Home Screen" (manifest `start_url` `/play`) reopens the character. `player.relink` makes a new token: the old one stops working and its sockets are closed (4001 `relinked`). Removing the player drops the token (4004). |
| Player without a link | `hello {role:'player', claim:true, name}` → `{ "t": "claim", "requestId": "rq_…", "characters": [{id, name, color, connected}] }`. The phone may send `{ "t": "claim.pick", "playerId": "p_…" }` (ack). The GM gets event `joinRequest` and `gm.requests[]`, then `player.approve {requestId, playerId?}` → the phone receives `{ "t": "token", "token": "…", "playerId": "p_…" }` followed by `welcome` (it stores the token like a `/p/` link). `player.deny {requestId}` → error `denied`, close 4001. Requests expire after 10 min (close 4002), max 6 waiting. |
| TV | `/tv` sends `hello {role:'stage', pair:true}` → `{ "t": "pairing", "code": "KJAM", "expiresAt": 0 }` (4 letters, no I/L/O, per socket, valid 10 min, then close 4002 and the page reconnects for a new one). GM `tv.pair {code, label?}` → that socket gets `{ "t": "paired", "tvToken": "…", "tvId": "tv_…" }` and `welcome` as `stage`. Later: `hello {role:'stage', tvToken}`. `tv.unpair {tvId}` revokes (sockets closed 4001 `revoked`). Max 3 TVs, max 6 screens waiting with a code. The GM's own browser may open the stage with the GM key instead. |

Secrets are never sent to non-GM roles: player views carry no tokens; a TV token is sent once, to that TV;
the GM view shows player links but never TV tokens or the GM key.

### 1b. Limits and close codes

| | |
|---|---|
| Message size | max 16 KB (Node: ws `maxPayload`; host: close 1009) |
| Rate | per socket token bucket: GM and stage 20 msg/s (burst 40), players and not-yet-authenticated sockets 10/s (burst 20). Over the limit: message dropped, one `error rate_limited` per second |
| Sockets | max 40 per campaign (close 1013 / HTTP 503) |
| Hello | sockets without a successful `hello` within 10 s are closed (4000) |
| Origin | `/ws` accepts only same-origin browsers (Cloudflare: `Origin` must equal the site origin, else HTTP 403; Node: a foreign `Origin` is refused) |
| Close codes | 4000 hello timeout · 4001 auth refused / relinked / revoked / denied · 4002 pairing code or join request expired, or busy · 4004 player removed |

### 1c. Persistence and restore points

Every accepted mutating action (GM and player) is applied, then persisted **before** its ack and events are
sent (Cloudflare: synchronous SQLite write in the same turn; the runtime's output gate holds the ack until the
write is durable). If saving fails the action is rejected (`internal`) and the state is unchanged.

Cloudflare Durable Object tables: `state` (the whole state as JSON, one row; split into parts only above
~400 k chars), `log` (`seq, at, by, action` — every accepted mutating action, with `token`/`pin`/`key`/
`tvToken`/`code`/`rid` stripped), `snapshots` (`id, part, at, reason, json`). Node: `data/state.json`
(written on every action), `data/snapshots/<id>_<reason>.json`, session archives in `data/sessions/`.

Restore points (newest 50 kept) are taken of the state *before* the triggering action: `session.new`; `idle`
(first action after more than 30 min without one); `periodic` (≥ 10 min since the last restore point);
`manual` (`backup.create`); `before-restore` (taken by every `backup.restore`, so a restore can be undone).

## 2. Views

Server pushes `{ "t": "view", "view": {...} }` to every client after each state change (debounced ~50 ms).
Each role gets its own projection.

### Common fields
```json
{
  "room": "ABCD",
  "session": { "id": "s_...", "startedAt": 0, "mode": "roleplay", "auto": false, "budgetLeft": 6, "voice": "host",
               "permissions": { "playerEdit": "sheet" } },
  "pack": { "id": "demo", "name": "Demo Pack", "version": "1.0.0", "systemName": "The System", "notifyPrefix": "New achievement!", "lootTiers": [ {"id":"bronze","name":"Bronze Box","color":"#cd7f32"} ],
            "stats": [ {"id":"str","label":"Strength","abbr":"STR"} ], "resources": [ {"id":"hp","label":"Health","color":"#ff3355"} ],
            "voices": [ {"id":"host","label":"Game-show host"} ],
            "ruleset": { /* full normalized ruleset, see below */ } },
  "audience": { "viewers": 1200, "hype": 0.3 },
  "feed": [ { "id": "e_...", "at": 0, "kind": "achievement", "playerId": "p_x7", "text": "..." } ],
  "players": [ { "id": "p_x7", "name": "Carl", "color": "#ff7a00", "level": 1, "achievementCount": 3, "connected": true } ]
}
```
`feed` = last 30 public events.

Every view also has:
- `rolls`: last 50 dice-log entries visible to that role (see [Rolls](#rolls)). GM: all. Player:
  non-secret + their own secret rolls. Stage: non-secret only.
- `library`: `{ item:[], spell:[], skill:[], buff:[], feature:[], race:[], class:[], background:[], boss:[], location:[], monster:[], npc:[] }`.
  Every entry has `source: "pack" | "homebrew"`. GM: everything (pack + homebrew). Player: every entry their
  own sheet references (inventory items, known spells, buffs on them, buffs their items/spells apply),
  plus the full `skill`, `race`, `class`, `background` lists and the `feature`s those reference
  (character builder). Stage: the builder lists only.
- `pack.ruleset`: the normalized ruleset (docs/RULESET.md §1) with every default filled in, plus
  `unverified: [{kind:"unverified", path, note}]` (all `verify: true` markers). Shape:
  `{ id, dice, stats:[{id,label,abbr,parts,default:{part:n},verify?,note?}], statMod:{from,formula,verify?,note?},
  derived:[{id,label,formula,display,roll,verify?,note?}], fields:[{id,label,type,default,group}],
  tracks:[{id,label,kind:"pool"|"slots",color,default,slots?,labels?,maxFormula?}], slots:[{id,label,max}],
  buffSlots:{external:{label,max|null}}, hotlist:{size}, skills:{columns,rankMin,rankMax,check:{roll,formula},
  checkTypes,usedTracking,rankUp:{roll,rule,target,amount}|null,catalog}, attack:{roll,toHit,damage},
  spells:{costTrack}, identity:[], storyFields:[], races:[ids], classes:[ids], backgrounds:[ids], unverified:[] }`.
  `buffSlots.external.max: null` = no cap. Unknown ruleset keys are dropped.

### Player view adds
```json
{
  "me": {
    "id": "p_x7", "name": "Carl", "color": "#ff7a00", "level": 1,
    "title": "Level 1 Crawler", "klass": "Brawler", "race": "Human",
    "stats": { "str": 3, "dex": 2 },
    "resources": { "hp": { "cur": 12, "max": 15 } },
    "gold": 0, "notes": "",
    "inventory": [ { "uid": "i_...", "itemId": "rubber_duck", "name": "...", "desc": "...", "flavor": "", "rarity": "common", "image": "/pack/images/rubber_duck.webp", "at": 0,
                     "qty": 1, "notes": "", "equippedSlot": null,
                     "slot": null, "stackable": false, "effects": [], "attack": null, "use": null, "tags": [], "source": "pack" } ],
    "achievements": [ { "uid": "a_...", "achId": "first_blood", "title": "...", "desc": "...", "reward": "", "group": "", "at": 0 } ],
    "secrets": [ { "id": "m_...", "at": 0, "from": "Sponsor", "text": "...", "read": false } ],
    "messages": [ { "id": "m_...", "at": 0, "from": "The System", "text": "...", "group": true, "read": false } ]
  }
}
```
`stats` / `resources` are the v1 projection of the sheet (base value of `statMod.from` per stat; tracks with
the computed max). `inventory` entries are enriched from the library (current name/desc/image, `slot`,
`stackable`, `effects`, `attack`, `use`, `source`); an item no longer in the library gets `missing: true`.

`me.sheet` = the raw character (docs/RULESET.md §5) with `me.sheet.computed`:
```json
{
  "name": "Carl", "level": 1,
  "identity": { "name": "Carl", "level": 1, "race": "Gnomish", "class": "", "pronouns": "" },
  "stats": { "dex": { "enhanced": 14, "unenhanced": 10 } },
  "fields": { "armor": 0, "speed": 6 },
  "tracks": { "hp": { "cur": 10, "max": 10 } },
  "skills": [ { "uid": "s_..", "skillId": "melee", "name": "Melee", "rank": 2, "stat": "str", "checkType": "Standard", "notes": "", "used": false } ],
  "attacks": [ { "uid": "k_..", "name": "Sword", "skillUid": "s_..", "stat": "str", "dice": "1d8", "effects": "" } ],
  "spells": [ { "uid": "sp_..", "spellId": "feather_step", "rank": 1, "active": false, "name": "Feather Step", "cost": "1 + floor(rank / 2)", "...": "all library spell fields" } ],
  "inventory": [ /* same as me.inventory */ ],
  "hotlist": [ "i_..", null ],
  "buffs": [ { "uid": "b_..", "buffId": "sponsor_glow", "name": "Sponsor Glow", "desc": "", "external": true, "effects": [], "until": "1 episode", "at": 0 } ],
  "story": { "backstory": "", "notes": "" },
  "portrait": null,
  "computed": {
    "stats":   { "dex": { "value": 16, "parts": [Part], "raw": {"enhanced":14,"unenhanced":10}, "mod": Breakdown } },
    "derived": { "defense": Breakdown + { "display": "14" } },
    "fields":  { "armor": Breakdown },
    "buffs":   { "defense": Breakdown },
    "tracks":  { "hp": { "cur": 10, "max": 11, "maxBreakdown": Breakdown } },
    "skills":  [ { "uid": "s_..", "total": Breakdown } ],
    "attacks": [ { "uid": "k_..", "toHit": Breakdown, "damage": "1d8+3", "damageParts": [Part] } ],
    "spells":  [ { "uid": "sp_..", "cost": Breakdown, "costTrack": "mp", "active": false } ],
    "effects": [ { "target": "defense", "op": "add", "value": 1, "label": "Mostly Invisible Cloak", "source": { "kind": "item", "uid": "i_..", "id": "...", "name": "..." }, "debuff": false } ],
    "externalBuffs": { "used": 1, "max": 2 },
    "warnings": [ { "kind": "unverified", "path": "statMod", "note": "..." } ]
  }
}
```
`Breakdown = { value, parts: [Part], warnings: [Warning] }`, `Part = { label, value, source, parts?, op? }` —
e.g. Evade 7 = `[{label:"DEX mod",value:3,source:"mod.dex"}, {label:"Buffs",value:4,source:"buff.evade",
parts:[{label:"Ring of Dodging",value:2,source:"item:i_1"}, {label:"Haste",value:2,source:"buff:b_2"}]}]`.
Zero-valued `buff.*` parts with no contributors are omitted. `Warning.kind`: `unverified` (`path`, `note`),
`unknown` (`name`: identifier counted as 0), `formula` (syntax error), `div0`, `overflow`, `missing`
(`ref: "item:<id>"`: sheet references a library entry that no longer exists).
Identity keys `name`, `level`, `race`, `class` and story `notes` are the same values as the player's
top-level `name`, `level`, `race`, `klass`, `notes` (one source of truth). `fields` lists every ruleset field;
fields that are also identity / story keys show the identity / story value.

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
`gm.playersFull[]` entries are the same shape as `me` (incl. `sheet` with `computed`) and also carry `userId` (hosted edition; `null` otherwise). Every view has top-level `recap` (string).
`gm.messages` = last 50 messages of the session, all recipients. The server keeps at most 200 messages
(oldest dropped). `achievementsCatalog` entries also carry `reward` and `group`.
`gm.itemsCatalog` = every library item (pack + homebrew): `{ id, name, rarity, desc, flavor, slot, stackable, source }`.

Access additions (both editions):
```json
{
  "gm": {
    "playersFull": [ { "...": "as above", "joinUrl": "https://the-system.example.workers.dev/p/<token>" } ],
    "requests": [ { "id": "rq_...", "name": "Lucie", "wants": "p_x7" | null, "at": 0 } ],
    "tvs": [ { "id": "tv_...", "label": "Living room", "at": 0, "connected": 1 } ],
    "tvWaiting": 0,
    "access": { "edition": "cloud" | "node", "legacy": false, "keyLogin": true, "backups": true, "maxTvs": 3 }
  }
}
```
Cloudflare edition: `gm.pins` is `{}` (no PIN login), `gm.joinUrl` / stage `joinUrl` = `<origin>/join`,
`gm.stageUrl` = `<origin>/tv`.

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
| `item.give` | `playerId`, `itemId`, `qty?` | Direct give from the library (pack or homebrew), no animation. Stackable items merge into an existing stack (`qty` added) |
| `item.remove` | `playerId`, `uid` | Also clears it from the hotlist |
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
| `session.new` | — | Archives current session to `data/`, starts fresh (keeps players + inventories + homebrew + permissions; clears the dice log) |
| `session.permissions` | `playerEdit`: `"none"` / `"notes"` / `"sheet"` | What players may change on their own sheet (default `sheet`) |
| `buff.add` | `playerId`, `buffId` **or** `name`, `effects?`, `external?`, `desc?`, `duration?` | Adds a buff. Enforces `buffSlots.external.max`. A library buff the character already has is not added twice (`result.added: false`) |
| `buff.remove` | `playerId`, `uid` | |
| `skills.rankUp` | `playerId?` (all players if omitted) | For every skill with `used: true`: rolls `skills.rankUp.roll`, compares (`gt`/`gte`/`lt`/`lte`) with `target` (number or formula; `rank` = the skill's rank), on success `rank += amount` (default 1, capped at `rankMax`). Clears `used`. Every roll goes to the dice log with `rankUp: {skillUid, name, rule, target, success, from, to}`. Ack `result.results: [{playerId, uid, name, roll, target, success, from, to, rollId}]` |
| `lib.upsert` | `kind` (`item`/`spell`/`skill`/`buff`/`feature`/`race`/`class`/`background`), `entry` | Create/update homebrew (validated like pack files; strict: any invalid part is an error). `entry.id` optional (generated `hb_...`). Ids of pack entries are refused (duplicate under a new id). Ack `result: {id, created}` |
| `lib.remove` | `kind`, `id` | Homebrew only (pack entries are read-only → `not_found`) |
| `lib.give` | `playerId`, `kind` (`item`/`spell`/`skill`/`buff`), `id`, `qty?` / `rank?` | Item → inventory, spell → learned, skill → added, buff → `buff.add` |

The GM may also send every action in [§4 Sheet actions](#sheet-actions) (with `playerId` required, except
`roll` with `kind: "custom"`), without permission checks.

Access, devices and backups (handled by `server/host.js`, both editions):

| `t` | Fields | Effect |
|-----|--------|--------|
| `player.relink` | `playerId` | New personal link; old token refused, its sockets closed (4001 `relinked`). Ack `result: {playerId, joinUrl}` |
| `player.approve` | `requestId`, `playerId?` (default: what the phone picked) | Lets a join request in as that player (see §1a). Ack `result: {playerId}` |
| `player.deny` | `requestId` | Declines a join request |
| `tv.pair` | `code` (4 letters, case-insensitive), `label?` | Pairs the screen showing that code. Ack `result: {tvId}`. Max 3 TVs |
| `tv.unpair` | `tvId` | Revokes that TV |
| `backup.list` | — | Ack `result.backups: [{id, at, reason, size?}]`, newest first |
| `backup.create` | — | Manual restore point. Ack `result.id` |
| `backup.restore` | `id` | Takes a `before-restore` point, then replaces the game state with the restore point. Links, TVs, room and legacy tokens stay as they are now; phones and TVs stay connected (a phone whose player does not exist in the restored state is closed with 4004). Voice queue cleared. Ack `result: {restored, backup}` |

### 3a. Scenes (what the TV shows)

Every view carries `scene` and `show` (all roles):
```json
"scene": { "id": "sc_...", "kind": "boss", "since": 0, "now": 0, "data": { ... },
           "party": [ { "id": "p_x7", "tracks": [ { "id": "hp", "label": "Health", "color": "#ff3355", "kind": "slots", "cur": 7, "max": 10 } ] } ] },
"show":  { "audioDevice": "gm" }
```
`now` = server time when the view was built (clients correct their clock with it). `party` = up to two
tracks per crawler (HP first) for the TV strip. `pack.theme` (`"dark"|"light"|"neon"|null`) is the pack's
default look for the GM desk and phones (a device's own choice wins).

`scene.kind` and `data` (defaults in brackets):

| kind | data |
|------|------|
| `lobby` (initial) | `title` [""], `subtitle` [""], `showQr` [true] |
| `explore` | `locationId` [null], `location`, `floor`, `image` (http(s) / `/pack/` / small data:image, else null), `text` (≤1200), `showFeed` [true] |
| `boss` | `bossId` (library id or null), `boss` `{name, title, image, hpSlots, phases:[{name, text, image, atHp}], flavor, color, lootTier, floor, intro, defeatLine}`, `phase` [0], `hp` [hpSlots], `revealed` [false], `defeated` [false], `lootHint` [""] (the TV loot line); view adds `lootTierInfo`, `suggestPhase` (index or null) |
| `loot` | `playerId`, `tier`; view adds `tierInfo` |
| `countdown` | `label`, `totalMs`, `remainingMs`; view adds `running`, `endsAt` (server ms or null). Clients compute `endsAt − (Date.now() + (now − receivedAt))` |
| `roll` | `playerId`, `name`, `color`, `label`, `formula`, `rollId`, `dice`, `total` (null = waiting), `nat1`, `nat20`, `at` |
| `recap` | `title`, `text` (defaults to `session.recap`) |
| `blank` | `text` |

The library boss fields `tactics` and `lootHint` are GM-only: they are never copied into the scene.
Location `features` are GM-only too.

| `t` | Fields | Effect |
|-----|--------|--------|
| `scene.set` | `kind`, `data?` | New scene (new `id`, `since` = now). `data` is validated per kind; unknown fields → `bad_request`. Boss: `bossId` **or** ad-hoc `boss` (name required, `hpSlots` 1..100, ≤10 phases); HP starts full. Explore: `locationId` fills location/floor/image/text from the library location (other fields override). Countdown: `seconds` (1..86400), `autostart?` |
| `scene.update` | `data` | Shallow merge into the current scene's data, same validation (no transition on the TV). Boss: `hp`, `phase`, `revealed`, `defeated`, `lootHint`, `bossId`/`boss` (swap). Countdown: `label`, `seconds` (resets), `running` |
| `scene.roll` | `playerId?`, `formula?` [d20] **or** `what?` (as `roll.what`), `label?`, `name?` — or `rollId` (re-show a public dice-log roll) | Rolls exactly like `roll` (dice log, `roll` event, nat1/nat20 line), then sets the `roll` scene. Ack `result: {rollId, total, sceneId}` |
| `show.audio` | `device`: `"gm"` / `"stage"` | Which page plays the System voice and the stingers (default `gm`). Both pages receive `play`/`stop`; only the device plays and acks `audio.done`, the other shows the subtitle |
| `boss.intro` | `line?` [true] | `revealed = true`; event `boss.intro`; feed line; P1 voice line = boss `intro` text, else a quip from category `boss` |
| `boss.damage` | `amount?` [1] (1..100) | HP − amount (min 0); event `boss.hit`; ack `result: {hp, max, suggestPhase}` |
| `boss.heal` | `amount?` [1] | HP + amount (max hpSlots), clears `defeated`; event `boss.heal` |
| `boss.phase` | `index?` [next] | Event `boss.phase`; feed line. `bad_request` if there is no further phase |
| `boss.defeat` | `lootHint?`, `line?` [true] | `defeated`, HP 0; event `boss.defeat`; feed line; +20% viewers; P1 voice line = boss `defeatLine` |
| `countdown.start` / `countdown.pause` | — | Server-timestamped; `bad_request` at zero |
| `countdown.add` | `seconds` (±, not 0) | Adds/removes time, keeps running |
| `countdown.reset` | `seconds?` | Back to `totalMs` (or a new total), paused |

`suggestPhase`: phases with `atHp` are suggested (never applied) when HP drops to that value: the furthest
later phase whose `atHp ≥ hp`. The GM confirms with `boss.phase`.
All scene/boss/countdown actions are GM-only (players and the stage get `bad_request: unknown action`).

### 3b. Combat (synced tracker) and NPCs

Every view carries `combat` (server/combat.js). GM:
```json
"combat": { "active": true, "round": 2, "phaseIndex": 1, "phase": "Mobs", "phases": ["Crawlers", "Mobs"],
  "phasesVerified": false, "showMobHp": false,
  "combatants": [
    { "uid": "cb_..", "type": "crawler", "playerId": "p_x7", "name": "Carl", "color": "#ff7a00", "hp": 6, "hpMax": 10, "down": false,
      "conditions": [ { "uid": "b_..", "id": "bleeding", "name": "Bleeding" } ] },
    { "uid": "cb_..", "type": "mob", "sourceKind": "monster" | "boss" | null, "sourceId": "gnashrat", "name": "Gnashrat 2", "image": null,
      "hp": 1, "hpMax": 2, "evade": 2, "dr": 0, "attacks": [ { "name": "Bite", "toHit": 2, "damage": "1d3", "effects": "", "buffs": [] } ],
      "conditions": [ { "id": "prone", "name": "Prone" } ], "notes": "", "hidden": true, "down": false, "linked": false } ] }
```
Players and the stage get the same header, crawlers (without buff `uid`s) and **revealed mobs only** as
`{ uid, type, name, image, boss, hpPct, down, conditions:[{id,name}] }`; `hpPct` is HP/max rounded **up** to
5 % (0 only when down). `hp`/`hpMax` are added only while `showMobHp` is on. Mob `notes`, `attacks`,
`sourceId` and every library GM field (tactics, notes, lootHint, voice, hooks, secrets, features) never
reach phones or the TV. Crawler HP is read from the sheet (track `hp`, else the first track).
`phases` default to `["Crawlers","Mobs"]` with `phasesVerified: false` (no initiative; unverified).

| `t` | Fields | Effect |
|-----|--------|--------|
| `combat.start` | `phases?` | `active`, round 1, phase 0; adds every player as a crawler combatant. Event `combat.start`, feed line |
| `combat.end` | — | Clears combatants, round 1 (keeps phases, `showMobHp`). Event `combat.end` |
| `combat.next` | — | Next phase; after the last one round + 1. Event `combat.phase {round, phaseIndex, phase}` |
| `combat.set` | `phases?` (1..8 names ≤ 40), `phasesVerified?`, `round?`, `phaseIndex?`, `showMobHp?` | Tracker settings |
| `combat.addMob` | `sourceId`, `kind?` (`monster`/`boss`, default: monster, then boss), `count?` [1] (1..20), `hidden?` [true] | Copies from the library; auto-numbered per source ("Goblin 2"; a lone "Goblin" becomes "Goblin 1"). Ack `result.uids` |
| `combat.addAdhoc` | `name`, `hp` (1..999), `evade?`, `dr?`, `count?`, `hidden?` [true], `notes?`, `attacks?` | Ad-hoc mob(s). Ack `result.uids` |
| `combat.addCrawler` | `playerId` | Adds a player that joined late |
| `combat.update` | `uid` (mob), `name?`, `hp?`, `hpMax?`, `evade?`, `dr?`, `notes?`, `hidden?` | Crawlers → `bad_request` (edit the sheet) |
| `combat.damage` / `combat.heal` | `uid`, `amount?` [1] (1..999) | Crawler: `track.set` delta on the sheet (`stat` event as usual). Mob: clamp 0..hpMax; a boss combatant whose boss is on the TV (`scene.kind boss`, same `bossId`) also runs `boss.damage`/`boss.heal`. Event `combat.hit` / `combat.heal` `{uid, type, name, playerId?, amount, hp, max, down}` — to the GM only for a hidden mob, else to all. Ack `result {hp, max}` |
| `combat.condition` | `uid`, `buffId` **or** `name` (≤ 40), `on` | Mob: condition chip (no duplicates, max 12). Crawler: `buff.add` / `buff.remove` on the sheet |
| `combat.remove` | `uid` | |
| `combat.reveal` | `uid` **or** `all: true`, `on?` [true] | Shows (or hides) mobs on the TV and phones. Event `combat.reveal {uids, names}` |
| `combat.mobRoll` | `uid`, `attackIndex?` [0], `public?` [false] | Rolls `d20+toHit` and then the attack's damage dice (skipped for empty / `0`) through `roll` → dice log, secret (GM only) unless `public`. Labels `"<mob>: <attack>"`. Ack `result {rollId, total, nat1, nat20, damageRollId, damage, effects, buffs, public}` |
| `npc.say` | `text` (≤ 300), `npcId?` **or** `name?` (default: the NPC on the TV) | TV subtitle in the NPC's name (no voice). Event `npc.say {npcId, name, image, text}` to stage + GM; on that NPC's `npc` scene also sets `data.line` / `lineAt` |

Scene kinds added to §3a: `combat` — `title` [""], `showParty` [true]; the TV draws `view.combat`.
`npc` — `npcId` (library) **or** ad-hoc `npc {name, role?, image?}` → `data.npc {name, role, image, floor}`,
`line` [""] (≤ 300), `lineAt`. Personality, voice tips, hooks and secrets are never copied into the scene.
All of these are GM-only actions (players and the stage get `bad_request: unknown action`).

### 3c. Sound desk and System voice (ElevenLabs)

The GM's notebook is the audio device (`show.audioDevice: "gm"`, wired to the soundbar); the TV is picture only.
Music stays in the Spotify app on the notebook (not integrated). SFX pads are client-side (`web/js/sfx.js`):
core pads from `/sfx/manifest.json` (original sounds generated by `tools/gen_sfx.mjs`) plus pack pads
(`gm.sfx`, see docs/CONTENT_PACKS.md). Nothing about pads goes over the socket.

The System voice uses ElevenLabs **on the server only**: `ELEVENLABS_API_KEY` (Cloudflare secret / Node `.env`),
optional `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID` (default `eleven_multilingual_v2`), `TTS_CACHE_MB`
(Node 200, Cloudflare 50). The key is never sent to any client and never appears in a view. Requests:
`POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_96`, header `xi-api-key`,
body `{ text, model_id, voice_settings: { stability, similarity_boost } }`; `GET /v1/voices`, `GET /v1/models`,
`GET /v1/user/subscription`. At most 2 requests in flight (live lines before pre-renders); `429` busy is retried.

Only **premade** and **generated** (designed from a text prompt) voices of the account are listed or accepted;
`cloned`, `professional`, `famous` and any other category are refused (`tts.no_voice`). There is no voice cloning.

**Cache**: key = SHA-256 of `voiceId + modelId + output format + whitespace-normalised text` (voice sliders are not
part of the key: clear the cache to re-render with new settings). LRU by last use, capped by size. Node:
`data/tts/<hash>.mp3` + `data/tts/index.json`. Cloudflare: Durable Object SQLite tables
`tts_meta(hash, size, at, chars, parts, voice, model, text)` and `tts_chunk(hash, part, data BLOB)`, audio split
into 1 MB rows (far below the per-row limit). Audio: `GET /api/tts/<hash>.mp3`, GM only (§7).

GM view adds `gm.tts` and `gm.sfx`:
```json
"tts": { "configured": true, "voiceId": "…", "voiceName": "Brian", "voiceFromEnv": false, "modelId": "eleven_multilingual_v2",
         "format": "mp3_44100_96", "stability": 0.5, "similarity": 0.75,
         "achievementLine": "auto", "achievementMode": "announce", "achievementDesc": true, "achievementReward": true,
         "cache": { "bytes": 0, "count": 0, "cap": 52428800 }, "usage": { "chars": 0, "lines": 0, "lastAt": 0 },
         "busy": 0, "lastError": null | { "at": 0, "code": "bad_key", "msg": "…" } },
"sfx": [ { "id": "hype_horn", "label": "Our horn", "url": "/pack/audio/sfx/horn.mp3", "hotkey": "Shift+KeyH", "volume": 0.8 } ]
```
`usage.chars` = ElevenLabs characters this campaign spent (cache hits are free); stored in `state.host.tts`
with the settings (kept across restores).

All actions below are **GM only**; players and the stage get an error. Failures answer
`{ ok:false, error:"tts.<code>" }` with `<code>` = `no_key` (no API key: browser voice only), `no_voice`,
`bad_key`, `quota`, `busy`, `offline`, `bad_request`, `upstream`.

| `t` | Fields | Effect |
|-----|--------|--------|
| `tts.say` | `text` (≤ 1000), `voiceId?` | Synthesizes (or finds cached) audio, then plays it as a P0 line whose `play.tts` is cached. Ack `result: {hash, url, cached, chars}` |
| `tts.line` | `id` (a recent `play` id) | The desk got a `play` without cached audio: render it now (1–2 s). Ack `result: {id, hash, url, cached, chars}` |
| `announce` | `text` (≤ 1000), `voice?` [true] | Free-text announcement: event `announcement` (`from` = pack `systemName`, `voiceCue`) to stage + gm, and a P0 voice line with `cue` = that event id. Works without ElevenLabs (browser voice). Ack `result.eventId` |
| `tts.voices` | `refresh?` | Ack `result: {voices: [{id, name, category, labels, description, hasPreview}], hidden}` (premade / generated only; `hidden` = refused voices) |
| `tts.models` | — | Ack `result.models: [{id, name, maxChars, costFactor, languages, description}]` (text-to-speech models) |
| `tts.preview` | `voiceId?` | Downloads the voice's own preview sample (no characters spent) into the cache. Ack `result: {hash, url, chars: 0}` |
| `tts.config` | any of `voiceId` (allowed voice or null), `modelId`, `stability` 0..1, `similarity` 0..1, `achievementLine` (`auto`/`announce`/`quip`), `achievementDesc`, `achievementReward` (bool) | Saves the campaign's voice settings. Ack `result.settings` |
| `tts.estimate` | — | Ack `result: {total, cached, remaining, chars, byKind, voiceId, modelId}` for every known line: pack quips without recorded audio, achievement announcements (in announce mode), boss `intro` / `defeatLine` (pack + homebrew) |
| `tts.prerender.step` | `confirm: true`, `exclude?: [hash]` | Renders up to 2 uncached known lines (2 in parallel). Stateless and resumable: the desk loops until `remaining` is 0, passing failed hashes in `exclude`. Ack `result: {total, cached, remaining, chars, done: [{hash, kind, chars}], failed: [{hash, kind, text, error, msg}], fatal}` (`fatal` = a key / quota / voice / network error: stop) |
| `tts.cache.clear` | — | Deletes every cached line. Ack `result: {cleared, bytes}` |
| `tts.account` | — | ElevenLabs quota. Ack `result: {tier, used, limit, resetsAt}` |
| `audio.started` | `id` | (also from the stage) the audio device started line `id`; the host sends `{ "t": "audio.started", "id", "cue" }` to every stage |

**Achievement announcements.** `achievementLine: "announce"` (or `auto` with a key configured) replaces the
achievement's voice line with `"<notifyPrefix> <title>. <desc> Reward: <reward>."` (desc/reward switchable).
A custom or edited achievement is rendered on the fly (the desk shows "Rendering voice…").

**TV sync.** With the GM desk as audio device every `play` carries `sync: true`, and an achievement / announcement
event whose line follows carries `voiceCue: true` (the line's `play.cue` = the event id). The TV holds the subtitle
and the takeover until `audio.started` (matching `id` / `cue`) or 3 s, so picture and voice start together.

## 4. Player actions

| `t` | Fields | Effect |
|-----|--------|--------|
| `secret.read` | `id` | Marks a message read for this player (private or group) |
| `me.notes` | `text` (max 2000 chars) | Player edits own notes (needs `playerEdit` ≥ `notes`) |
| `ping` | — | Keepalive, server answers `pong` |

### Sheet actions

Sent by players for **their own** character, or by the GM with `playerId`. A player's `playerId`, if sent,
must be their own (else `forbidden`); `role`/`actorId` in a payload are ignored — identity always comes from
the connection. The "player needs" column is the minimum `session.permissions.playerEdit`
(`play` = always allowed). Denials answer `{ ok:false, error:"forbidden" }`. Acks carry `result` for players too.

| `t` | Fields | Player needs | Effect |
|-----|--------|--------------|--------|
| `sheet.set` | `path`, `value` | `sheet` (`notes` for `story.*` and story fields) | Paths: `identity.<key>` (keys from `ruleset.identity` + name/level/race/class/floor/pronouns; `name`/`level`/`race`/`class` write the player's top-level fields), `stats.<id>` (number → the `statMod.from` part, or `{part: n}`), `stats.<id>.<part>`, `fields.<id>` (ruleset fields; fields that are identity/story keys are stored there), `story.<key>` (`storyFields` + `notes`; `notes` = the player notes), `portrait` (http(s) URL, `/pack/` path, or `data:image/...;base64` ≤ 200 000 chars, or null). Stat changes emit `stat` |
| `track.set` | `track`, `cur?`, `max?`, `delta?` | `sheet` | Sets stored max / cur; cur clamped to 0..computed max (incl. `maxFormula` and effects). Emits `stat` (`resource: true`) |
| `skill.add` | `skillId` **or** `name` + `stat?` + `checkType?`; `rank?`, `notes?` | `sheet` | Default rank `max(rankMin, 1)`. Ack `result.uid` |
| `skill.update` | `uid`, `rank?`, `stat?`, `checkType?`, `name?`, `notes?`, `used?` | `notes` for notes/used only, else `sheet` | |
| `skill.remove` | `uid` | `sheet` | Unlinks attacks that used it |
| `attack.add` | `name`, `skillUid?`, `stat?`, `dice?` (validated dice notation), `effects?` (text) | `sheet` | Ack `result.uid` |
| `attack.update` | `uid` + any of the above | `sheet` | |
| `attack.remove` | `uid` | `sheet` | |
| `spell.learn` | `spellId`, `rank?` | `sheet` | Ack `result.uid` |
| `spell.forget` | `uid` | `sheet` | |
| `spell.update` | `uid`, `rank?`, `active?` | `sheet` for rank, `play` for active | (extension) switch an active spell off/on |
| `spell.cast` | `uid`, `target?` (playerId, GM only unless it is the caster), `activate?` | `play` | Deducts the computed cost from `costTrack` (`not enough Mana: 1/3` → `bad_request`, nothing spent). Activates the spell if it has `when: "active"` effects (or `activate: true`). If the spell `applies` a buff: on `target`, else on the caster unless the buff is tagged `debuff`. Event `spell`, feed line. Ack `result: {cost, track, cur, active, applied}` |
| `item.equip` | `uid`, `slot` (ruleset slot id or null) | `sheet` | Enforces slot `max` and the item's own `slot` |
| `item.qty` | `uid`, `qty` (0..9999; 0 removes) | `sheet` | |
| `item.use` | `uid`, `target?` (playerId, GM only unless self) | `play` | Applies the item's `use`: heal a track, remove a buff, apply a buff (on `target`, or on the user when `use.target` is `"self"`; otherwise reported as `pendingBuff` for the GM), consume one (`use.consume`, default = stackable). Event `itemUse`, feed line |
| `hotlist.set` | `index`, `uid` or null | `sheet` | Hotlisted items count as equipped for effects |
| `roll` | `what`, `secret?` | `play` | `what`: `{kind:"stat", id}` → `dice + mod`; `{kind:"derived", id}` → `derived.roll + value`; `{kind:"skill", uid, markUsed?}` → `skills.check.roll + total`, marks the skill used; `{kind:"attack", uid, part?: "toHit"|"damage"}`; `{kind:"custom", formula, label?}` (formula may use sheet identifiers; GM may omit `playerId`). Server RNG (Web Crypto). Ack `result: {rollId, total}` |

### Rolls

Dice log entry (`state.rolls`, last 200; views get the last 50) — event `roll` carries the same object plus
`kind: "roll"`:
```json
{ "id": "r_...", "at": 0, "playerId": "p_x7", "by": "gm" | "p_x7", "what": "derived",
  "label": "Evade", "formula": "d20+3", "dice": [ { "die": "d20", "value": 20 } ], "total": 23,
  "breakdown": { "value": 23, "parts": [ {"label":"1d20","value":20,"source":"dice","rolls":[20]},
                 {"label":"Evade","value":3,"source":"derived.evade","parts":[...]} ], "warnings": [] },
  "secret": false, "nat1": false, "nat20": true, "rankUp": { ... } }
```
`what` = `stat` / `derived` / `skill` / `attack` / `custom` / `rankUp`. Event recipients: everyone, or
for `secret` the GM + the rolling player (a GM's secret roll is GM-only). `nat1`/`nat20` only when the roll
has exactly one d20; a non-secret nat 1/20 also queues a P1 voice line from quip category `nat1`/`nat20`.

### Hosted edition

The GM's browser runs the reducers for player actions relayed over the room channel. Call
```js
import { reducePlayerAction } from './engine.js';
reducePlayerAction(state, action, { playerId, pack, now?, randInt?, rollInt?, rng?, genId? })
// → { state, changed, events, lines, effects, result }  (same as reduce); throws ActionError
```
with `playerId` = the player assigned to the relaying user. It discards `role`/`actorId`/`rid` from the
payload and applies exactly the same permission checks as the Node server. `rollInt(n)` (0..n-1) overrides
the dice RNG (tests); default Web Crypto.

## 5. Stage actions

| `t` | Fields | Effect |
|-----|--------|--------|
| `audio.done` | `id` | Stage finished playing a queued line → server releases the next one |
| `audio.started` | `id` | The stage (when it is the audio device) started a line; relayed to other stages |
| `audio.pause` | `silent`: bool | (phase 3) table-silence detector; server only releases P1/P2 while `silent` is true. In phase 1 the server treats the table as silent |

## 6. Events (server → clients)

`{ "t": "event", "event": { "id", "at", "kind", ...payload } }`

| `kind` | Payload | Who receives |
|--------|---------|--------------|
| `achievement` | `playerId`, `achId`, `title`, `desc`, `reward`, `group` | all |
| `stat` | `playerId`, `stat`, `from`, `to` (+ `resource: true`, `max` for tracks) | that player + gm + stage |
| `roll` | the roll object (see [Rolls](#rolls)) | all, or gm + roller when secret |
| `spell` | `playerId`, `spellId`, `name`, `cost`, `track`, `applied` | all |
| `itemUse` | `playerId`, `itemId`, `name`, `healed`, `applied`, `removedBuff`, `consumed`, `pendingBuff`, `buffOnFail`, `note` | all |
| `loot` | `playerId`, `tier`, `item` (full inventory item, incl. `flavor`) | all |
| `sponsor` | `playerId`, `sponsor`, `tier`, `item` | all |
| `message` | `id` (= message id), `group`, `from`, `to` | recipients + gm (phone vibrates; text arrives in view) |
| `announcement` | `messageId`, `from`, `text` | stage (only for `msg.send` with `onStage: true` and a group recipient) |
| `secret` | `playerId`, `messageId` | legacy: also sent for every private message, to that player + gm |
| `viewers` | `viewers`, `delta` | stage, gm |
| `chat` | `user`, `text` | stage |
| `joinRequest` | `requestId`, `name` | gm (a phone asked to join, §1a) |
| `boss.intro` | `sceneId`, `name`, `title`, `intro` | stage, gm (TV cinematic; GM desk plays the sting) |
| `boss.hit` | `sceneId`, `amount`, `from`, `hp`, `max`, `suggestPhase` | stage, gm |
| `boss.heal` | `sceneId`, `amount`, `from`, `hp`, `max` | stage, gm |
| `boss.phase` | `sceneId`, `index`, `name`, `text`, `of` | stage, gm |
| `boss.defeat` | `sceneId`, `name`, `lootHint`, `lootTier`, `defeatLine` | stage, gm |
| `combat.start` / `combat.end` / `combat.phase` / `combat.reveal` | see §3b | all |
| `combat.hit` / `combat.heal` | `uid`, `type`, `name`, `playerId?`, `amount`, `hp`, `max`, `down` | all (gm only for hidden mobs) |
| `npc.say` | `npcId`, `name`, `image`, `text` | stage, gm |

Scene changes arrive as views; `boss.*` events carry `sceneId` and may arrive before the view of their
scene (views are debounced) — the stage holds them up to 4 s. Countdown ticks are computed on the client.

Audio (sent to the stage **and** the GM desk; only `view.show.audioDevice` plays it and acks):
```json
{ "t": "play", "id": "q_...", "priority": 0, "text": "line text", "audio": "/pack/audio/nat1_03.mp3" | null, "voice": { "id": "host", "lang": "en-US", "rate": 1.05, "pitch": 0.8, "prefer": ["Daniel", "Google UK English Male"] },
  "cue": "e_..." | null, "sync": true, "tts": { "hash": "<64 hex>" | null, "cached": false, "url": "/api/tts/<hash>.mp3" | null } | null }
{ "t": "stop" }
{ "t": "audio.started", "id": "q_...", "cue": "e_..." | null }
```
`tts` (only with ElevenLabs configured and no recorded `audio`): the GM desk plays the cached file, or sends `tts.line` when `cached` is false / `hash` is null (§3c), and falls back to the browser voice on any error or after 7 s. If `audio` is null the stage speaks `text` with the browser's `speechSynthesis` (English voice).
The audio device (stage, or GM desk via `audio.done` from the GM socket) must send `audio.done` when
finished or after a 12 s safety timeout. The other page shows the text as a subtitle only. Stingers
(boss intro, hit, heal, phase, defeat, dice tumble, nat 20/1, countdown ticks + klaxon) are generated with
WebAudio on the audio device; the voice line after a boss intro / defeat waits for its sting.
`/stage?preview=1#token` (the GM desk's mini-preview) never plays or acks anything.

## 7. Static routes

| Route | Serves |
|-------|--------|
| `/`, `/gm`, `/play`, `/stage` | `web/` pages |
| `/pack/*` | files from the active content pack directory (images, audio) — read-only, no path traversal |
| `/manifest.webmanifest`, `/sw.js` | PWA |
| `/qr?text=...` | SVG QR code generated server-side (no external service). The GM desk draws player QR codes in the browser (`web/js/qr.js`) so secret links never appear in a request URL |
| `/tv` | alias of `/stage` |
| `/join` | player page (join request when there is no personal link) |
| `/p/<token>` | player page for a personal link (`Cache-Control: no-store`) |
| `/api/info` | `{ edition, legacy, keyLogin }` — tells the player page whether room + PIN login exists |
| `/api/tts/<hash>.mp3` | GM only, header `X-GM-Key` (Node also `X-GM-Token`), same failure rate limit as the GM login; `401` / `429` / `404`. Cached System voice audio (`audio/mpeg`, `no-store`). The desk fetches it into a blob URL, so no credential ever sits in a URL |
| `/sfx/manifest.json`, `/sfx/*.mp3` | Core SFX pads (static, generated by `tools/gen_sfx.mjs`) |
| `/api/export?kind=session\|campaign` | GM only, header `X-GM-Key: <GM_KEY>` (Node also `X-GM-Token: <gmToken>`); same rate limit as the GM login. JSON download `{ format: "the-system-export/1", kind, edition, exportedAt, pack, session, state, log, snapshots }`. `session` = log since the current session started, `campaign` = everything. `state` contains the secrets (links, legacy tokens): treat the file like a password |

Every response carries `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff` and a Content-Security-Policy (`default-src 'self'`, `script-src 'self'`,
inline styles allowed, images also from `https:` and `data:`, `connect-src 'self'` + the ws(s) origin,
`frame-ancestors 'self'`). `/ws` and `/api/*` are never cached. Cloudflare: a non-WebSocket request to `/ws`
gets 426, unknown routes 404, raw pack JSON (`/pack/*.json`) is never served (the pack is compiled into the
worker).

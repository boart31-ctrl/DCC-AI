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
{ "t": "hello", "role": "player", "claim": true, "name": "Lucie", "campaignId": "c_…" }
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
| Player without a link | `hello {role:'player', claim:true, name, campaignId?}` → `{t:'claim', requestId, campaign:{id,name}, characters:[{id,name,color,connected}]}`. The phone may send `claim.pick {playerId}` (ack). The GM gets `joinRequest` and `gm.requests[]`, then approves a new character with `player.approve {requestId, create:true}` or assigns an existing one with `player.approve {requestId, playerId?}`. The phone receives `{t:'token', token, playerId}` followed by `welcome`. A stale campaign ID or a switch while waiting closes with `campaign_changed` (4001). `player.deny {requestId}` closes with `denied` (4001). Requests expire after 10 min (4002), max 6 waiting. |
| TV | `/tv` sends `hello {role:'stage', pair:true}` → `{ "t": "pairing", "code": "KJAM", "expiresAt": 0 }` (4 letters, no I/L/O, per socket, valid 10 min, then close 4002 and the page reconnects for a new one). GM `tv.pair {code, label?}` → that socket gets `{ "t": "paired", "tvToken": "…", "tvId": "tv_…" }` and `welcome` as `stage`. Later: `hello {role:'stage', tvToken}`. `tv.unpair {tvId}` revokes (sockets closed 4001 `revoked`). Max 3 TVs, max 6 screens waiting with a code. The GM's own browser may open the stage with the GM key instead. |

Secrets are never sent to non-GM roles: player views carry no tokens; a TV token is sent once, to that TV;
the GM view shows player links but never TV tokens or the GM key.

### 1b. Limits and close codes

| | |
|---|---|
| Message size | max 16 KB (host: close 1009). Exception: a GM / player `sheet.set` frame whose first 300 characters hold `"path":"portrait"` (or `identity.portrait`) may be up to 256 KB (portrait upload; Node ws `maxPayload` is 256 KB, the host checks the rest) |
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
    "stagesOn": 1,
    "access": { "edition": "cloud" | "node", "legacy": false, "keyLogin": true, "backups": true, "maxTvs": 3 }
  }
}
```
`stagesOn` = stage sockets on air right now (paired TVs and stage pages opened with the GM key); the desk's
TV button and setup checklist use it. Cloudflare edition: `gm.pins` is `{}` (no PIN login), `gm.joinUrl` / stage `joinUrl` = `<origin>/join`,
`gm.stageUrl` = `<origin>/tv`.

### Stage view
Common fields + `"joinUrl"` (for the QR code) + `"queueLength"`.

### Portraits
`players[]` (every role) carries `portrait`: a crawler's picture (`sheet.portrait`), so the TV strip, arena,
lobby and takeovers can show it. Uploaded pictures are data: URLs of up to ~150 KB; to keep views small the
host replaces every data: URL in a view (`players[].portrait`, `me.sheet.portrait`, `gm.playersFull[].sheet.portrait`)
with a ref `"portrait:<hash>"` and sends the pictures themselves once per socket, before the view that first uses
them: `{ "t": "portraits", "portraits": { "portrait:<hash>": "data:image/webp;base64,…" } }`. http(s) and `/pack/`
URLs pass through unchanged. Clients resolve refs with a cache (`portraitSrc()` in web/js/client.js).

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
| `ach.suggest.award` | `id` (from `gm.achSuggestions`) | Awards the suggested achievement (same as `ach.award`) and drops the suggestion |
| `ach.suggest.dismiss` | `id`, `never?` | Drops a suggestion; `never: true` = never suggest that achievement to that crawler again |
| `ach.settings` | `suggest?` (bool), `auto?` (bool) | Turns System achievement suggestions on/off. Suggestions come from pack achievement `trigger`: `{ on: roll\|evade\|kill\|down\|saved\|mark\|loot\|sponsor, nat?, deg?, what?, hit?, rarity?, mark?, partyFirst?, inRound?, streak?, count?, auto? }`; GM confirms, except `auto: true` (quiet) ones, which are given by themselves without a System line while `auto` is on (default). GM view: `achSuggestions`, `achRecent`, `achSettings`, catalog `on` |
| `scene.set` kind `chase` | `data: { mode: chase\|race, title?, quarry?: { name, image?, value? }, legs: [{ label?, skillId\|statId, value?, hazard? }] (1–8), playerIds?, npcs?: [{ name, value }], source? }` | Race or chase on the TV. Leg `value` = quarry's fixed result (default `quarry.value` or 12 + floor). Chase needs a seven-degree ruleset |
| `chase.leg` | `entries?: [{ playerId, entered }]` | Rolls the current leg for every crawler still in it (check + Move/10; NPCs use their fixed value). Chase: Amazing+ +2 Ground, Success +1, Near 0, Fail −1, Major −2, Critical fail out; 4+ caught early, −4 out; after the last leg 1+ caught. Race: places per leg, lowest sum wins. Ack `{ leg, results, done, result }`, event `chase.leg` |
| `chase.adjust` | `runnerId`, `ground` (−4..4) | GM override of a chaser's Ground (clever idea, hazard) |
| `chase.finish` | — | Ends the contest now with the normal result rules |
| `table.roll` | `id` | Rolls a random table (pack `tables.json` or campaign); `{XdY+Z}` rolled, `[[table]]` nested (depth 3), last 3 rows of that table not repeated. Ack `result` `{ id, tableId, table, die, roll, row, text, make }`, also in GM view `tables.recent` |
| `names.roll` | `list?`, `n?` (1–10, default 5) | Ack `result.names` from a pack name list |
| `crowd.gen` | `place?` (pack crowd place id), `n` (1–6) | Replaces `tables.crowd` with N quick NPCs `{ id, name, species, lines: [look, want, hook] }` (exactly 3 sentences) |
| `crowd.reroll` | `id` | Re-rolls one crowd person, keeps the rest |
| `crowd.save` | `id` **or** `all: true` | Saves to the campaign NPCs (library `npc`, homebrew, tags `campaign`, `met`, place); same name updates that NPC. Ack `result.npcIds` |
| `crowd.clear` | — | Clears the crowd |
| `table.keep` | `table?`, `text` | Keeps a result for tonight (`tables.kept`, last 60) |
| `loot.peek` | `tier` | GM preview: rolls the tier's table, gives nothing. Ack `result.item {id, name, rarity, image, desc}` |
| `loot.open` | `playerId`, `tier`, `itemId?` | Rolls pack loot table for tier (or takes the peeked `itemId`, which must be on that table), adds the item and opens its loot scene. The `loot` event carries `sceneId`. The live scene keeps the awarded item in `data.opened` until replaced |
| `item.give` | `playerId`, `itemId`, `qty?`, `bonus?` (0-3) | Direct give from the library (pack or homebrew), no animation. Stackable items merge into an existing stack with the same bonus (`qty` added). `bonus` = a +N copy: name `+N`, rarity at least uncommon/rare/epic, weapons +N to hit and damage (`attack.bonus`), armour +N to its `armor` effect |
| `item.enhance` | `playerId`, `uid`, `bonus` (0-3) | Make an inventory copy +N (0 = plain). Not for a stack of more than one |
| `item.remove` | `playerId`, `uid` | Also clears it from the hotlist |
| `quip.play` | `category` **or** `quipId` | P0: plays immediately on stage |
| `say` | `text` | P0: GM typed text, spoken via TTS fallback |
| `msg.send` | `to`: `"all"` or `[playerId, ...]`, `text` (max 1000; may be empty with `icon`), `icon?` (sticker id), `from?` (default pack `systemName`), `onStage?`: bool | Message to one, several or all players. Event `message` to recipients + gm. If `onStage` and it is a group message, stage also gets event `announcement` (text only, no audio — use `say` for voice) |
| `secret.send` | `playerId`, `text`, `from?` | Alias for `msg.send` with `to: [playerId]` |
| `msg.react` | `id`, `r` (reaction id: pack `ui.reactions` keys, else `like lol love wow sad fire skull party`) | Toggles the GM's reaction on a message |
| `msg.gmRead` | `thread` (`"all"` or sorted crawler ids joined by `,`) | Marks a conversation read on the desk |
| `msg.delete` | `id` | Removes a message for everyone |
| `msg.players` | `on`: bool | Lets crawlers write in the message centre (default on; `session.chatPlayers`) |
| `audience.bump` | `delta` (int, may be negative) | Viewers change, hype recalculated |
| `sponsor.box` | `playerId`, `tier?`, `sponsor?` | Loot box framed as a sponsor gift, event `sponsor` |
| `session.mode` | `mode`: `roleplay`/`combat`/`quiet` | |
| `session.auto` | `on`: bool | Master AUTO switch. Off also clears `pendingAuto` |
| `combat.mobAct` | `uid`, `attackIndex`?, `targetUid`?, `tv`? [true] | One chosen mob or boss attacks (GM-picked attack and target, else its own modes). Uses the same dangerous-hit preview, exact confirmation and undo as `combat.autoStep`. With `tv: false`, the committed dice and cinematic are GM-only. Damage still changes the crawler's sheet |
| `loot.corpse` | `uid`, `itemIds`? | Loot a downed combatant: a mob drops its library `lootItems` (or `itemIds`) and configured floor currency. A crawler drops their inventory. One pile per body in `state.drops` (GM view `gm.drops`); event `loot.drop` to all. Currency goes straight to the recipient's balance when confirmed. |
| `loot.confirm` | `dropId` or defeated `uid`, `playerId?` | Take all remaining items in one transaction. Falls back to the credited killer when the GM omits the recipient. |
| `combat.victoryLoot` | `items`: up to 20 entries `{id,qty}` | Stage item rewards for victory. The final credited blow suggests the recipient. |
| `combat.injury` | crawler `uid`, `severity` (minor or major), `description?` | Queue an injury for the end of the combat. The ruleset supplies a description when omitted. |
| `combat.injury.remove` | crawler `uid`, `injuryId` from `pendingInjuries` | Remove a specific queued injury. Use `buff.remove` for injuries already applied to a sheet. |
| `loot.take` | `dropId`, `key`, `playerId` | Hand one item of a pile to a crawler (a dead crawler's own item moves). Event `loot.take` to all |
| `loot.clear` | `dropId` | Forget a pile |
| `session.aiMute` | `on`: bool | Mute AI: System lines go out as text only (`play` gets `silent: true`, no audio/TTS), the audience chat stops, AUTO turns off and cannot be turned on while muted. Kept across `session.new` |
| `session.hold` | `on`: bool | Panic. On: `session.hold` true in every view (the TV shows a stand-by card over the scene and stops its audio), a running countdown pauses, AUTO turns off, pending auto lines are dropped. Off: the TV shows the scene again (countdown stays paused, AUTO stays off) |
| `session.budget` | `value` | Set remaining auto budget |
| `session.voice` | `voice` (id from pack `voices`) | Switches the System voice live; stage applies it to the next line |
| `auto.veto` | `id` | Cancels a pending P2 line |
| `queue.clear` | — | Stop everything: drops queue, sends `stop` to stage |
| `session.recap` | `text` (max 4000) | Sets `session.recap` ("Previously on…"), shown to everyone as top-level `recap` in every view. Cleared by `session.new` |
| `combat.addEncounter` | `mobs` [{`kind?`, `sourceId`, `count?`}] (1..20), `hidden?` [true] | Adds a saved group like `combat.addMob`; unknown ids skipped. Ack `result {uids, skipped}` |
| `prep.card.add` | `kind`: `achievement`/`loot`/`message`/`line`/`encounter`, `payload` (object), `label?` | Stores a prepared one-tap card; ack `result.id`. Payload = the fields of `ach.award` / `loot.open` / `msg.send` / `say` |
| `prep.card.remove` | `id` | |
| `prep.card.fire` | `id`, `playerId?`, `to?` | Runs the card's action with its payload (`playerId`/`to` override it), marks the card `used`. Same events/voice lines as the underlying action |
| `prep.adventure.add` | `title`, `template?` | Příprava: new adventure (neighbourhood, quest, dungeon) from an adventure template (default: the pack's flagged one, else built-in `adventure`); ack `result.id`. GM-only data in `view.gm.prep` |
| `prep.adventure.load` | `id` from `view.gm.prep.adventures` | Copy a pack's ready-made adventure, encounters and fog maps into the campaign. Reopening keeps GM edits and returns the existing ID. Published map art can be upgraded in place, with count in `result.upgradedMaps` when changed. |
| `prep.session.add` | `title?`, `template?`, `adventureId?`, `carryFrom?` | New session plan from a session template (default: pack's, else `lazy_session`). Unfinished items of `carry` sections are copied from `carryFrom` (default: current session); inherits its adventure unless `adventureId` is given (`null` = none). Becomes current. Ack `result {id, carried}` |
| `prep.session.current` | `id` (session) or `null` | Marks tonight's plan (drives "Within reach" on the Show tab) |
| `prep.evening.plan` | `adventureId?`, `key?`, `title?`, `minutes?` (1..1440) | Start tonight's session from a prepared evening in `view.gm.prep.evenings` or from scratch. Installs and links seeds once. A continuation carries unplayed scenes and unrevealed clues. Returns `{id,sceneId}`. |
| `prep.evening.build` | `title?`, `recipe` (1–12 of `hook`/`explore`/`check`/`fight`/`talk`/`trap`/`boss`/`chase`), `minutes?`, `suggest?` (default true) | New evening from scratch, becomes tonight, nothing carried over. With suggestions: fights get an encounter of floor monsters scaled to the party, boss a floor boss, hook/talk a new campaign NPC (look → read aloud, want → goal, hook → secret), check a check, trap/explore a rolled table complication. Ack `result` `{ id, sceneId }` |
| `prep.evening.update` | `id`, `title?`, `minutes?` (1..1440) | Update the session title or planned duration. |
| `prep.scene.add` | `id`, `type` (fight, explore, talk, trap, boss) | Append a scene and return `{sceneId}`. |
| `prep.scene.update` | `id`, `sceneId`, `patch` | Edit title, type, minutes, goal, readAloud, notes, checks, encounterId, mapId, npcs, items, secrets, played or chase (type `chase`: `{ mode, quarry, legs, npcs }`, Run puts it on the TV). The encounter and map IDs identify campaign content. |
| `prep.scene.move` | `id`, `sceneId`, `to` (zero-based) | Reorder within this evening. |
| `prep.scene.remove` | `id`, `sceneId` | Remove the scene from the evening. |
| `prep.scene.encounter` | `id`, `sceneId`, `mobs?` or `add? {kind,sourceId}` or `change? {index,kind,sourceId,delta?,hidden?,remove?}`, `mapId?` | Atomically create or edit the linked encounter. A row edit checks its source. Ack `{id,sceneId,encounterId,mapId}`. |
| `prep.scene.npc` | `id`, `sceneId`, `name`, `motive?`, `voice?` | Create a library NPC and add it to the scene. Ack `{id,sceneId,npcId}`. |
| `prep.scene.run` | `id`, `sceneId`, `fight?`, `tv?` | Marks the scene played, puts its resources in Within reach and sends it to the TV at once (`tv:false` keeps the TV): the fight if one started, else the scene's map, else an Explore card with its title and read-aloud text. Fight and Boss scenes start their linked encounter automatically. Other scene types wait for `fight: true` before starting their optional encounter. Repeating while that fight runs returns the existing combat ID. Protects unrelated active or queued fights. Ack `{id,sceneId,encounterId,mapId,combatId?,existing?,tv?}`. |
| `prep.doc.update` | `id`, `title?`, `adventureId?` (sessions only, `null` unlinks) | |
| `prep.doc.copy` | `id` | Duplicate with fresh item ids; ack `result.id` |
| `prep.doc.remove` | `id` | Sessions linked to a removed adventure are unlinked; current falls back to the newest session |
| `prep.section.update` | `id`, `key`, `text?`, `label?`, `hidden?` | |
| `prep.section.add` | `id`, `label`, `kind` (`text`/`list`/`refs`/`parts`), `carry?` | Extra section on one doc; ack `result.key` |
| `prep.section.remove` | `id`, `key` | Only sections the GM added (template sections can be hidden) |
| `prep.item.add` | `id`, `key`, `title?`, `text?`, `ref? {kind, id}`, `pin?` | `refs` sections need `ref` (kinds limited by the section, no duplicates); other sections need `title` or `text`. Ack `result.itemId` |
| `prep.item.update` | `id`, `key`, `itemId`, `title?`, `text?`, `done?`, `pin?`, `ref?` | `pin` = shown in "Within reach" |
| `prep.item.remove` | `id`, `key`, `itemId` | |
| `prep.item.move` | `id`, `key`, `itemId`, `to` (index) | |
| `prep.check.send` | `docId`, `sceneId`, `checkId`, `playerIds[]`, `requestId?` | Sends the saved scene's check to the chosen players. The check snapshots the applicable DC and sheet modifiers. `requestId` makes a retry return the original request ID. The GM sees degrees, totals, and outcomes in `view.gm.prepChecks[]`. |
| `prep.check.close` | `id` | Removes unanswered prompts and keeps submitted results visible to the GM. |
| `session.new` | — | Archives current session to `data/`, starts fresh (keeps players + inventories + homebrew + permissions; clears the dice log) |
| `session.permissions` | `playerEdit?`: `"none"` / `"notes"` / `"sheet"`, `allowOrigins?`: boolean (one or both) | What players may change on their own sheet (default `sheet`). `allowOrigins` (default off): players may *request* race / class / background (see `origins.*`) |
| `origins.approve` | `playerId` | Applies the player's `sheet.pending` race / class / background and sets `sheet.originsLocked` (the player can no longer change them; the GM still can) |
| `origins.deny` | `playerId` | Clears `sheet.pending` |
| `origins.lock` | `playerId`, `locked` (boolean) | Lock / unlock the player's origins without a request |
| `buff.add` | `playerId`, `buffId` **or** `name`, `effects?`, `external?`, `desc?`, `duration?` | Adds a buff. Enforces `buffSlots.external.max`. A library buff the character already has is not added twice (`result.added: false`) |
| `buff.remove` | `playerId`, `uid` | |
| `skills.rankUp` | `playerId?` (all players if omitted), `when?` (`session` by default or `floor`) | Rolls for eligible marked skills and attack spells and clears their `used` marks. If the ruleset sets `sessionMaxRank`, `session` covers ranks up to that threshold and `floor` covers higher ranks. Without a threshold, the session check covers all ranks. Each roll compares `skills.rankUp.roll` with `target` using `rule` and adds `amount` up to `rankMax` or the lower cap on a spell. The dice log includes `rankUp: {skillUid or spellUid, name, rule, target, success, from, to}`. Ack `result.results: [{playerId, uid, name, roll, target, success, from, to, rollId}]` |
| `lib.upsert` | `kind` (`item`/`spell`/`skill`/`buff`/`feature`/`race`/`class`/`background`), `entry` | Create/update homebrew (validated like pack files; strict: any invalid part is an error). `entry.id` optional (generated `hb_...`). Ids of pack entries are refused (duplicate under a new id). Ack `result: {id, created}` |
| `lib.remove` | `kind`, `id` | Homebrew only (pack entries are read-only → `not_found`) |
| `lib.give` | `playerId`, `kind` (`item`/`spell`/`skill`/`buff`), `id`, `qty?` / `rank?`, `bonus?` (items) | Item → inventory, spell → learned, skill → added, buff → `buff.add` |

The GM may also send every action in [§4 Sheet actions](#sheet-actions) (with `playerId` required, except
`roll` with `kind: "custom"`), without permission checks.

Access, devices and backups (handled by `server/host.js`, both editions):

| `t` | Fields | Effect |
|-----|--------|--------|
| `player.relink` | `playerId` | New personal link; old token refused, its sockets closed (4001 `relinked`). Ack `result: {playerId, joinUrl}` |
| `player.approve` | `requestId`, either `create:true` or `playerId?` (defaults to the phone's pick) | Creates a character named after the request or assigns an existing character (see §1a). Ack `result: {playerId}` |
| `player.deny` | `requestId` | Declines a join request |
| `tv.pair` | `code` (4 letters, case-insensitive), `label?` | Pairs the screen showing that code. Ack `result: {tvId}`. Max 3 TVs |
| `tv.unpair` | `tvId` | Revokes that TV |
| `backup.list` | `lastFight?` | With true, returns only the newest pre-fight point for the current campaign. Ack `result.backups: [{id, at, reason, size?}]`, newest first |
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
default look for the GM desk and phones (a device's own choice wins). `pack.ui` is the pack's normalized `ui.json`
(asset URLs only: `{ src, still, strip? }` per slot, see CONTENT_PACKS.md) or `null`; clients fall back to their CSS
look for every missing slot.

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
| `scene.set` | `kind`, `data?` | New scene (new `id`, `since` = now). `data` is validated per kind; unknown fields → `bad_request`. Boss: `bossId` **or** ad-hoc `boss` (name required, `hpSlots` 1..100, ≤10 phases); HP starts full. Explore: `locationId` fills location/floor/image/text from the library location (other fields override). Countdown: `seconds` (1..86400), `autostart?`. Map: `mapId`, `showFeed?` (content in `view.maps`) |
| `scene.preview` | `kind`, `data?` | Dry run of `scene.set` for the desk's preview: same validation, nothing changes. Ack `result: {scene}` (the stage's scene view; a boss is already revealed) |
| `scene.update` | `data` | Shallow merge into the current scene's data, same validation (no transition on the TV). Boss: `hp`, `phase`, `revealed`, `defeated`, `lootHint`, `bossId`/`boss` (swap). Countdown: `label`, `seconds` (resets), `running` |
| `scene.roll` | `playerId?`, `formula?` [d20] **or** `what?` (as `roll.what`), `label?`, `name?` — or `rollId` (re-show a public dice-log roll) | Rolls exactly like `roll` (dice log, `roll` event, nat1/nat20 line), then sets the `roll` scene. Ack `result: {rollId, total, sceneId}` |
| `scene.check` | `mode` (single or party), `dc` (−10..99), `skillId` or `statId` (single only), `entries: [{playerId, entered?}]`, `label?` | In seven-degree crawler campaigns, roll one check per selected crawler using their sheet. `entered` is a kept physical d20. Party checks apply exceptional results to other members and need at least half to pass. Sets the `roll` scene with individual results and the verdict. A fresh `scene.set` or `scene.preview` of kind `roll` may carry `data.dc` to display the target before rolling, or `data.scored: true` for the scored layout without a DC. |
| `scene.check.start` | `mode` (single/party), `skillId` or `statId` (single only), `dcType` (`stat` 10+F · `unopposed` 10+2F · `opposed` 10+mod+F · `fixed`), `mod?` or `against? {kind: mob\|monster\|boss, uid\|id, stat}` (opposed: the antagonist's stat block gives the mod), `dc?` (fixed), `adv?` adv\|dis, `playerIds[]`, `dice` (`digital` app rolls now · `physical` + `entered? {playerId: face}` · `phone` each phone rolls or types), `showDc?` [false], `label?` | Seven-degree crawler campaigns. Holds a Big roll for the GM's reveal: TV `roll` scene `{scored, pending, people[{name, ready}]}` (no DC unless `showDc`), nothing in the dice log yet. GM sees dice, totals and degrees in `view.gm.showCheck`. Untrained = Disadvantage; one Adv + one Dis cancel. A new start replaces an unrevealed one. Ack `{id, dc, sceneId}` |
| `scene.check.enter` | `playerId`, `entered?` (1–20; omitted = app rolls) | GM types or rolls a crawler's die (also corrects one) before the reveal |
| `scene.check.favor` | `playerId`, `entered?` | The crawler spends 1 AI Favor to reroll before the reveal (never a natural 1, once) |
| `scene.check.reveal` | — | Resolves every entry with a die through `scene.check` (dice log, degree lines, phone verdicts, party verdict; `hideDc` unless `showDc`). Crawlers without a die are left out (`gm.showCheck.skipped`) |
| `scene.check.cancel` | — | Drops the held check; an unrevealed TV card shows "Called off" |
| `show.audio` | `device`: `"gm"` / `"stage"` | Which page plays the System voice and the stingers (default `gm`). Both pages receive `play`/`stop`; only the device plays and acks `audio.done`, the other shows the subtitle |
| `boss.intro` | `line?` [true] | `revealed = true`; event `boss.intro`; feed line; P1 voice line = boss `intro` text, else a quip from category `boss` |
| `boss.damage` | `amount?` [1] (1..9999), `rolled?`, `dr?`, `dtype?` | Applies a direct track adjustment by default. `rolled: true` converts rolled HP to whole slots after any typed protection, while `dr: true` also applies DR. Event `boss.hit` on damage, ack `result: {hp, max, suggestPhase}` with damage breakdown for a rolled hit. |
| `boss.heal` | `amount?` [1] | HP + amount (max hpSlots), clears `defeated`; event `boss.heal` |
| `boss.phase` | `index?` [next] | Event `boss.phase`, feed line and the matching phase image in scene and combat views. `bad_request` if there is no further phase |
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
| `combat.next` | — | Next phase; after the last one round + 1. Event `combat.phase {round, phaseIndex, phase}` |
| `combat.set` | `phases?` (1..8 names ≤ 40), `phasesVerified?`, `round?`, `phaseIndex?`, `showMobHp?` | Tracker settings |
| `combat.addMob` | `sourceId`, `kind?` (`monster`/`boss`, default: monster, then boss), `count?` [1] (1..20), `hidden?` [true] | Copies from the library; auto-numbered per source ("Goblin 2"; a lone "Goblin" becomes "Goblin 1"). Ack `result.uids` |
| `combat.addAdhoc` | `name`, `hp` (1..999), `evade?`, `dr?`, `count?`, `hidden?` [true], `notes?`, `attacks?` | Ad-hoc mob(s). Ack `result.uids` |
| `combat.addCrawler` | `playerId` | Adds a player that joined late |
| `combat.update` | `uid` (mob), `name?`, `hp?`, `hpMax?`, `evade?`, `dr?`, `notes?`, `hidden?` | Crawlers → `bad_request` (edit the sheet) |
| `combat.damage` / `combat.heal` | `uid`, `amount?` [1] (1..999), `rolled?`, `dr?`, `dtype?` | Default amount uses the target's track units. On damage, `rolled: true` applies typed protection then converts HP to whole slots. `dr: true` also subtracts DR with `combat.drMin` as the minimum. A blocked hit reports `blocked` and, if positive damage fell short of a slot, `belowSlot`. A direct hit that would drop or kill a crawler returns only `{confirmHit, name, amount, outcome}` (no mutation or broadcasts). Show the consequence and resend with the returned `confirmHit` to apply it. The crawler sheet or mob row updates, along with the linked boss scene. Event `combat.hit` / `combat.heal` goes only to the GM for a hidden mob and to all otherwise. |
| `combat.condition` | `uid`, `buffId` **or** `name` (≤ 40), `on`, `rounds?` (1..99) | Mob: condition chip (no duplicates, max 12). Crawler: `buff.add` / `buff.remove` on the sheet. `rounds`: counts down at each new round (phase wrap or initiative wrap) and wears off at 0 (feed line) |
| `combat.remove` | `uid` | |
| `combat.undo` | — | Takes back the GM's newest hand edit (`combat.damage` / `heal` / `condition` / `reveal` / `remove` / `update`, stack of 20). Mobs come back as they were (removed ones in their place); a crawler's HP comes back relatively (later heals stay), buffs as they were. GM view `combat.manualUndo {label, at, count}` or null. Ctrl+Z / Cmd+Z uses action timestamps to undo the latest hand edit, applied reaction hit or applied AUTO hit. Ack `result {undone, left}`; empty → `bad_request` |
| `combat.reveal` | `uid` **or** `all: true`, `on?` [true] | Shows (or hides) mobs on the TV and phones. Event `combat.reveal {uids, names}` |
| `combat.mobRoll` | `uid`, `attackIndex?` [0], `public?` [false] | Rolls `d20+toHit` and then the attack's damage dice (skipped for empty / `0`) through `roll` → dice log, secret (GM only) unless `public`. Labels `"<mob>: <attack>"`. Ack `result {rollId, total, nat1, nat20, damageRollId, damage, effects, buffs, public}` |
| `npc.say` | `text` (≤ 300), `npcId?` **or** `name?` (default: the NPC on the TV) | TV subtitle in the NPC's name (no voice). Event `npc.say {npcId, name, image, text}` to stage + GM; on that NPC's `npc` scene also sets `data.line` / `lineAt` |

| `combat.target` | `uid`; crawler: `aggro?` (1..9, default 3), `noTarget?`; mob: `targetMode?` (`auto`/`focus`/`spread`), `focus?` (crawler uid or null; sets `focus` mode), `attackMode?` (`first`/`random`) | Auto-mode targeting. `auto` = weighted random by `aggro` among valid crawlers; `focus` = that crawler while valid, else auto; `spread` = round-robin (one pointer per fight). Valid = in the fight, not `noTarget`, HP > 0 (or `settings.finishDowned`) |
| `combat.set` `settings` | `{ hitRule?: ">="\|">", drMin? (0..5), crit?: "double"\|"none", evadeBase? (0..30), public?, includeHidden?, finishDowned?, stepMs? (1200..4000), autoEnd?, showThreat?: bool }` | Auto-mode rules; `hitRule`, `drMin`, `crit`, `evadeBase` are **unverified** (GM view `combat.unverified`). `showThreat` defaults to `false` and enables the active fight's threat meter on the TV. `combat.set {showThreat: bool}` can also set it directly |
| `combat.autoStep` | `includeHidden?`, `public?` | Resolves one mob attack (queue built on the first call). The mob picks its attack and target, rolls against the target's defense, and applies damage after DR and any hit effects to the sheet. Only committed dice enter the log as `roll.auto: true`. Ack `result: {autoId, sequence: [Step], left, startAt, stepMs, suggestEnd}` or `{sequence: [], preview: {id, danger, step}}` for an attack that would leave its target at 0 HP or damage a Dying target. `danger` is `down`, `dying` or `death`. The preview is GM-only and leaves sheet health and the dice log intact |
| `combat.auto` | `includeHidden?`, `public?`, `confirmAll?` [false], `dryRun?` | Defaults to one attack. With `confirmAll: true`, commits the safe prefix of the remaining queue and stops at the first dangerous preview. The ack may contain both committed `sequence` entries and `preview`. `dryRun: true` simulates the queue without state changes or events |
| `combat.autoConfirm` | `previewId` | Applies the exact one pending attack with its stored rolls. Rejects a stale preview when the attack, target, rules or combat turn have changed. Returns the same committed result as `combat.autoStep` |
| `combat.autoCancel` | `previewId` | Dismisses the preview without applying it. A current queued attack is skipped; a stale attack remains in the queue for recalculation |
| `combat.autoUndo` | — | Reverts the latest committed auto attack, restoring its health, Dying, conditions, stats and queue position when applicable. Event `combat.autoUndo {autoId}` |
| `combat.autoSkip` | — | Event `combat.autoSkip {autoId}`: the TV jumps to the end of the cinematic, the desk drops queued SFX, delayed voice lines play now |
| `combat.end` | `outcome?` (`victory`/`defeat`/`runaway`/`truce`/`special`/`sponsor`/`timeout`/`stalemate`), `title?` (≤ 60), `text?` (≤ 400; `special` needs one of them), `line?` [true], `scene?` [true] | Clears the board (keeps phases + settings). With an outcome: scene `finale`, P1 line from quip category `combat_<outcome>` (delayed ~1.6 s), chat burst `combat_<outcome>`, feed line, summary archived in `state.combatLog` (last 30, cleared by `session.new`; GM view `gm.combatLog`, last 10). Ack `result: {outcome, summary, sceneId}`. Event `combat.end {outcome, title, text, summary, sceneId}` |

`combat.damage` / `combat.heal` also take `by?` (playerId): damage to a mob counts for that crawler in the summary
(without `by`: the crawler with the newest dice-log roll in this fight within 90 s, a heuristic). A crawler reaching 0
queues a `crawler_down` line, a revealed mob reaching 0 a `mob_killed` line (P1, `crit`, i.e. also in combat mode).

`Step` = `{ i, slot, mobUid, mob, image, hidden, boss, attack, attackIndex, targetUid, playerId, target, color, evade,
drValue, hpBefore, hpAfter, max, d20, toHit, total, rule, margin, hit, nat20, nat1, crit, damageRoll?, damageRaw?, damage,
down?, buffs: [names], rollId, damageRollId? }` or `{ i, mobUid, mob, attack?, skipped: "no valid target" | "no attacks" }`.
`slot` = position in this cinematic. TV / phone copies drop `rollId`, `damageRollId`, `mode`; a hidden attacker becomes
`mob: "Something unseen", mobUid: null, image: null`.

Event `combat.auto` = `{ autoId, startAt (server ms), stepMs, beats: {lunge, swing, roll, result, down} (fractions of
stepMs), round, steps }` to the GM and (public copy) to stage + players. Step k starts at `startAt + slot × stepMs`.
The TV plays it as a cinematic (lunge, d20, hit / miss / crit / natural 1, DOWN stamp) and shows each crawler's HP
from before the run until their step; the GM desk plays SFX pads on the same beats (Show → Sound → Combat sounds).
Voice lines and chat bursts carry a delay so they land on their step (host: `line.delayMs`, `chat.cue` events that
reach no client: `{cue, fill, delayMs}`).

GM `view.combat` adds `id`, `startedAt`, `settings`, `unverified`, `stats {dealt, taken, downs, kills, mobDamage,
unattributed}`, `lastAuto {id, at, steps, canUndo, undone, startAt, stepMs}`, `lastAutoUndo {at}`, `autoQueue {id, uids, done}`,
`autoPreview {id, danger, step}` (present while a dangerous automatic attack is waiting for the GM),
`suggestEnd` (`"victory"` when every revealed mob is down, `"defeat"` when every crawler in the fight is; null with
`settings.autoEnd` off) and `defense {evade, dr}` (the ruleset labels used); crawler rows add `aggro`, `noTarget`,
`evade`, `dr`. The desk offers the suggested ending with a 3 s toast (Cancel) after the cinematic.

GM `view.combat.danger` contains `{label, level, rounds, score, trend, hidden, visible, reason?}`. `rounds`
estimates the time until the first crawler falls, or `null` when there is no estimate. `trend` is `up`, `down`
or `steady` relative to the last material board change or round start. The shared Prep estimate uses
`dangerParty` (all campaign characters with current health, slot value, defenses, level and status),
`dangerRules` (effective combat rules) and `dangerFloor`. An active fight estimates the current combat roster.
With `showThreat` on, the stage view gets only `threatMeter {label, level, trend}` from revealed foes.

The player's private `view.combat.history` lists up to five recent personal outcomes, newest first. Entries are
`{ id, kind, label, detail?, result?, total?, die?, amount?, round, phase, at }` with kinds `incoming`, `attack`,
`evade`, `action` and `heal`. A resolved or skipped attack replaces the corresponding Evade row. Linked hit and
damage rolls share one row. Undo removes or restores the recorded outcome. The latest fight's history remains
visible after combat ends and clears when a new fight or session starts. Results are personal and reveal no
hidden attackers or GM-only roll data.

Scene kind `finale` — `outcome`, `title`, `text`, `summary {rounds, dealt, taken, mobsDefeated, mobsTotal, downs, standing,
crawlers: [{playerId, name, color, dealt, taken, downs, kills, down}], mvp: {playerId, name, color, dealt, kills} | null,
tracked}`, `at`. Set by `combat.end`; `scene.set` with `outcome` / `title` / `text` replays one (no summary).

`portraits.want` `{ refs: ["portrait:<hash>"] }` (any authenticated view role): the host sends those pictures again,
one `portraits` frame each (pictures always travel one per frame; a frame that failed to send is not counted as
delivered). Clients ask when a ref in a view has no picture in their cache.

Scene kinds added to §3a: `combat` — `title` [""], `showParty` [true]; the TV draws `view.combat`.
`npc` — `npcId` (library) **or** ad-hoc `npc {name, role?, image?}` → `data.npc {name, role, image, floor}`,
`line` [""] (≤ 300), `lineAt`. Personality, voice tips, hooks and secrets are never copied into the scene.
All of these are GM-only actions (players and the stage get `bad_request: unknown action`).

### 3b-2. Turn order, dice entry, campaigns (docs/RULESETS.md)

| t | fields | does |
|---|---|---|
| `combat.initRoll` | `uids?` | Rolls initiative for those (default: everyone without a total); crawlers use their sheet |
| `combat.initiative` | `uid`, `total` | GM types a total |
| `combat.order` | `uids` | GM drag order (manual from then on) |
| `combat.turnSet` | `uid` | Makes it that combatant's turn |
| `combat.next` | | Turn-order fights: next turn (first press starts round 1). Phase fights: next phase |
| `combat.set` | `settings.initiative`: `true` / `false` / `null` | Turn order on / off / as the ruleset says |
| `combat.set` | `settings.groupInit`: boolean (default `true`) | Mobs from the same library entry share one initiative roll and sit together |
| *(player)* `init.mine` | `die` (1..dice sides) | Phone initiative pad (physical dice, no dice entry): the face of the real die; the server adds the sheet initiative (else DEX mod), slots the crawler in, returns `{total, die, bonus, place, of}` |
| `roll.void` / `roll.restore` | `id` | Cancel / bring back a roll (damage it applied goes back / returns) |
| `roll.undoLast` / `roll.redoLast` | | Undo / redo chips: the last player roll that hit or damaged something |
| `campaign.list` | | `{ current, campaigns, choices, multi }` |
| `campaign.new` | `name?`, `ruleset?`, `force?` | Parks the running campaign, starts a new one with that ruleset (locked). Refused mid-fight / on Hold unless `force: true` |
| `campaign.switch` | `id`, `force?` | Parks the running campaign, runs that one. Refused mid-fight / on Hold unless `force: true` |
| `campaign.rename` | `name` | |
| `campaign.delete` | `id` | Parked campaigns only |

`POST /api/import` (X-GM-Key) with an export / backup file restores that campaign. View: `campaign` {id, name,
ruleset} for everyone; GM `rulesetChoices`, `access.campaigns`. `combat.init` = `{ on, order, turnUid, waiting,
manual }` (totals for the GM only); `combat.defenseLabel`; GM `combat.rules`.

### 3b-3. Maps with fog of war (server/maps.js)

`view.maps`: GM = every map in full; TV = only the map on air (scene kind `map`, `data.mapId`); phones = maps with `phones: true` plus the one on air. TV and phones get revealed zones only (`{id, name, shape, text}`, never `notes`), the fog bitmap (`cols × rows`, base64, row-major, LSB first), the tokens that are not hidden and the drawings that are not GM-only (`strokes`). A mob token bound to a combatant (`ref` = uid, set by `enc.run`) is hidden while the mob is hidden and carries `down: true` once it is down or gone. `tokensOn` only lets players drag their own token. Coordinates are 0..1 of the image.

Map views may include an alternate `fallbackImage`. The GM view also includes authored `mobStarts`, used in encounter order when creating tokens. Existing tokens keep their positions. A prepared map can upgrade from its exact published fallback SVG to current art and refit unedited zone geometry while preserving map and zone IDs, reveal state, fog and tokens.

| Action | Payload | Notes |
|---|---|---|
| `map.add` | `name`, `image` (URL, /pack/ or /art/ path), `fallbackImage?`, `aspect?` (w/h, 0.2..5), `mobStarts?` (up to 40 `[x,y]` pairs) | Ack `result.id`. |
| `map.update` | `id`, `name?`, `image?`, `fallbackImage?`, `aspect?`, `phones?`, `tokensOn?` | A new aspect resamples painted fog at the same relative coordinates. Changing the image clears its old fallback unless one is supplied. `fallbackImage: null` explicitly clears it. |
| `map.camera` | `id`, `zoom` (1–4), `x?`, `y?` (normalized image center) | GM-controlled camera mirrored by the TV when this map is on air. Coordinates clamp to the image edges. Zoom 1 fits the entire map. Phones keep their own full map. Ack `{ camera: {zoom,x,y} | null }`. |
| `map.remove` | `id` | |
| `map.fog` | `id`, `rect {x,y,w,h}` + `reveal` (bool) — or `all` (true reveals everything, false covers it and hides every zone) | Event `map.fog` when the map is on air |
| `map.zone.add` | `id`, `name`, `shape` (`{x,y,w,h}` or `{points:[[x,y]…]}` 3..40), `text?`, `notes?` | Ack `result.zoneId` |
| `map.zone.update` | `id`, `zoneId`, `name?`, `shape?`, `text?` (read-aloud), `notes?` (GM only), `links?` `[{kind: monster/boss/npc/location/item/card, id}]` | |
| `map.zone.remove` | `id`, `zoneId` | |
| `map.bindCombat` | map `id` or null | Attach the current combat to a map, add any missing tokens, or detach. |
| `map.toFight` | map `id` | Start normal combat with revealed monsters and bosses placed on this map. Keep token positions and existing combatant IDs. A matching active fight stays unchanged. A different active or prepared fight is protected. Ack `result {mapId, started, added}`. |
| `map.zone.reveal` | `id`, `zoneId` (use `0` for the area outside all drawn zones), `on?` (default true) | Event `map.reveal {mapId, zoneId, name}` when on air or shared |
| `map.token.add` | `id`, `kind` (`pc` with `ref` = player id, one per crawler · `mob` · `mark`), `label?`, `color?`, `x?`, `y?`, `hidden?` | Mobs start hidden. Ack `result.tokenId` |
| `map.token.party` | `id` | A token for every crawler without one; ack `result.added` |
| `map.token.move` | `id`, `tokenId`, `x`, `y` | |
| `map.token.update` | `id`, `tokenId`, `label?`, `color?`, `hidden?` | |
| `map.token.remove` | `id`, `tokenId` | |
| `map.stroke.add` | `id`, `pts` [[x, y]…] (2..300), `color?`, `gm?` | Pen line on the map; `gm: true` = only the GM sees it. Result `{ strokeId }` |
| `map.stroke.remove` | `id`, `strokeId` or `all: true` | Erase one drawing or all |
| `enc.save` | `id?`, `label`, `mobs` [{kind?, sourceId, count?, hidden?}], `mapId?`, `notes?`, `items?` [{id, qty?}] (kept when omitted; `given` survives) | Prepared encounter (prep card kind `encounter`), create or replace; never touches the fight. Changing / removing the map drops this encounter's tokens from the old map. Result `{ id }` |
| `enc.remove` | `id` | Deletes the saved encounter, its unbound map tokens and links to it in Prep. Tokens already bound to the current fight keep their positions and combatant links |
| `enc.tokens` | `id`, `party?` | Its mobs as map tokens (hidden like the mobs, positions kept on re-sync); `party` adds crawler tokens. Result `{ added, party }` |
| `creation.apply` *(player or GM + playerId)* | `background` {stageId: {option, skills}}, `weapon` {index} \| {name, like} \| {none}, `stats` {statId: n}, `method` array\|roll, `stuff` {slotId: {itemId} \| {name, icon?}} | Guided creation (ruleset `creation`): validated (array permutation / roll range, `pick` skills per stage, no skill from two stages), then skills at the stage ranks, the fixed + weapon attacks (with `dmgStat`), base stats mirrored, `identity.background`; stuff becomes `sheet.gearRequest`; sets `sheet.created` |
| `untrained.learn` | `skillId` (GM: `playerId`) | Learn one practiced skill at Rank 1 and clear the list. For packs with `ruleset.advancement`, the player uses `level.learn` and the GM can still use this action. |
| `untrained.clear` | `playerId?` (GM) | Wipe the tried-untrained list of one crawler or everyone |
| `roll` untrained | `what: { kind: 'untrained', skillId, stat? }` | Library skill not on the sheet: ruleset `skills.untrained` (DCC: Disadvantage forced, `mod.{stat} + buff.check`, no Ranks; Passive refused); the skill joins `sheet.untried` |
| `roll.favor` *(player)* | `rollId`, `entered?` | Spend 1 AI Favor (`fields.aiFavor`): reroll the d20 of your own roll once (never a natural 1); emits `rollUpdate`. Ack `result: {natural, total, vs, roll}` with target defence and margin omitted |
| `roll.intervene` *(player / GM)* | `rollId`, `entered?` (1–6), `playerId?` (GM) | +1d6 to someone else's missed check / attack vs a target, once per roll, not on stat checks; in reaction rounds costs one action; emits `rollUpdate` |
| `level.party` | `delta?` (default +1), `rankUp?`, `timed?`, `checkpoint?`, `phone?` | Changes everyone's level. `rankUp` also rolls marked skill advancement immediately. With an explicit play clock, `timed: true` consumes the due `view.gm.advancementClock.next` passed as `checkpoint` and queues each crawler's choices on their phone. A manual award can use `phone: true` to queue choices. Other games retain the action-gap estimate in `view.gm.playClock`. |
| `level.clock` (GM) | `op: start/pause/reset` | Explicit play clock for packs with `ruleset.advancement.intervalMinutes`. The GM view carries `{elapsed, sinceLevel, interval, next, dueAt, asOf, running, due}`. `interval` is in minutes, `asOf` is a Unix timestamp in milliseconds, and other times are elapsed play milliseconds. Reset starts a fresh paused clock. |
| `level.snooze` | `minutes` (5–240) | The reminder waits that much more play. |
| `level.advance` (player) | `id`, `uid`, `entered?` (1–20 for d20 rules) | Roll a skill or spell queued on your own `levelGrants`. Omit `entered` for the digital roll. Repeating the action returns the saved outcome. |
| `level.learn` (player) | `id`, `skillId` | Learn one queued practiced skill at Rank 1. Repeating the action returns the saved choice. |
| `rest.party` | `kind` from `ruleset.rests` | Outside combat, recover each standing character and advance the floor clock once by the configured hours. A missing clock or insufficient time rejects the entire action. Ack `result: {results, hours}`. |
| `crawlers.clock` | `hours?` (null = off), `advance?` (hours of game time), `shown?`, `scene?: true` | The clock tracks game hours left until the floor collapses. The pack sets its starting hours and the TV sees it when shown. Advancing to 0 emits `floor.timeup`. `scene` starts a new fictional scene and refreshes scene-limited spells. |
| `gear.approve` | `playerId`, `index?` | Gives requested starting things (custom ones become homebrew items) |
| `gear.deny` | `playerId`, `index?` | Drops one request or all |
| `enc.give` | `id`, `index`, `playerId` | Gives one of the encounter's prepared items (its qty) to a crawler; marks it `given` |
| `enc.run` | `id`, `start?`, `mapId?` | Mobs into the fight (each hidden as prepared), map tokens bound to the new combatants (they follow reveal / down), card marked used. `start` starts the fight. A map override applies to this run only. Result `{ uids, skipped, mapId, bound }` |
| *(player)* `map.token.move` | `id`, `tokenId`, `x`, `y` | Own crawler's token only, only while `tokensOn` |

### 3b-4. Reaction rounds (server/reaction.js) — games where the GM never rolls a d20

Round = `declare` → `react` → `resolve` → `act` → `cleanup`. Each crawler has 2 base actions a round. Interrupts use those actions or a non-attack action bought with AI Favor. `view.combat.rx` = `{round, step, steps, decls, acts {uid: left}, nonAttackActions {uid: left}, favor [uid], evading [uid], intervene [uid], log}`. Declaration fields include `{id, mobUid, mob, attack, area, targetUid, caught, taunted, result (evaded/half/hit), damage, freeEvade, canEvade, canReroll, evade {degree, label, die, helped, free}}`. The GM also sees `dc`, `damageDice`, and `evadeTotal`. Players never see the difficulty or hidden mobs' attacks. Degrees: crit · amazing (beat by 10+) · success · near (miss by 1–2) · fail · major (miss by 10+) · critfail. Evade difficulty = attack `dc` if the content has one, else 10 + `toHit`.

| Action | Payload | Notes |
|---|---|---|
| `rx.start` | | Starts reaction rounds for the running fight in Declare, with 2 base actions each. Cannot restart a round already in progress. |
| `rx.declare` | `mobUid`, `attackIndex?`, `targetUid` | Declare step only; ack `result.declId` |
| `rx.surprise` | — | Before round 1 (no declarations): the crawlers surprised the mobs → round 0, step act, one free action each; `rx.round` then starts round 1 |
| `rx.area` | `declId`, `area` full\|splash\|null | Mark a declared hit as Area of Effect (Evade halves) or splash ring (half damage; Evade leaves a quarter) |
| `rx.adv` | `declId`, `adv` adv\|dis\|null | Advantage raises the Evade DC by 5. Disadvantage lowers it by 5 and lets the target take a free Evade. |
| `rx.retarget` | `declId`, `targetUid?`, `attackIndex?` | Declare step: change the target, the selected attack, or both. |
| `rx.undeclare` | `declId` | |
| `rx.suggest` | `includeHidden?` (default true) | Fill unqueued attack slots for living, eligible mobs. Regular mobs get one attack each and elites or bosses get one per crawler. Manual edits remain queued. Hidden attackers stay hidden until Announce. Ack `{count,added,preserved,hidden,limited,reason,next,message}`. |
| `rx.step` | `to`, `force?`, `all?`, `token?`, `confirm?` | Announcing (`react`) validates the queued actors and targets, reveals the queued attackers and emits `rx.react {round, targets}` once. Use `act` directly when there are no declared attacks. Entering Resolve waits for missing Evades unless forced, then opens the queue. `all: true` runs the batch preview, or applies the batch if a current token and confirmation are supplied. |
| `rx.resolveNext` | `op?` (preview, apply, change, redirect, skip, undo), `all?`, `token?`, `confirm?`, `amount?`, `targetUid?` | GM. `preview` (default) rolls the next queued attack and returns its projection. `change` replaces the unmodified roll total (0–999). `redirect` selects a different crawler and clears the original target's Evade when applied. `skip` dismisses one attack. Each requires the current preview token except preview and undo. `apply` requires explicit confirmation when the hit causes Dying, death or zero health. Undo restores the last applied hit in the same round and reopens Resolve. It rejects an undo that would overwrite a more recent change to that crawler. |
| `rx.round` | `round?` (expected current round) | Clean up and start the next round in Declare. Finish or skip queued attacks before advancing. An already completed expected round returns `{ round, existing: true }` without ticking conditions again. Event `rx.round`. |
| `rx.evade` | `declId`, `die` (1..20) | GM enters a crawler's physical roll (same rules as the player action) |
| `rx.actions` | `uid`, `delta` (−3..3) | GM edit to the base action pool |
| *(player)* `rx.interrupt` | `kind` (`evade`/`intervene`/`catcher`/`heal`/`taunt`), `declId?` (catcher, taunt), `die?` (physical Taunt d20), `total?` (legacy Taunt check total) | Spends 1 action. React step (heal / intervene also in act). Innate Heal restores the caster's own health, requires missing health and enough Mana, and returns `{healed,mana,receipt}`. Catcher retargets to me and prevents Evade. Taunt with `die` uses the sheet’s skill check against 10 + mob Int mod + floor and redirects on success. `total` compares an already resolved table check to that DC. Event `rx.interrupt`. |
| *(player)* `rx.evade` | `declId`, either `die` (1–20) or `digital: true` | Roll an Evade. A disadvantaged attack or an attack redirected by Taunt at rank 5 or above allows a free Evade. After a failed free Evade, spending one action on the Evade interrupt allows one retry and covers the crawler's other attacks. Ack `{die,total,degree,label,near,free,receipt}`. Event `rx.evade`. |
| `rx.favor` | `uid` (GM), none (player) | During React or Act, spend one AI Favor on one extra non-attack action. Once per crawler each round. |
| *(player)* `rx.intervene` | `declId`, either `d6` (1–6) or `digital: true` | In React, add a d6 to an ally's open Evade roll. Spends one action or uses a previously prepared Intervene. Ack `{d6,degree,label,receipt}`. |
| *(player)* `rx.spend` | `n?` (1 or 2) | Spend non-attack actions during React or Act. Weapon and attack spell rolls use base actions through the roll handler. |

Reaction action receipts include `spent`, `actionsLeft` and `utilityLeft`. `spent` counts actions charged by this request, so each separate Evade roll and any previously prepared Intervene have zero additional action cost. Paid attack checks, spell casts, item uses and Hotlist preparation also return a receipt. Undoing an attack returns `refunded: 1` only if the original action phase is still open and the action was refunded.

The GM view exposes `rx.pending` with the declaration, current target, Evade result, `die [{term,count,sides,rolls,sum}]`, `raw` roll, adjusted `damage`, `afterDr`, `slots` lost, `before` and `after` health, `danger` (`dying`, `dead`, `down`, or null), injury description, and `token`. A hit samples its damage dice the first time it is previewed. A numeric attack formula uses that fixed amount. Refreshing or redirecting a previously rolled hit reuses its roll, and Apply never rerolls. Entering physical damage replaces the raw roll before Evade, DR and protection. Attack formulas may use `floor`. A hit applies ordinary conditions and a Major or Critical Fail can also apply conditional statuses. Typed immunity prevents those effects.

Pending injuries appear on the affected crawler as `pendingInjuries [{id,severity,desc}]` in the GM view and that player's own view. The GM can remove either severity before it becomes an active debuff when combat ends.

Before any attacks are queued, the GM's Declare view exposes `rx.suggestion { reason, next, message, mobs, targets }`. The same reason codes describe the result of `rx.suggest`: `no-crawlers`, `no-standing-crawlers`, `no-targets`, `no-mobs`, `all-mobs-down`, `no-attacks`, `blocked`, `hidden-excluded`, `already-queued`, `queue-full`, or null when attacks were added normally. `hidden` on the acknowledgment counts hidden attacks in the queue. Phones and TV receive neither this hint nor any declaration details before announcement.

Batch preview (`all: true`) returns `rx.batch {token,count,hits,victims}`, with victims identified by `{uid,name,danger}`. Batch apply always needs that token and `confirm: true`. If the targets or projected results change, the GM refreshes the quote. Committing a hit emits a public `rx.hit` with `combatId`, `declId`, attacker, target, result and both sides of the health transition. Its `combat.hit` event is tagged `animation: 'reaction'` so the TV can play each hit only once. `rx.resolved` fires when the queue empties.

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

### 3d. Crawlers remaining (server/crawlers.js)

The worldwide head count (DCC: "there are 412,345,118 crawlers remaining"). Campaign-level `state.crawlers`
(kept by `session.new`, restores and restarts; numbers from pack.json `crawlers`, CONTENT_PACKS.md). Every view
carries `crawlers`:
```json
"crawlers": { "count": 698230473, "at": 0, "now": 0, "floor": 2, "start": 698230473, "live": true, "running": true, "shown": true,
              "perHour": 0.1, "min": 700000000, "maxGapMs": 150000, "label": "Crawlers remaining",
              "last": { "at": 0, "from": 1608682407, "to": 698230473, "reason": "collapse", "label": "Floor 1 collapsed" } | null }
```
GM adds `speak`, `history` (last 20 drops `{at, floor, from, to, reason, label}`), `events` (`[{id, label, min, max}]`),
`nextFloor`, `nextStart`, `floorStart`.

**Live count.** `count` was right at server time `at`. While `live` (attrition `running`, a TV on air, a GM / player action
in the last 45 min) the count shrinks: `value(t) = min + (count − min) · (1 − perHour) ^ (min(t − at, maxGapMs) / 1 h)`
(floored; `t` = server time, `now` is the server time the view was built). Clients roll the digits with this formula
(web/js/crawlers.js); the host re-anchors (`system` action `crawlers.tick`) about once a minute while a TV is connected.
`maxGapMs` caps one step, so a long pause never costs more than 2.5 minutes of attrition. Every GM action first bakes
the current value into the anchor.

| `t` | Fields | Effect |
|-----|--------|--------|
| `crawlers.set` | any of `count` (0..1e10), `floor` (1..99), `start`, `running`, `shown`, `speak` (booleans) | Quiet edit, no event. `running: false` pauses attrition; `shown: false` hides the TV HUD and the phone counter; `speak: false` = System lead-in only, no number read out |
| `crawlers.adjust` | `delta` (non-zero integer) | Quiet ± correction (min 0) |
| `crawlers.drop` | `event` (pack event id) **or** `pct` (0..1] **or** `amount`; `label?`, `announce?` [true] | Kills that share / number (never below the crawlers at the table). Event `crawlers` (`moment: true`), feed line, chat burst `crawlers_drop`, P0 line from the event's quip category, chained number line. Ack `result: {from, to, lost}` |
| `crawlers.collapse` | `floor?` [floor + 1], `announce?` [true] | Floor collapse: count → that floor's start (±3 %, never up), `floor` advances, attrition resumes. Event `crawlers` (`reason: "collapse"`), quip category `crawlers_collapse`, chat `floor_collapse`. Ack `result: {from, to, floor}` |
| `crawlers.announce` | — | The System reads out the current count: event `crawlers` (`reason: "announce"`), quip category `crawlers_remaining` + number. Ack `result.count` |
| `crawlers.death` | `playerId?`, `announce?` [true] | A crawler at the table died for good: −1, feed "Carl died. N crawlers remain", quip category `death` + number, event `crawlers` with `moment: false` (HUD flash only) |

**Voice.** The lead-in is a normal quip line (recorded audio matched by quip id / text) carrying `chain: {text}`;
the voice queue plays the chained line (`numberLine`, e.g. "698,230,473 crawlers remain.") as soon as the lead-in
is `audio.done` (or timed out), skipping the queue and mode gates; a P0 that interrupts the lead-in drops it. With
ElevenLabs the host renders the chained text while the lead-in plays. The lead-in's `cue` is the `crawlers` event id
(the TV holds the takeover until `audio.started`, like announcements).

## 4. Player actions

| `t` | Fields | Effect |
|-----|--------|--------|
| `secret.read` | `id` | Marks a message read for this player (private or group) |
| `msg.post` | `to`: `"all"` or `[playerId, ...]` (the writer is added; `[]` = just me and the GM), `text?` (max 1000), `icon?` (pack `ui.stickers` id); text or sticker required | Message centre: the GM sees every conversation. Max 8 per 10 s. Refused while `session.chatPlayers` is off |
| `msg.react` | `id`, `r` | Toggles my reaction on a message addressed to me |
| `msg.read` | `thread` | Marks a whole conversation read |
| `me.notes` | `text` (max 2000 chars) | Player edits own notes (needs `playerEdit` ≥ `notes`) |
| `prep.check.reply` | `id` from own `view.checkPrompts[]`, `entered?` (1–20) | Omitting the face rolls digitally. Ack `{received:true,label,ability,die,modifier,total,degree,advantage?}` so the player sees the result (a retry returns the same). No DC. Each prompt contains only `{id,label,ability,advantage?}`. The DC and all outcomes stay in the GM view. |
| `scene.check.reply` | `id` from own `view.checkPrompts[]` (kind `show`), `entered?` (1–20; omitted = the phone rolls, with the prompt's advantage) | Once per crawler (the GM can fix it). Ack `{received, label, ability, die, modifier, total, advantage?}`, no degree: the GM reveals. The prompt then carries `rolled` and `canFavor` until the reveal |
| `scene.check.favor` | `id`, `entered?` | Own AI Favor reroll before the reveal. Ack `{die, modifier, total}` |
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
| `spell.ready` | `playerId`, `uid` | GM only | Clears any remaining cooldown for that known spell. |
| `spell.cast` | `uid`, `target?` (playerId), `activate?` | `play` | Pays the spell's resource cost and applies active/buff effects. A spell with `healing` restores its configured track; an ally-only heal accepts another player's ID, even from the caster's phone. In reaction combat with scoped spell checks, player casting spends one action after phase validation. Ack `{cost, track, cur, active, applied, healed?}`. Attack-check spells use `roll` below. |
| `roll` spell attack | `what: {kind:"spell",uid,part?:"damage"}`, `target`, `entered?`, `after?`, `useAction?` | `play` | A ruleset's `spells.attackChecks` enables attack rolls for spells configured with `attackCheck`. Uses the spell's rank and attack stat, pays the cost at the attack, then lets a successful roll apply damage once with `after` pointing to that hit. The damage includes the configured Rank 5 dice, applicable damage modifiers, crit and damage type. |
| `item.equip` | `uid`, `slot` (ruleset slot id or null) | `sheet` | Enforces slot `max` and the item's own `slot` |
| `item.qty` | `uid`, `qty` (0..9999; 0 removes) | `sheet` | |
| `item.use` | `uid`, `target?` (playerId) | `play` | Uses one item with the configured heal or buff effects. With `hotlist.combat`, players use prepared items for one utility action in Act. Health potions can also be used in React. Tagged potions may target another player, and if `hotlist.potionSickness` is set, a second potion on the same drinker within two rounds applies the configured debuff. Other item targeting stays GM-only. Event `itemUse`. |
| `hotlist.set` | `index`, `uid` or null | `sheet` | Prepare an inventory item. If `hotlist.combat` is enabled, known spell UIDs also fit, spell casts and item use in reaction combat require the corresponding Hotlist entry, and preparing a slot in the action phase spends a utility action. |
| `item.move` | `uid`, `into` (uid of a container item, or null = out) | `sheet` | Containers = library items with `container: true` or tag `container` (bag of holding). One level only: no containers inside containers. Equipping takes an item out; removing a container drops its contents into the backpack. Inventory entries carry `containerUid` (null = loose) and enriched `container: true/false` |
| `pool.add` | `name`, `max`, `cur?`, `desc?` | `sheet` | Counter on the sheet (`sheet.pools[]`: `{uid, name, cur, max, desc}`, max 20), e.g. Lay on Hands |
| `pool.update` | `uid`, `name?`, `max?`, `desc?` | `sheet` | |
| `pool.set` | `uid`, `delta` or `cur` | own character (like rolling) | Spend / regain, clamped 0..max |
| `rest` | `playerId` (GM), `kind` (`short`/`long` or a configured rest), `heal?` | Configured rests require a GM. They restore configured track values and clear matching buff IDs outside combat. Otherwise, `long` refills all tracks and counters and `short` refills short-reset counters and applies optional `heal`. Ack `result.restored` (labels). |
| `pool.remove` | `uid` | `sheet` | |
| `sheet.set` `identity.race` / `class` / `background` | `value` | — | Players: without `allowOrigins` → `forbidden` (re-sending the current value is a no-op). With it the value goes to `sheet.pending` (event `originsRequest {playerId, name, pending}` to the GM) until `origins.approve`; after approval → `forbidden` until the GM unlocks |
| `roll` | `what`, `secret?`, `useAction?` | `play` | `what`: `{kind:"stat", id}` → `dice + mod`; `{kind:"derived", id}` → `derived.roll + value`; `{kind:"skill", uid, markUsed?}` → `skills.check.roll + total`, marks the skill used; `{kind:"attack", uid, part?: "toHit"|"damage"}`; `{kind:"custom", formula, label?}` (formula may use sheet identifiers; GM may omit `playerId`). During reaction combat a targeted player attack spends one action on acceptance. For an untargeted attack `useAction: true` also spends an action. Undo in the same action phase refunds it. Targeted player weapon damage in reaction combat requires `after` pointing to a successful hit with the same weapon against that target, and applies once per hit. Server RNG (Web Crypto). Ack `result: {rollId, total, roll}` carries the actual dice and breakdown, with target defence and margin omitted for players. |

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


Dice entry (all optional): `entered` (the real die / what the damage dice showed), `adv` (`adv` | `dis`, phone
rolls), `bonus` (±50), `target` (mob uid: to-hit vs its defence, damage applied to it), `dc`, `after` (to-hit roll
id before a damage roll). The result adds `hit`, `crit`, `degree`, `applied`. `dice.mode {mode}` (`off` / `enter` /
`digital`), `roll.undo` (own last roll within 2 minutes). Players and the TV get `vs` without `defense` / `margin`.

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
| `chat` | `user`, `text`, `tag` (chat context it was picked for, see CONTENT_PACKS.md `chat.json`) | stage. Calm lines every few seconds while a stage is connected (faster in combat / boss scenes); a burst of 2–6 quick lines after a nat 20 / nat 1, boss intro / phase / defeat, a crawler going down, loot, achievements, countdown and recap scenes. The same moments bump `viewers` (system action `audience.react`). |
| `joinRequest` | `requestId`, `name` | gm (a phone asked to join, §1a) |
| `originsRequest` | `playerId`, `name`, `pending` | gm (a player asked for a race / class / background) |
| `boss.intro` | `sceneId`, `name`, `title`, `intro` | stage, gm (TV cinematic; GM desk plays the sting) |
| `boss.hit` | `sceneId`, `amount`, `from`, `hp`, `max`, `suggestPhase` | stage, gm |
| `boss.heal` | `sceneId`, `amount`, `from`, `hp`, `max` | stage, gm |
| `boss.phase` | `sceneId`, `index`, `name`, `text`, `of` | stage, gm |
| `boss.defeat` | `sceneId`, `name`, `lootHint`, `lootTier`, `defeatLine` | stage, gm |
| `combat.start` / `combat.end` / `combat.phase` / `combat.reveal` / `combat.auto` / `combat.autoUndo` / `combat.autoSkip` | see §3b | all (`combat.auto`: GM full, others the public copy) |
| `combat.hit` / `combat.heal` | `uid`, `type`, `name`, `playerId?`, `amount`, `hp`, `max`, `down` | all (gm only for hidden mobs) |
| `npc.say` | `npcId`, `name`, `image`, `text` | stage, gm |
| `crawlers` | `reason` (`collapse` / `announce` / `death` / `drop` / a pack event id), `label`, `labelText`, `from`, `to`, `floor`, `moment` (TV takeover: the number counts down from → to), `playerId` (death), `voiceCue` | all (§3d) |

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
| `/api/info` | `{ edition, legacy, keyLogin, campaign:{id,name} }` — room and PIN availability and the campaign accepting new requests |
| `/api/tts/<hash>.mp3` | GM only, header `X-GM-Key` (Node also `X-GM-Token`), same failure rate limit as the GM login; `401` / `429` / `404`. Cached System voice audio (`audio/mpeg`, `no-store`). The desk fetches it into a blob URL, so no credential ever sits in a URL |
| `/sfx/manifest.json`, `/sfx/*.mp3` | Core SFX pads (static, generated by `tools/gen_sfx.mjs`) |
| `/api/export?kind=session\|campaign` | GM only, header `X-GM-Key: <GM_KEY>` (Node also `X-GM-Token: <gmToken>`); same rate limit as the GM login. JSON download `{ format: "the-system-export/1", kind, edition, exportedAt, pack, session, state, log, snapshots }`. `session` = log since the current session started, `campaign` = everything. `state` contains the secrets (links, legacy tokens): treat the file like a password |

Every response carries `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff` and a Content-Security-Policy (`default-src 'self'`, `script-src 'self'`,
inline styles allowed, images also from `https:` and `data:`, `connect-src 'self'` + the ws(s) origin,
`frame-ancestors 'self'`). `/ws` and `/api/*` are never cached. Cloudflare: a non-WebSocket request to `/ws`
gets 426, unknown routes 404, raw pack JSON (`/pack/*.json`) is never served (the pack is compiled into the
worker).

### GM content ZIP import

`POST /api/content/import` accepts an `application/zip` body with `THE_SYSTEM_CONTENT_V1` content. It requires `X-GM-Key` (or `X-GM-Token` in the local legacy edition) and `X-System-Campaign-Id` for the open campaign. Requests with a browser Origin must be same-origin. A successful response is `201 { campaignId, entries: [{type,id,name}], missingImages: [path] }`. The updated library arrives in the normal state view. Failure responses carry `{error,msg}` when validation supplies details. A collision, campaign change, or concurrent import is `409`. The audit action is `lib.importContent` with a count. The HTTP host emits it after a single durable save. See [content import contract](CONTENT_IMPORT.md).

### GM map image upload

`POST /api/maps/image?name=…` creates a map. Use `?mapId=…` to replace the picture on an existing map. Send `image/png`, `X-System-Campaign-Id`, and `X-GM-Key` (or a GM token on local Node). The same-origin adapter validates the PNG and derives its aspect ratio. The map and its image save together. The response contains `{id,image}`, with status 201 for creation or 200 for replacement. Images use the campaign's existing media allowance and travel in campaign backups.

Solo map tokens may specify `sourceKind` and `sourceId` in `map.token.add` for monster or boss library art. `map.token.update` accepts a GM-only `notes` string up to 2000 characters. Tokens linked to combat follow the combatant's image, visibility, and defeated state. Moving a token updates its map coordinates.

| `rules.search` | `q` (≤200 chars), `limit?` (1–20) | GM only. Full-text search of the pack's `rules_index.json` (book, page, heading, passage). Changes nothing; the index is never in a view or a static file. Ack `{hits:[{book,page,heading,text,score}], total}`. |

| `loot.offers` | `playerId`, `tier`, `boss?` | GM. The System's offers for a box (loot-advisor.js): per item 3 candidates (on-build + wild card), the crawler's floor budget, held-back items. Read-only; call again to re-roll. |
| `loot.prefs` | `playerId`, `builds?` (≤3 of melee, ranged, defense, stealth, magic, social, support, crafty, boom, pet, utility), `lean?` 0..1, `block?` [itemId] | GM steering per crawler, saved as `player.lootPrefs`. |
| `loot.box` | `playerId`, `tier`, `boss?`, `itemIds` (1–8), `gold?`, `force?` | GM opens a box with the picked items: gives them + rolled gold, TV loot scene with the best item, System line, viewers. Items above the tier's reach need `force`. Ack `{uids, gold, warnings, fit}`. `item.give` acks `warnings` too. |
| `loot.settings` | `settings` {budget?, stretch?, wildcard?, pity?, offers?, drops?, fragileFactor?, dropsOff?} or `null` | GM. Campaign loot rules over the pack's `lootPolicy` (null = back to pack defaults). |
| `loot.prefs` | … `mode?` auto / catchup / standard / ahead | Reward mode per crawler (auto: C/D grade → catch-up, S → ahead). |
| `loot.box` | … `pendingId?` | Opening a waiting box (boss drop, achievement) removes it from `player.pendingBoxes`. |
GM view `gm.loot` = { floor, settings, policy, crawlers: [{ playerId, name, rating {score, grade, gear, coherence, level, items[{name, grade, power, onBuild, fragile}]}, mode, modeSetting, prefs, pendingBoxes }] }. Mob corpses roll `policy.drops` (pack-enabled); bosses drop a Boss box item that becomes a pending box when taken.

Inventory weapons with `fragile: {breakOn: "nat1"|"hit", chance: 0..1}` use their inventory UID in `roll.what.kind="attack"`. A qualifying strike tests the chance once. A break removes that copy and emits `item.broken` with the owner and item name for the feed, voice and phone. Undo restores the copy. A hit that breaks a weapon still permits its linked damage roll.
GM `scene.set` with `kind:"builds"` puts the party build analysis on stage. Only the stage and GM projections include the crawler scores, grades and top equipped items.

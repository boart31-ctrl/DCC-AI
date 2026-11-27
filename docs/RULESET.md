# Rulesets, character sheets and homebrew (v2)

The engine knows nothing about any specific game. A content pack may ship `ruleset.json` that describes
what a character sheet contains and how numbers are computed. Items, spells and buffs carry **effects**
that feed those computations. Everything a GM creates at the table (custom items, spells, skills,
buffs) lives in the campaign **library** and uses the same shapes.

Design goals: D&D Beyond-style sheet (every derived number shows its breakdown), no hard-coded rules,
safe formulas (no `eval`), GM can override anything.

## 1. ruleset.json

```json
{
  "id": "example",
  "dice": "d20",
  "stats": [
    { "id": "str", "label": "Strength", "abbr": "STR", "parts": ["enhanced", "unenhanced"], "default": { "enhanced": 3, "unenhanced": 3 } }
  ],
  "statMod": { "from": "enhanced", "formula": "floor((x - 10) / 2)", "verify": true },
  "derived": [
    { "id": "evade", "label": "Evade", "formula": "mod.dex + buff.evade", "display": "d20 + {value}", "roll": "d20" },
    { "id": "dr",    "label": "Damage Resistance", "formula": "field.armor + buff.dr" },
    { "id": "move",  "label": "Move", "formula": "field.move + buff.move" }
  ],
  "fields": [
    { "id": "armor", "label": "Armor", "type": "number", "default": 0, "group": "defense" },
    { "id": "aiFavor", "label": "AI Favor", "type": "number", "default": 0, "group": "defense" },
    { "id": "size", "label": "Size", "type": "text", "default": "Medium", "group": "defense" },
    { "id": "crawlerNumber", "label": "Crawler #", "type": "text", "group": "identity" },
    { "id": "popularity", "label": "Popularity", "type": "longtext", "group": "story" }
  ],
  "tracks": [
    { "id": "hp", "label": "Health", "kind": "slots", "slots": 10, "labels": ["10%", "20%"], "default": 10 },
    { "id": "mana", "label": "Mana", "kind": "pool", "maxFormula": "field.maxMana", "default": 0 }
  ],
  "slots": [
    { "id": "head", "label": "Head", "max": 1 },
    { "id": "accessories", "label": "Accessories", "max": 10 }
  ],
  "buffSlots": { "external": { "label": "External buffs", "max": 3 } },
  "hotlist": { "size": 10 },
  "skills": {
    "columns": ["rank", "stat", "checkType"],
    "rankMax": 15,
    "checkTypes": ["Standard", "Opposed", "Passive"],
    "usedTracking": true,
    "rankUp": { "roll": "d20", "rule": "gt", "target": "rank", "note": "verify with rulebook" },
    "catalog": [ { "id": "sneak", "name": "Sneak", "stat": "dex", "checkType": "Standard", "desc": "" } ]
  },
  "attack": { "toHit": "skill.rank + mod.{stat}", "damage": "{dice} + mod.{stat}" },
  "spells": { "costTrack": "mana" },
  "identity": ["name", "race", "class", "level", "floor", "pronouns", "crawlerNumber"],
  "storyFields": ["popularity", "pastTrauma", "looseEnds", "regrets", "notes"],
  "races": [], "classes": [], "backgrounds": []
}
```

Any key may be omitted; the engine falls back to the pack's old `stats`/`resources`.
`verify: true` / `note` marks values the pack author has not confirmed against the rulebook — the GM
UI shows a small "unverified rule" marker next to such numbers.

## 2. Formulas

A tiny safe expression language: numbers, `+ - * /`, parentheses, `floor ceil round min max abs`,
and identifiers:

| Identifier | Meaning |
|---|---|
| `stat.<id>` / `stat.<id>.<part>` | stat value (default part = `statMod.from`) |
| `mod.<id>` | stat modifier via `statMod.formula` (`x` = the stat value) **plus** effects targeting `mod.<id>` |
| `step(x, t1, t2, …)` | function: how many thresholds `x` has reached — a lookup table, e.g. `step(x, 1, 3, 6, 10, 20, 50, 100, 150, 200, 300)` gives 1 for 1–2, 2 for 3–5 … 10 for 300+ |
| `field.<id>` | numeric field |
| `buff.<target>` | sum of active effects with that target |
| `level` | character level |
| `skill.<id>.rank` | skill rank (in attack formulas `skill.rank` = the attack's linked skill) |
| `track.<id>.max` / `track.<id>.cur` | |

Unknown identifiers evaluate to 0 and are reported in the breakdown as warnings. Division by zero → 0.
`{value}` and `{stat}`/`{dice}` are display/template placeholders, not formula syntax.

**Breakdown:** every computed number returns `{ value, parts: [{label, value, source}] , warnings }`
so the UI can show "Evade 7 = DEX mod 3 + Buffs 4 (Ring of Dodging +2, Haste +2)".

## 3. Effects

```json
{ "target": "evade", "op": "add", "value": 2, "when": "equipped", "label": "Ring of Dodging" }
```
- `target`: `buff.<x>` shorthand is just `<x>` (e.g. `evade`, `dr`, `move`), or `stat.<id>`,
  `mod.<id>`, `skill.<id>`, `track.<id>.max`, `field.<id>`.
- `op`: `add` (default) or `set` (override; last wins) — `set` is rare, for "your DR becomes 10".
- `value`: number or formula string.
- `when`: `equipped` (item in a gear slot or hotlist-equipped), `carried` (in inventory), `active`
  (buff/spell currently active), `always`.
- Debuffs are effects with negative values; the sheet lists them under Debuffs.
- For rolled damage, a positive `resist.<type>`, `vulnerable.<type>`, or `immune.<type>` effect grants typed protection or vulnerability. Use the same lower-case damage type as the attack, for example `immune.sonic`.

Effect sources: equipped items, active buffs (incl. the capped *external* buffs), active spells,
race/class features, GM ad-hoc modifiers on a character.

Buffs may define `blocks` with `action`, `interrupt`, `spell`, or `heal`. The last restricts the recipient of health restoration. `rounds` counts down on round cleanup and `endCombat` removes the buff when the fight ends. Use both when either can end an effect.

## 4. Library (homebrew) — campaign-wide, GM editable

Kinds and shapes (all have `id`, `name`, `desc`, `tags[]`, `source: "pack" | "homebrew"`):

| kind | extra fields |
|---|---|
| `item` | `rarity`, `slot` (gear slot id or null), `stackable`, `effects[]`, `attack?` `{skill, stat, dice, effects:"text"}`, `flavor`, `image?` |
| `spell` | `cost` (number or formula), `costTrack`, `range`, `duration`, `effects[]`, `attack?`, `dice?`, `rankScaling?` (text), `cooldown?` (game seconds or `"scene"`) |
| `skill` | `stat`, `checkType`, `upgrades[]` (`{rank, text}`) |
| `buff` | `effects[]`, `duration`, `external` (bool, counts toward external cap), optional `blocks[]`, `rounds`, `endCombat` |
| `feature` | `effects[]` (race/class/background features) |
| `race`/`class`/`background` | `features[]` (feature ids), `statBonuses?` effects, `skills?` starting skill ids |

Pack content (`items.json` etc.) is loaded into the library as `source: "pack"` (read-only, but the GM
can "duplicate & edit"). Homebrew is stored in state and survives sessions.

A spell cooldown starts at cast, including a missed attack. The floor clock's `advance` moves game time. When configured, `combat.roundSeconds` adds that many seconds at the end of each completed round and enables minute-level advances on the GM desk. Each new encounter or floor starts a fictional scene. The GM can also start a scene explicitly from the clock controls or reset a single cooldown from a character's spell details.

## 5. Character (player) shape additions

```json
{
  "identity": { "race": "", "class": "", "floor": 1, "pronouns": "", "crawlerNumber": "" },
  "stats": { "str": { "enhanced": 12, "unenhanced": 10 } },
  "fields": { "armor": 2 },
  "tracks": { "hp": { "cur": 10, "max": 10 }, "mana": { "cur": 4, "max": 6 } },
  "skills": [ { "uid": "s_..", "skillId": "sneak", "name": "Sneak", "rank": 3, "stat": "dex", "checkType": "Standard", "notes": "", "used": false } ],
  "attacks": [ { "uid": "k_..", "name": "Kick", "skillUid": "s_..", "stat": "str", "dice": "1d6", "effects": "" } ],
  "spells": [ { "uid": "sp_..", "spellId": "fireball_homebrew", "rank": 1, "active": false } ],
  "inventory": [ { "uid": "i_..", "itemId": "...", "qty": 1, "notes": "", "equippedSlot": null, "containerUid": null } ],
  "hotlist": [ "i_..", null ],
  "buffs": [ { "uid": "b_..", "buffId": "...", "name": "Haste", "external": true, "effects": [], "until": "" } ],
  "story": { "popularity": "", "pastTrauma": "", "looseEnds": "", "regrets": "", "notes": "" },
  "portrait": null,
  "pools": [ { "uid": "pl_..", "name": "Lay on Hands", "cur": 3, "max": 5, "desc": "" } ],
  "pending": { "race": "Gnome" },
  "originsLocked": false
}
```
`pools` = limited-use counters (`pool.*` actions). `containerUid` = the container item (library item with
`container: true` or tag `container`) this entry is inside (`item.move`). `pending` = race / class / background
the player asked for while `session.permissions.allowOrigins` is on; `origins.approve` applies it and sets
`originsLocked` (players can no longer change them). See PROTOCOL.md §3 / §4.
Old players (with flat `stats` numbers and `resources`) are migrated: number → `{enhanced: n, unenhanced: n}`,
`resources.hp` → `tracks.hp`.

Views: the player view `me` and GM `playersFull[]` gain `sheet`: the raw character above **plus**
`computed`: `{ stats: {id: {value, mod: breakdown}}, derived: {id: breakdown}, tracks: {id: {cur, max}},
attacks: [{uid, toHit: breakdown, damage: "1d6+3"}], skills: [{uid, total: breakdown}], warnings: [] }`.

## 6. Actions

Players may edit **their own** sheet only where the GM allows: `session.permissions.playerEdit`
(`"none" | "notes" | "sheet"`, default `"sheet"`; GM can lock it). GM may edit anyone.

| t | fields | who |
|---|---|---|
| `sheet.set` | `playerId?` (GM), `path` (dot path inside the character, whitelisted roots: identity, stats, fields, story, portrait), `value` | GM / player |
| `track.set` | `playerId?`, `track`, `cur?`, `max?`, `delta?` | GM / player |
| `skill.add` | `playerId?`, `skillId?` or `name`+`stat`+`checkType`, `rank?` | GM / player |
| `skill.update` | `playerId?`, `uid`, `rank?`, `notes?`, `stat?`, `checkType?`, `used?` | GM / player (rank: GM only unless playerEdit = "sheet") |
| `skill.remove` | `playerId?`, `uid` | GM / player |
| `attack.add/update/remove` | `playerId?`, attack fields / `uid` | GM / player |
| `spell.learn/forget` | `playerId?`, `spellId` / `uid` | GM (player if sheet) |
| `spell.cast` | `playerId?`, `uid` | GM / player — deducts cost from track, logs, optional effect activation |
| `spell.ready` | `playerId`, `uid` | GM only. Reset a known spell's cooldown |
| `item.equip` | `playerId?`, `uid`, `slot` (or null to unequip) | GM / player — enforces slot `max` |
| `item.qty` | `playerId?`, `uid`, `qty` | GM / player |
| `hotlist.set` | `playerId?`, `index`, `uid|null` | GM / player |
| `buff.add` | `playerId`, `buffId` or ad-hoc `{name, effects, external}` | GM (enforces external cap) |
| `buff.remove` | `playerId`, `uid` | GM |
| `roll` | `playerId?`, `what`: `{kind:"stat"|"derived"|"skill"|"attack"|"custom", id?, uid?, formula?}`, `secret?` | GM / player — server rolls with crypto RNG, result into the dice log |
| `skills.rankUp` | `playerId?` (all if omitted) | GM — for every `used` skill roll the rank-up check, apply, clear `used`, log results |
| `lib.upsert` | `kind`, `entry` | GM — create/update homebrew |
| `lib.remove` | `kind`, `id` | GM — homebrew only |
| `lib.give` | `playerId`, `kind` (`item`/`spell`/`skill`/`buff`), `id` | GM |

Dice log: `state.rolls` (last 200) `{id, at, playerId, label, formula, dice:[...], total, breakdown, secret}`.
Event `roll` to the roller + GM (+ everyone unless `secret`). Stage shows non-secret rolls.

## 7. Dice notation

`NdM(+/-K)`, `d20`, multiple terms `2d6+1d4+3`, plus formula identifiers (`d20 + mod.dex`).
Natural 1/20 on a single d20 flagged `nat1`/`nat20` (the show reacts).

## Crawler-family options (added 17 Nov 2026)

| Key | Meaning |
|---|---|
| `gmOnly: ["level", "floor", "crawlerNumber", "aiFavor"]` | Identity keys / field ids only the GM sets. Players see them read-only; a number field may still be lowered by 1 by its player (spending AI Favor). |
| `combat.flow: "reaction"` | Reaction rounds (`server/reaction.js`): declare → react → resolve → act; starts with `combat.start`. |
| `combat.mobBase`, `combat.floorScaled` | Mob Evade / to-hit are bonuses: target = mobBase + bonus (+ the world floor). |
| `combat.mobSlotValue` | Damage one mob health slot is worth when the mob has no `slotValue`. |
| `combat.degreeScale: "seven"` | Attacks / checks vs a target get the seven degrees (`vs.deg7`: crit, amazing, success, near, fail, major, critfail). Amazing adds the floor to the damage; a near miss offers Intervene on the other phones |
| `combat.injuries: { minor, major, minorLong?, majorLong? }` | Buff ids. Reaction rounds: an Evade Major Fail marks a minor injury, a natural 1 a major one; they land on the sheet when the fight ends; a second one of the same kind becomes the long-term buff |
| `combat.healSpell: { mana, slots, track }` | The Heal interrupt really heals (spends the Mana track, gives slots) |
| buff `tick: { damage: "1d6", plusFloor, type }` | Damage at every clean up of reaction rounds (crawler buffs, mob conditions with a buff id) |
| monster `resist` / `vulnerable` / `immune: [types]`, attack `dtype` | Typed damage after DR: half / double / none (`combat.damage dtype`, sheet attacks by their `dtype`) |
| `combat.dyingRounds: "mod.con"` | Reaction rounds: a crawler at 0 health is dying for that many rounds; −1 each clean up and each hit; healed = saved; 0 = dead (`dying`, `dead` on the crawler in `view.combat`) |
| `combat.starterAttack: { name, skill, rank, stat, dice }` | Given to every crawler without an attack (on creation and when a fight starts). |
| track `slotValue: "mod.con"` | Slot health bar: rolled damage after DR removes whole slots; less than one slot is lost. |

## Guided creation: `creation` (added 18 Nov 2026)

Optional. With it, players get a step-by-step creator (`web/js/creator.js`) instead of the plain builder, and `creation.apply` checks their choices.

| Key | Meaning |
|---|---|
| `statMethods` | `{ array: [2,3,4,5,6], roll: { dice: "d6", reroll: [1] }, min, max }` |
| `statPart`, `mirrorParts` | Which stat part the player sets (e.g. `unenhanced`) and which parts start with the same value |
| `backgrounds` | `[{ id, label, pick, rank, roll, options: [{ name, skills: [skillId…] }] }]` life stages |
| `noDouble` | A skill cannot come from two stages |
| `customBackground` | `true`: each stage also offers *Your own* — the player names it and picks `pick` skills from everything the stages offer |
| `combat` | `{ fixed: {name, skill, rank, stat, dice, damageStat}, rank, weapons: [{ name, group, skill, stat, dice, damageStat, damageType, note }], custom }` |
| `stuff` | `[{ id, label, hint, auto: "weapon" \| catalog: true \| custom: true }]` starting things (GM approves) |
| `derived`, `basicActions`, `help` | Explanations: after the stats, on the review + the sheet's Actions tab, the "i" bubble per step |

Attacks may carry `dmgStat` (damage stat when it differs from the to-hit stat, `none` = no stat), e.g. a dagger: Dex to hit, Str to damage.

### skills.untrained / skills.hideTags

```json
"untrained": { "adv": "dis", "formula": "mod.{stat} + buff.check", "noCheckTypes": ["Passive"], "learn": true, "learnMaxFloor": 2 },
"hideTags": ["legacy"]
```

Untrained checks: any library skill not on the sheet can be rolled (`roll` with `what.kind: 'untrained'`), always with
`adv`, the `formula` instead of Rank + Stat Mod. Check types in `noCheckTypes` cannot be tried. With `learn`, tried skills
gather in `sheet.untried`; `untrained.learn` turns one into Rank 1 and wipes the list (only up to `learnMaxFloor`, 0 = any
floor). `hideTags`: library skills with these tags stay out of the players' pickers (kept for old references).

### combat.sizeGap / combat.crawlerSize

`"sizeGap": 4, "crawlerSize": 4` (DCC): when a crawler attacks a revealed mob whose size class (book stat block
`size.value`) is `sizeGap` or more above the crawler's, the phone preselects Advantage; that far below, Disadvantage.
The crawler's size comes from its `size` field (animal crawlers: Tiny … Gargantuan), else `crawlerSize`. Needs
`combat.advantage`.

### glossary / i18n (added 27 Nov 2026)

- `glossary`: `[{ term, en, cs?, stat? }]` — plain-language terms for new players; phone shows **i** next to a stat with that `stat` id and **?** in the roll pad lists all.
- `i18n`: `{ "cs": { "English text": "Český text", "Next: {}": "Dál: {1}" } }` — translations of the pack's own wording (background names, skill descriptions…) merged into the phone/TV dictionary when the flag is CZ. Exact strings; `{}` holes as in `web/js/i18n-cs.js`.

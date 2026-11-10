# Content packs

A content pack is a folder. The engine loads one pack at start (`PACK_DIR`, default `packs/demo`).

```
my-pack/
  pack.json           metadata + loot tiers
  achievements.json   achievement catalog
  items.json          item catalog
  loot.json           loot tables per tier
  quips.json          voice lines by category
  chat.json           optional fake-audience chat lines
  ruleset.json        optional: character-sheet rules (docs/RULESET.md)
  spells.json         optional library files (arrays, see "Library files" below)
  skills.json
  buffs.json
  features.json
  races.json
  classes.json
  backgrounds.json
  bosses.json         optional: bosses for the TV boss scene
  locations.json      optional: locations for the Explore scene
  images/             item art (webp/png, 512x512 recommended)
  audio/              pre-rendered voice lines (mp3/ogg)
```

## pack.json
```json
{
  "id": "demo",
  "name": "Demo Pack",
  "version": "1.0.0",
  "language": "en",
  "systemName": "The System",
  "notifyPrefix": "New achievement!",
  "lootTiers": [
    { "id": "bronze", "name": "Bronze Box", "color": "#cd7f32" },
    { "id": "silver", "name": "Silver Box", "color": "#c0c0c0" },
    { "id": "gold",   "name": "Gold Box",   "color": "#ffd700" }
  ],
  "audience": { "startViewers": 1200, "sponsorHypeThreshold": 0.8 },
  "autoBudget": 6,
  "stats": [
    { "id": "str", "label": "Strength", "abbr": "STR", "default": 3 },
    { "id": "dex", "label": "Dexterity", "abbr": "DEX", "default": 3 }
  ],
  "resources": [
    { "id": "hp", "label": "Health", "color": "#ff3355", "default": 10 },
    { "id": "mp", "label": "Mana", "color": "#33aaff", "default": 5 }
  ],
  "voices": [
    { "id": "host", "label": "Game-show host", "lang": "en-US", "rate": 1.08, "pitch": 1.0, "prefer": ["Google US English", "Alex", "Microsoft Guy"] },
    { "id": "bureaucrat", "label": "Cold bureaucrat AI", "lang": "en-GB", "rate": 0.95, "pitch": 0.7, "prefer": ["Google UK English Male", "Daniel", "Microsoft Ryan"] },
    { "id": "gremlin", "label": "Unhinged gremlin", "lang": "en-US", "rate": 1.2, "pitch": 1.4, "prefer": ["Samantha", "Microsoft Aria"] }
  ]
}
```
`notifyPrefix` (optional) is the banner text shown above achievement pop-ups.
`theme` (optional): `"dark"`, `"light"` or `"neon"` — default look of the GM desk and phones (each device
can still pick its own).
`stats` and `resources` define what every character sheet shows (generic — your rulebook decides the
actual numbers). They are the v1 way; a pack with `ruleset.json` (or an inline `"ruleset"` object in
pack.json) defines stats and tracks there instead, and `stats`/`resources` are then derived from it.
Without a ruleset, `stats` become two-part stats (`enhanced`/`unenhanced` = `default`) whose modifier is the
value itself, and `resources` become pool tracks. `voices` are the System personalities the GM can switch live; pre-rendered audio may
exist per voice under `audio/<voiceId>/`.

## achievements.json
```json
[
  { "id": "first_blood", "title": "First Blood", "desc": "You hit something. It hit back.",
    "reward": "A Bronze Box", "group": "Combat", "voice": "achievement_first_blood" }
]
```
`voice` is an optional quip id from `quips.json`. `reward` (optional) is shown under the description;
the GM still hands out the reward by hand. `group` (optional) groups achievements in the GM catalog.

## items.json
```json
[
  { "id": "rubber_duck", "name": "Slightly Damp Rubber Duck", "desc": "Squeaks when lied to. Probably.",
    "flavor": "Found floating in a puddle that should not exist.", "rarity": "common", "image": "rubber_duck.webp" }
]
```
`desc` is the short rules text; `flavor` (optional) is longer text shown in italics.

Optional v2 fields (all validated; a bad effect is skipped with a load warning, never fatal):
```json
{ "id": "ring_of_dodging", "name": "Ring of Dodging", "rarity": "uncommon",
  "slot": "accessories",
  "stackable": false,
  "tags": ["gear"],
  "effects": [ { "target": "evade", "op": "add", "value": 2, "when": "equipped", "label": "Ring of Dodging" } ],
  "attack": { "skill": "melee", "stat": "str", "dice": "1d8", "effects": "returns when thrown" },
  "use": { "heal": { "track": "hp", "amount": 3 }, "applyBuff": "hidden", "removeBuff": "bleeding", "target": "self", "consume": true, "note": "" } }
```
- `slot`: a gear slot id from the ruleset (`item.equip` refuses other slots), or null = any slot.
- `stackable`: gives merge into one entry with `qty`; using a stackable item consumes one.
- `effects`: see RULESET §3. `target` = `evade` (a buff pool, same as `buff.evade`), `stat.<id>`, `mod.<id>`,
  `skill.<id>`, `track.<id>.max`, `field.<id>`, `derived.<id>`. `op` `add` (default) or `set` (last wins;
  a `set` on a bare id that is also a derived value overrides that derived value). `value` = number or
  formula (formula values see base values only: `stat.*`, `field.*`, `level`, `skill.<id>.rank`).
  `when` = `equipped` (default for items: in a gear slot or the hotlist), `carried`, `active`, `always`.
- `use` (optional): `heal` (also accepted as `"track": "hp", "delta": 3`), `applyBuff` (also `"buff"`),
  `removeBuff`, `target` (`"self"` applies the buff to the user; anything else, e.g. `"enemy"`, leaves it to the
  GM), `consume` (default = `stackable`), `buffOnFail` and `note` (shown, not automated).

## Library files

`spells.json`, `skills.json`, `buffs.json`, `features.json`, `races.json`, `classes.json`,
`backgrounds.json` (and `bosses.json`, `locations.json`, below): arrays of library entries (RULESET §4). Common fields: `id`, `name` (required), `desc`,
`tags[]`. Per kind:

| file | extra fields |
|---|---|
| spells | `cost` (number or formula; `rank` = the caster's spell rank), `costTrack` (default `ruleset.spells.costTrack`), `range`, `duration`, `effects[]` (default `when: "active"`), `attack?`, `dice?`, `rankScaling?`, `applies?` (buff id applied on cast), `flavor?` |
| skills | `stat`, `checkType`, `upgrades[]` (`{rank, text}`) |
| buffs | `effects[]`, `duration`, `external` (counts toward `buffSlots.external.max`); tag `debuff` for negative ones |
| features | `effects[]` (default `when: "always"`) |
| races / classes / backgrounds | `features[]` (feature ids), `statBonuses[]` (effects), `skills[]` (skill ids) |

A character gets race/class/background effects when `identity.race` / `class` / `background` equals the
entry's id or name (case-insensitive). The ruleset's `skills.catalog`, and inline objects in its
`races`/`classes`/`backgrounds` lists, are added to the library too; plain id strings in those lists must
exist in the matching file (warning otherwise). Pack entries are read-only in the game; the GM creates
homebrew in the campaign library (`lib.upsert`). Unknown keys anywhere are ignored.
Rarity: `common`, `uncommon`, `rare`, `epic`, `legendary`. `image` is relative to `images/` and optional
(the UI draws a rarity-colored placeholder).

## bosses.json and locations.json (TV scenes)

Optional arrays, library kinds `boss` and `location` (GM library + the Scenes panel; never sent to phones).

```json
[{
  "id": "porter_grim", "name": "Porter Grim", "title": "Employee of the Month, Every Month, Forever",
  "floor": 1, "image": "porter_grim.webp", "hpSlots": 20, "color": "#b45cff", "lootTier": "silver",
  "phases": [ { "name": "Check-In", "atHp": 20, "text": "..." }, { "name": "Overbooked", "atHp": 12, "text": "..." } ],
  "intro": "Crawlers, please welcome ...", "defeatLine": "Porter Grim has checked out.",
  "flavor": "...", "tactics": "GM only", "lootHint": "GM only"
}]
```
- `hpSlots` 1..100 (default 10) — the TV's segmented HP bar. `phases` ≤ 10; `atHp` (optional) makes the GM
  desk suggest that phase when the boss's HP drops to it (the GM confirms).
- `intro` is shown and spoken (System voice) when the GM presses Intro; `defeatLine` on defeat.
- `tactics` and `lootHint` stay on the GM desk. `lootTier` (a pack tier id) names the TV loot line.
- `image` is relative to `images/`; missing art → a generated silhouette in the boss's `color`.
- Unknown keys (`attacks`, `evade`, `cues`, ...) are ignored by the scene system.

Locations: `{ id, name, floor, image, readAloud, features[] }` — picking one fills the Explore scene
(name, "Floor N", backdrop image, `readAloud` as the on-screen text). `features` are GM-only notes.

## loot.json
```json
{
  "bronze": [ { "item": "rubber_duck", "weight": 10 } ],
  "silver": [ { "item": "rubber_duck", "weight": 2 } ]
}
```

## quips.json
```json
[
  { "id": "nat1_01", "category": "nat1", "text": "A one. Statistically inevitable. Emotionally devastating.", "audio": "nat1_01.mp3" }
]
```
Standard categories the GM panel shows as buttons: `nat1`, `nat20`, `death`, `levelup`, `boss`,
`fail`, `success`, `idle`, `achievement`, `loot`, `sponsor`, `welcome`, `goodbye`. Packs may add more.
`audio` is optional; without it the stage uses text-to-speech.

## chat.json
```json
[ { "user": "xX_GoblinFan_Xx", "text": "this crawler is so dead lol" } ]
```

## ruleset.json

See [RULESET.md](RULESET.md). Engine additions to that contract: `skills.check` = `{roll, formula}`
(default `skill.rank + mod.{stat}`) for skill totals and rolls; `skills.rankMin`; `skills.rankUp.amount`
(rank step, default 1); `attack.roll` (to-hit die, default `dice`); derived formulas may reference earlier
derived values as `derived.<id>`. Only `verify: true` flags a rule as unverified; `note` alone is shown as
documentation. The demo pack ships a small generic ruleset (`packs/demo/ruleset.json`).

## Using your own book material

If you own a rulebook (PDF), you can turn parts of it into a private pack for your own table.
Keep that pack in a **private** repository — never publish text, names or art from commercial books.
The engine never needs the book itself; it only reads the JSON above.

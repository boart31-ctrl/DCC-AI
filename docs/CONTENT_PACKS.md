# Content packs

A content pack is a folder. The engine loads one pack at start (`PACK_DIR`, default `packs/demo`).

```
my-pack/
  pack.json           metadata + loot tiers
  achievements.json   achievement catalog
  items.json          item catalog
  loot.json           loot tables per tier
  quips.json          voice lines by category
  chat.json           optional fake-audience chat lines (tagged by moment, see below)
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
  monsters.json       optional: mob stat blocks for the combat tracker
  npcs.json           optional: NPC cards (GM desk + TV name card)
  images/             item art (webp/png, 512x512 recommended)
  audio/              pre-rendered voice lines (mp3/ogg)
  audio/sfx/          your own sound-effect pads (see sfx.json)
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

Locations: `{ id, name, floor, image, readAloud, features[], npcs[], monsters[], bosses[] }` — picking one fills
the Explore scene (name, "Floor N", backdrop image, `readAloud` as the on-screen text). `features` are GM-only
notes; `npcs` / `monsters` / `bosses` are library ids (the GM desk lists them; the combat builder can add a
location's monsters in one go).

Bosses may also carry a stat block (`evade`, `dr`, `attacks` as for monsters) so they can join the combat tracker.

## monsters.json and npcs.json (bestiary)

Optional arrays, library kinds `monster` and `npc` (GM library only; never sent to phones or the TV library).
```json
[{ "id": "luggage_snapper", "name": "Luggage Snapper", "title": "…", "floor": 1, "group": "construct",
   "image": "luggage_snapper.webp", "hpSlots": 4, "evade": 1, "dr": 1,
   "attacks": [ { "name": "Zipper Bite", "toHit": 3, "damage": "1d4", "effects": "…", "buffs": ["prone"] } ],
   "desc": "…", "flavor": "…", "defeatLine": "…", "lootItems": ["ten_coins"],
   "notes": "GM only", "tactics": "GM only", "lootHint": "GM only" }]
```
`hpSlots` 1..100 (default 5), `evade`/`dr` integers −99..99, ≤ 12 attacks (`toHit` integer, `damage` dice
formula or `"0"`, `buffs` = buff ids the attack can apply). The TV only ever shows a revealed mob's name, art,
HP bar and conditions.

```json
[{ "id": "fennimore_quill", "name": "Fennimore Quill", "role": "Guest Relations Liaison", "floor": 0,
   "image": "fennimore_quill.webp", "personality": "…", "voice": "GM only", "hooks": ["GM only"], "secrets": ["GM only"] }]
```
The TV's NPC card shows `name`, `role`, `floor` and the portrait; `voice`, `hooks` and `secrets` stay on the
GM desk (`personality` too). Missing art → a generated silhouette. Unknown keys (`art`, …) are ignored.

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

Fake audience chat for the TV ticker. Each line: `user` (≤ 40 chars), `text` (≤ 200), optional `tags` and `weight`.

```json
[
  { "user": "xX_GoblinFan_Xx", "text": "this crawler is so dead lol" },
  { "user": "OddsBot_3000", "text": "LIVE ODDS: CRAWLERS 2:1. {mob} 3:1", "tags": ["combat"] },
  { "user": "{player}_stan_acct", "text": "{player} IS THE MAIN CHARACTER", "tags": ["nat20"], "weight": 2 }
]
```

- **`tags`** (array, or one string): the moments a line fits. Known tags:
  `idle`, `lobby`, `explore`, `combat`, `boss`, `boss_phase`, `boss_defeat`, `loot`, `achievement`, `death`,
  `nat1`, `nat20`, `countdown`, `npc`, `recap`. Unknown tags are ignored (with a pack warning).
- **`weight`** (positive number, default 1): how often the line is picked relative to its neighbours.
- **Untagged lines** (the old format) are *generic*: they can appear in any calm moment, like `idle`. A pack with
  only untagged lines behaves as before, just without reaction bursts.
- **Placeholders** in `user` or `text`: `{player}` (the crawler the moment is about, else a random crawler),
  `{boss}` (boss on the TV / in the event), `{mob}` (a revealed, living mob in the fight), `{item}` (the loot
  item, else something a crawler carries). A line whose placeholder has no value right now is skipped.

How the server picks (server/chat.js):

| When | What |
|------|------|
| Calm chat, while a TV is on | One line every few seconds for the TV scene: `lobby` 7–14 s, `idle`/blank 9–18 s, `explore` 11–21 s, `combat` 4–8 s, `boss` 3–5.5 s (`countdown`, `npc`, `loot`, `recap` in between). Lines tagged for the scene are preferred; generic / `idle` lines mix in (about a quarter of the time). Combat on the tracker counts as `combat` in any scene; a defeated boss scene as `boss_defeat`. |
| Right after a big moment | A burst of quick lines (first within a second, then every 0.6–1.7 s) from that tag only: nat 20 (3–5), nat 1 (3–4), boss intro (`boss`, 3–5), boss phase (2–4), boss defeat (4–6), a crawler going down in the arena (`death`, 3–5), loot / sponsor box (2–3), achievement (2–4), the TV switching to a countdown or recap (1–2), combat start (2–3). Secret rolls never trigger anything. |
| After the burst | For ~45 s calm chat sometimes keeps talking about that moment (fading out). |
| Always | No repeats inside a recent-history window (60% of the pool, max 80 lines; small pools only block the last few). |

The same moments make the audience react: boss intro +8–14% viewers, boss phase +4–8%, combat start +4–8%,
a crawler down +5–10%, nat 20 +2–5%, nat 1 +1–3%, hits +0.2–2% (boss defeat, loot and achievements already bump
the count). The TV adds a small live wobble to the number, bigger in combat and boss scenes.

Write original lines (no quotes from books or shows). Bursts need at least 4–6 lines per tag to feel varied;
aim for 20+ per tag in a full pack.

## sfx.json (sound pads on the GM desk)

Optional. The desk ships 16 original pads (`web/sfx/`, made by `tools/gen_sfx.mjs`: boss sting, phase change,
victory fanfare, death, loot box open, achievement chime, crowd cheer / boo / gasp, hype horn, drumroll, fail
trombone, alarm / floor collapse, door creak, magic zap, explosion). A pack adds pads, or replaces a built-in pad by
using its `id`:

```json
[
  { "id": "hype_horn", "label": "Our horn", "file": "horn.mp3", "hotkey": "Shift+KeyH", "volume": 0.8 },
  { "id": "gary_laugh", "label": "Gary laughs", "file": "gary.mp3" }
]
```

`file` is relative to `audio/sfx/` (mp3 plays everywhere). `hotkey` is optional: `Shift+Digit0`–`Shift+Digit9` or
`Shift+KeyA`–`Shift+KeyZ` (physical key, so it works on a Czech keyboard too; avoid `Shift+KeyA` / `Shift+KeyM`,
which the desk also uses). Built-in pads use Shift+1…0 and Shift+Q W E R T U. `volume` 0–2 is the starting level
(the GM can change it per pad). Only use sounds you made or have the right to use.

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

### Boss phase text on the TV
`bosses.json` phases may carry `text` (GM mechanics, shown on the GM desk only) and an optional
`tv` line (short, spoiler-free, shown in the TV's phase report). Library phase `text` never reaches
the TV.

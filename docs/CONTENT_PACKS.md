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
`stats` and `resources` define what every character sheet shows (generic — your rulebook decides the
actual numbers). `voices` are the System personalities the GM can switch live; pre-rendered audio may
exist per voice under `audio/<voiceId>/`.

## achievements.json
```json
[
  { "id": "first_blood", "title": "First Blood", "desc": "You hit something. It hit back.", "voice": "achievement_first_blood" }
]
```
`voice` is an optional quip id from `quips.json`.

## items.json
```json
[
  { "id": "rubber_duck", "name": "Slightly Damp Rubber Duck", "desc": "Squeaks when lied to. Probably.", "rarity": "common", "image": "rubber_duck.webp" }
]
```
Rarity: `common`, `uncommon`, `rare`, `epic`, `legendary`. `image` is relative to `images/` and optional
(the UI draws a rarity-colored placeholder).

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

## Using your own book material

If you own a rulebook (PDF), you can turn parts of it into a private pack for your own table.
Keep that pack in a **private** repository — never publish text, names or art from commercial books.
The engine never needs the book itself; it only reads the JSON above.

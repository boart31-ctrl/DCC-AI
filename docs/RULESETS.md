# Built-in rulesets, campaigns and content conversion

The engine ships three rulesets next to whatever ruleset a content pack brings (the pack's own one stays the
default and is never changed):

| id | Shown as | Mechanics from | Licence |
|---|---|---|---|
| `dnd5e` | 5e · 2014 rules (SRD 5.1) | System Reference Document 5.1, Wizards of the Coast | CC BY 4.0 |
| `dnd2024` | 5e · 2024 rules (SRD 5.2) | System Reference Document 5.2, Wizards of the Coast | CC BY 4.0 |
| `pf2e` | PF2e · remaster rules (ORC) | Pathfinder Player Core / GM Core (Paizo), remaster | ORC License |

Files: `server/rulesets/dnd-shared.js` (both 5e versions), `dnd5e.js`, `dnd2024.js`, `pf2e.js`. They use the
normal `ruleset.json` shape (docs/RULESET.md) plus the blocks below. All text in them is our own summary; only
mechanics (numbers, rule and condition names) follow the source documents. The UI never says "D&D" or
"Pathfinder" as a product name: those are trademarks the SRD and the ORC License do not grant.

## Licence notices (shown in the app)

Each ruleset carries `system.attribution`. The GM sees it under Settings → Campaign & backup → Rules licence,
players under ··· → Rules → Licence.

- **SRD 5.1:** "This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards
  of the Coast LLC. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License
  (https://creativecommons.org/licenses/by/4.0/legalcode)."
- **SRD 5.2:** "This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the
  Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons
  Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode."
- **ORC:** ORC Notice, Attribution Notice, Reserved Material Notice and Expressly Designated Licensed Material, see
  `server/rulesets/pf2e.js`. Before a public release a lawyer should read the exact wording once.

## New ruleset blocks

```json
{
  "system": { "family": "dnd", "edition": "2014", "label": "...", "short": "5e 2014", "licence": "CC-BY-4.0", "attribution": "..." },
  "labels": { "race": "Species", "class": "Class", "background": "Background" },
  "combat": {
    "defense": "ac", "defenseLabel": "AC", "dr": null,
    "hitRule": ">=", "crit": "dice", "critRange": 20, "nat1": "miss", "degrees": false, "advantage": true,
    "initiative": { "enabled": true, "derived": "initiative" }, "hpModel": "pool"
  },
  "conditions": [ { "id": "prone", "name": "Prone", "desc": "...", "effects": [] } ],
  "skills": { "autoAdd": true, "rankLabels": ["—", "Proficient", "Expertise"] },
  "tracks": [ { "id": "tempHp", "maxFormula": "99", "start": "empty" } ]
}
```

- `system.family`: `crawler` (default for packs written before this, e.g. the DCC pack), `dnd`, `pf2e`, `generic`.
  Content conversion keys off it.
- `combat.crit`: `double` (total x2), `dice` (roll the damage dice twice, 5e), `degrees` (PF2e: beat the target by
  10 = critical, a natural 20 / 1 moves the result one step, critical = double damage), `none`. Unset (crawler
  packs) = the combat tracker setting decides, as before.
- `combat.dr`: derived id subtracted from damage, or `null` (no damage reduction).
- `combat.initiative.enabled`: fights run in turn order instead of phases (the GM can override per tracker).
- `conditions`: buff library entries shipped with the ruleset (they shadow pack buffs with the same id).
- `skills.autoAdd`: every catalog skill is on a new sheet (printed-sheet games).
- Track `start: "empty"`: a formula track that starts at 0 instead of full (temporary HP).

Characters: 5e uses ability scores (`parts: ["score"]`), proficiency bonus `floor((level - 1) / 4) + 2`, skills
with rank 0 / 1 / 2 (none / proficient / expertise), save proficiency fields, AC = armour base + DEX (capped) +
shield, fixed HP per level. PF2e uses modifiers only (`parts: ["mod"]`), proficiency = 0 untrained or
level + 2 × rank (trained 1 .. legendary 4), Perception as initiative, HP = ancestry + (class + CON) × level.

## Campaigns

A campaign = the whole game state plus `state.campaign = { id, name, ruleset, createdAt }`. The ruleset is picked
when the campaign is created and is locked for it; another game means another campaign. A server keeps several
campaigns: the running one in the state, the others parked (Node: `data/campaigns/<id>.json`, Cloudflare: SQLite
table `campaigns`). GM actions: `campaign.list`, `campaign.new {name, ruleset}`, `campaign.switch {id}`,
`campaign.rename {name}`, `campaign.delete {id}`. TVs and the GM link stay paired; players get the links of the
campaign that is running. `POST /api/import` (GM key) restores a campaign from an export / backup file.

## Content conversion (server/systems.js)

Content is written once in the pack's own number scale. `packForRuleset(pack, rulesetId)` builds the pack a
campaign runs with: the ruleset, its skills and conditions, and every monster, boss, item, buff and spell
converted. Names, art, sounds, intros, phases, loot and flavour text stay; only numbers and rules text change.

1. **Neutral tier** of a monster / boss: `level` (explicit `level`, else from the floor: floor n → 2n − 1),
   `role` (boss; minion ≤ 2 HP slots; elite ≥ 9; else standard), toughness vs the role's usual slots, defence
   offset, each attack's damage share and to-hit offset vs its best attack.
2. **Numbers per family** (approximations tuned to feel right, not official tables):

| | 5e (party level L) | PF2e (creature level CL = L − 1, minion L − 2, elite L, boss L + 2) |
|---|---|---|
| AC | 12 + floor((L + 1) / 3), minion −1, elite +1, boss +2 | 15 + floor(1.4 × CL) |
| HP | 10 × L × role (0.4 / 1 / 2 / 3.5) × toughness | (15 × CL + 5) × role (0.6 / 1 / 1.2 / 1.25) × toughness |
| To hit | 3 + ceil(L / 3), elite +1, boss +2 | 8 + floor(1.5 × CL) |
| Damage avg | (4.5 + 2 (L − 1)) × role (0.7 / 1 / 1.3 / 1.6) × share | (6 + 1.6 CL) × role (0.8 / 1 / 1.1 / 1.2) × share |
| Save DC | 10 + ceil(L / 3), boss +1 | 15 + floor(1.4 × CL) |

   Damage keeps the attack's own die ("1d6" stays d6) with dice + bonus around the target average.
3. **Rules text** in attacks, tactics and phases: "rolls DEX (difficulty 12)" → "makes a DEX save (DC 11)" /
   "attempts a Reflex save (DC 16)", "6 squares" → "30 ft", "Evade" → "AC". Boss phase thresholds scale with HP.
4. **Items, buffs, spells:** effect targets map — `evade`, `armor`, `dr` → `ac` (half, rounded up); `move` →
   `speed` (×5 ft); `step` dropped; `track.hp.max` (slots) → `n × (level + 1)` HP; `stat.x` +2 → PF2e `mod.x` +1;
   crawler skills → the closest 5e / PF2e skill (sneak → stealth, lockpicking → sleight of hand / thievery...);
   unknown targets are dropped. Gear slots map (torso → armour, arms → gloves, accessories → other worn items).
   Healing items: n crawler HP slots → 2.5 n HP. Spells lose mana costs where the game has no mana.

Every converted entry has `converted: { from, to, level, role, dc }`. Homebrew made inside a campaign is written
in that campaign's numbers and is not converted. The GM can always change a mob's numbers in the tracker.

## Dice entry and turn order

- `dice.mode {mode}` (player for themselves, GM with `playerId`): `off` (default: tapping a number explains it,
  dice stay at the table), `enter` (the roll pad asks for the real die), `digital` (the phone rolls).
- `roll` gains `entered` (the natural die; for damage, what the damage dice showed), `adv` (`adv` | `dis`,
  digital only), `bonus` (situational ±), `target` (a mob uid: to-hit resolves against its defence, damage is
  applied to it), `dc` (a number: checks), `after` (the to-hit roll id, so damage knows it was a critical).
  The record gets `vs: { hit, crit, degree, defense, margin, uid, name }`; players and the TV never get
  `defense` / `margin`. Rolls missed / made by 1–2 cue the `near_fail` / `near_success` voice lines.
- Undo: `roll.undo` (player, own last roll, 2 minutes), `roll.void {id}` / `roll.restore {id}` / `roll.undoLast` /
  `roll.redoLast` (GM). Undoing puts the damage back and removes an initiative total.
- Turn order (`combat.init`): monsters roll when the fight starts or when added; crawlers roll initiative on the
  phone (any initiative roll during a turn-order fight places them) or the GM types / rolls it
  (`combat.initiative {uid, total}`, `combat.initRoll {uids?}`). `combat.order {uids}` = GM drag order,
  `combat.next` = next turn (first press starts round 1, wrapping starts a new round), `combat.turnSet {uid}`.
  Event `combat.turn { round, current, next }` → TV banner, phone "Your turn" / "You're next".

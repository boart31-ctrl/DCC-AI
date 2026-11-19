# Deterministic content ZIP import

In the GM Library, **Import ZIP** adds homebrew entries to the open campaign. The editor, fight tracker, boss and NPC scenes, and inventory use the existing campaign library. Validation and storage use code and data only.

## THE_SYSTEM_CONTENT_V1

The root `manifest.json` is a UTF-8 object with `format: "THE_SYSTEM_CONTENT_V1"` and `entities`. The [JSON Schema](the-system-content-v1.schema.json) defines each field, allowed type, range, and enum. The server also checks references against the active campaign. Unknown properties at any depth, duplicate JSON keys, and unknown entity types fail the entire import. Text limits use the engine's UTF-16 length limits. Text is stored as data and interpreted as text in the game.

| Type | Required fields in addition to `type`, `id`, `name` | Destination |
|---|---|---|
| `monster` | `hpSlots`, `evade`, `dr`, one or more `attacks` | Library → Monsters |
| `boss` | `hpSlots`, `evade`, `dr`, one or more `attacks`, one or more `phases` | Library → Bosses |
| `npc` | None | Library → NPCs |
| `item` | `rarity` | Library → Items |

Use stable lowercase IDs. A `(type,id)` already present in the campaign, built-in pack, or incoming archive causes a conflict. An ID in another type's library is a separate namespace. Use a personal prefix to lower the chance of a collision. There is no overwrite, rename, or merge operation in this format.

### Mechanics

- **Creature attack:** `name`, `toHit` (the integer added to d20), and `damage` (a string). Damage accepts a flat 0–999 or 1–20 dice with 2–100 sides and at most one signed flat modifier of up to 999, such as `"2d6+3"`. Use `"0"` for no damage. The tracker selects a crawler using its existing targeting mode or the GM's selection. The active ruleset resolves the hit, critical, and damage.
- **Attack effects:** `buffs` refers to existing buff IDs. The normal automatic mob attack path applies these on hit. Reaction rounds follow their own GM-controlled resolution. `effects` and `range` are stat-block text for the GM. `dtype` labels damage in the stat block. A supplied nonblank `area` also marks the reaction attack as an area attack, which changes the effect of successful Evade. The GM still assigns affected targets and splash rings. The text specifies no calculated radius or measured range.
- **Creature defenses:** `hpSlots` is 1–999, `evade` and `dr` are −99 to 99, and `slotValue` is 0–50 when supplied (0 uses the ruleset fallback). Damage types in `resist`, `vulnerable`, and `immune` use the engine's existing resolution for typed attacks against a mob. A type may occur in only one of the three lists. `lootItems` for monsters refers to items in the campaign, pack, or the same ZIP.
- **Boss phases:** the first entry is the opening phase. Each phase accepts a name, GM text, and optional art. A later `atHp` is a threshold in HP slots, below full health and strictly descending among supplied thresholds. It creates a suggestion in the boss scene. The GM confirms the transition. Boss phases change the scene presentation. The GM continues to select attacks and other actions. `lootTier` refers to a current pack tier.
- **Item:** `slot` names a current ruleset slot. An optional `attack` uses existing sheet attack handling with `dice`, and optional known `skill` and `stat` IDs. `effects` supports integer `add` / `set` for an existing derived stat, `stat.<id>`, `mod.<id>`, `track.<id>.max`, numeric `field.<id>` or `skill.<id>`, with `equipped`, `carried`, or `always`. `use` supports a positive change to a known track, existing buff application/removal, or consuming the item, with `target: "self"` and an explicit boolean `consume`.
- **NPC:** a library and scene entry, with optional description and GM-only voice directions, hooks, and secrets. NPCs using combat mechanics need a separate monster entry. The manifest does not create voice recordings.
- **Custom abilities:** use `notes`, `tactics`, or an attack's `effects` for manual GM instructions. Arbitrary expressions, runtime JavaScript, trigger definitions and new mechanical operations are outside this format. Use displayed dice notation only.

### ZIP and art

```text
manifest.json
images/<id>.png
images/<another-id>.png
```

Use one single-disk ZIP, up to 5 MiB, with up to 33 entries including the manifest. Use stored or deflate compression, regular files, and explicit local-header sizes. The allowed UTF-8 flag is optional. Directory entries, ZIP64, encryption, data descriptors, comments, extra fields, duplicate paths, and leading/trailing data are rejected. Entry names are case-sensitive ASCII. Only the manifest and referenced `images/<id>.png` entries are allowed. The manifest limit is 256 KiB, each PNG limit is 1536 KiB, the sum of expanded entries is at most 4 MiB + 256 KiB, and the archive expansion ratio is limited to 200:1 per entry.

Art references are paths in this ZIP, including `image`, monster `variants`, boss `imageSquare`, `imageKo`, and `phases[].image`. No URLs or data URLs. A missing primary image uses the application's category placeholder. Missing optional variants are skipped and missing alternate boss art uses the usual boss image fallback. A reference to an absent file is reported in `missingImages`; a file present but corrupt or forbidden rejects the import.

PNG must be static, non-interlaced, 8-bit RGB or RGBA, and at most 2048 × 2048. The validator checks ZIP lengths and CRCs, PNG ordering, chunk CRCs, exact bounded scanline inflation and valid filters. Recognized PNG metadata is dropped, including embedded profiles, text, and EXIF. The package has a 32 MiB cumulative decoded scanline budget. Original upload bytes and metadata are discarded. Art is deduplicated by SHA-256 of the validated image bytes. Campaign art has a 4 MiB cumulative storage allowance. Imports create no executable or external file links.

### Persistence and isolation

The POST route requires GM credentials and the ID of the open campaign. The host checks the ID again after reading the ZIP, prepares the complete library and art update, and persists it once before responding or broadcasting the changed view. Any rejected entry or disk/SQLite write failure leaves the old library in place. Overlapping uploads get a conflict. Only imported entries and references enter role views, not the stored image byte map.

Campaign backups and exports carry the image bytes and existing art references. PNG routes serve only the currently loaded campaign's hashed images, under the same display model as pack artwork. The endpoint serves inline images with the correct MIME type, a restrictive CSP, and no caching across campaign changes. Campaign archives stay portable without a second media download. Art is retained with its campaign, including art from entries removed after import.

## Implementation and verification

1. Keep the public schema and the runtime validator in sync. Normalize accepted entries through the engine's existing homebrew definitions.
2. Validate binary input before storage, check campaign references and collisions, then commit one change using the existing persistence adapter in Node or Workers.
3. Wire the Library file picker to the authenticated endpoint and display precise failures. Exercise the same archive through the fight tracker, media endpoint, restart, and export/restore tests.
4. Keep maps for a later contract. Maps use `state.maps` rather than the library and need a stable map ID plus validation of fog, zones, tokens, and each zone's typed links. Map art can use the same validated media storage. V1 rejects `type: "map"`.

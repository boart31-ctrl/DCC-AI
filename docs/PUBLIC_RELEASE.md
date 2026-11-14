# Public release plan (decided 14 Nov 2026)

## Vision
An open-source, free companion app for in-person tabletop RPGs: the TV is the show, the GM laptop is the cockpit
and the sound, phones are character sheets, dice stay physical. Turn any book or setting into an RPG night.

## Name and IP
- No "DCC" or Dungeon Crawler Carl terms in the public product. The DCC pack stays private for the owner's table.
- A unique, searchable product name is still to be picked (candidates from the launch review: Hypetable,
  Couchcrawl, Crowdroll, Tavern TV, Nat20 Live; each needs a trademark check in classes 9, 28, 41).
- "The System" stays the name of the in-app announcer voice.
- No "D&D" or "Pathfinder" as product labels; rulesets are named by their licence (SRD 5.1 / 5.2, ORC).

## Rulesets
- Built in: 5e 2014 (SRD 5.1), 5e 2024 (SRD 5.2), PF2e remaster (ORC), plus each pack's own ruleset.
- Picked per campaign when it is created and locked; another system = another campaign.
- Library content (monsters, bosses, items) is written once and converted to the campaign's numbers.
  Media (art, sounds, voice lines, text) is shared; only numbers are per ruleset. See docs/RULESETS.md.

## Access and data
- Target: no registration; the GM owns the data. Today the server keeps the running campaign (persist before
  ack, restore points) and the GM desk keeps its own copy: browser backup every 5 minutes and on close, dated
  versions, optional folder (OneDrive / Dropbox / Google Drive folder = cloud copy), restore from a file.
- Next: a public relay that stores nothing (room codes that expire; the GM browser uploads the campaign when a
  session starts), Google Drive sync (drive.file scope), room caps and TTL on the hosted relay.

## AI and content
- AI only with the user's own key, stored in their browser / server secrets. The owner's credits are never used.
- Free default: browser voice plus pre-recorded lines; only redistributable sounds in the public build.
- Community packs are shared by users via export / import, never hosted as an official library.

## Scope
- No grid map / VTT. At most a simple image-reveal map on the TV; Owlbear Rodeo works next to it.

## Money
- Not for profit. Optional donations (GitHub Sponsors / Ko-fi). Check Czech tax treatment if amounts grow.

## Before announcing it (launch review, 14 Nov)
1. Generic demo pack with real art + "Episode 0" + a hosted demo that runs without a terminal.
2. Rename, remove crawler vocabulary from the generic engine UI ("Add crawler", "crawlers remaining").
3. Privacy note, CONTRIBUTING, SECURITY, an English GM guide.
4. Relay limits (sockets per room, room TTL, room creation per IP).

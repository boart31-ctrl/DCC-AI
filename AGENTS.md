# AGENTS.md — DCC-AI (public engine; read by Codex/GPT and Claude Code)

Engine of "The System": companion app for in-person RPG nights (TV show / GM desk / phone sheets).
Node 22, Cloudflare Worker + Durable Object (SQLite), WebSocket. `npm ci && npm test`.

**Project state, work queue and claim protocol live in the private sibling repo:**
`../dcc-ai-private/docs/ai/HANDOFF.md`. Read it first; claim your task there and push the claim
before you write code. If you don't have the private repo, stop and ask David for access.

Hard rules:
- This repo is public. Never put rulebook text, DCC names, stat blocks or adventure content here.
  Public = generic, configurable mechanics (rulesets); numbers and content go to the private pack.
- Every new GM/player action → a line in `docs/PROTOCOL.md` + a test in `server/test/`.
- New server module reachable from `engine.js` → add it to `server/test/isomorphic.test.js`.
- Web files changed → bump `CACHE` in `web/sw.js` and add new files to its precache list.
- Never hard-code the number of players; everything scales from characters in the campaign.
- Find code with `grep -n`, read line ranges; big files: `web/js/gm-scenes.js`, `web/js/combat.js`,
  `web/js/sheet.js`, `web/js/gm.js`, `server/combat*.js`, `server/state.js`.
- Commit subjects start with `[gpt]` or `[claude]`. Rebase, no merge commits. `npm test` green
  before every push.

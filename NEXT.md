# Next

_Updated 2026-09-20 — branch playlist-download_

## State
Proved ISOLATED→MAIN is a wall: Tier 1.7 never touched the player since June
(injection doesn't execute, cross-world postMessage doesn't arrive). Rerouted
via sniffer bridge + `chrome.scripting` MAIN fallback (`6f790ed`); dropped dead
Tier 1.6 from batch. LL spec **2 passed (40.4s), EXIT=0**.

## Open threads
- **Hegel still gated**: player arms (`respTracks=0`) but issues zero timedtext
  requests; cold tiers 400, embed has no tracks. Next: headed run (headless may
  be the whole problem), then SAPISIDHASH-authenticated InnerTube from background.
- **Single-video path uses ~10 dead ISOLATED player handlers** (`FORCE_CC_TRIGGER`,
  `GET_PLAYER_TRACKS`, `GET_PAGE_CONTEXT_*`, `FETCH_TIER2_*` — class sweep done,
  fixes not): route via scripting or retire.
- **Weekly CI smoke test**: designed, not written — `.github/workflows/weekly-e2e.yml`.

## Running / unfinished
- Nothing in background. Golden profile holds the working login (gitignored).
- All temp probe specs deleted; `e2e/` holds only the 5 permanent specs.

## Don't redo
- **Never inject `<script>` from ISOLATED world, never cross-world postMessage**
  — use document_start MAIN script or `chrome.scripting` (`scripting` perm added).
- **Don't `event.source`-filter the sniffer listener**; type+requestId is the boundary.
- **Track truth = `getPlayerResponse`, not `getOption`** (empty in headless).
- **Seed URL pinned to batch video + `autoplay=0`**; bare `/watch?` check let YT wander.
- **Cold API can't serve ASR-gated tracks**; cookies don't replace PoToken.
- **No cookie copies** (app-bound encryption); **proxy must be up**; stash≠baseline when `dist/` untracked.
- Full history in `docs/LESSONS.md`.

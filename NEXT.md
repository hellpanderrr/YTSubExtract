# Next

_Updated 2026-09-21 — branch playlist-download_

## State
Stale `dist/` (Sep-20 11:47, pre-1.7 wiring) was the whole bug. Fresh build:
9/9 Difference-and-Repetition in-page, Hegel in batch, LL 5/6 (only the
captionless meme fails). Latency trims shipped in `70e8205` (settled-fast 1.7,
fast-abort 2C, `iOS` fix); smoke 3 + LL spec 2 passed. All temp probe specs
deleted; `e2e/` holds only the 5 permanent specs.

## Open threads
- **Unified page-leg lock**: `_coerceLock` (1.7) and `_tabNavLock` (2C) are
  independent locks over one tab; under concurrency 3 a 2C nav can kill an
  in-flight drive. One lock for both. Start: `translation-manager.mjs:310,366`.
- **Circuit breaker**: after K consecutive full-chain failures, shorten
  timeouts for the rest of the batch. Never designed, just proposed.
- **Attestation findings UNSUPPORTED**: H1/H2, steal status, lock-race theory
  were derived from stale-build runs — treat as open. Proposed guard: e2e
  asserting the `[Tier 1.7 Player Coercion]` log line appears per video.

## Running / unfinished
- Nothing in background. Golden profile holds the working login (gitignored).
- User reloads the extension from fresh `dist/` after each build (stale-build
  lesson); remind them when shipping code for user-side runs.

## Don't redo
- **Rebuild + reload before ANY batch diagnosis** — check `dist/` mtimes vs
  HEAD, grep bundle for tier markers. A whole saga was a stale bundle.
- **Never inject `<script>` from ISOLATED, never cross-world postMessage** —
  document_start MAIN script or `chrome.scripting` (`scripting` perm added).
- **A raced 0-tracks never gates other tiers**; settled (videoId match × 2
  polls) only short-circuits its own wait. Auth always runs (0.7s).
- **Track truth = `getPlayerResponse`, not `getOption`**; seed pinned to batch
  video + `autoplay=0`; no cookie copies; proxy must be up.
- Full history in `docs/LESSONS.md`.

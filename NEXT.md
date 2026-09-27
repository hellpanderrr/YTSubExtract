# Next

_Updated 2026-09-27 — branch playlist-download_

## State
Both remaining items from the 2026-09-26 3-part plan are done. (1) Tier 1.7
wait-level fast-abort: `src/utils/fast-abort.js` + `content.js` wiring,
validated live (fired exactly on the 2 known-captionless videos, zero false
fires). (2) Tier 3 demoted behind Tier 1 in `translation-manager.mjs`
(historic-green check: 0/12 real successes across every available run) +
internal log noise quieted in `tier3-worker.mjs`. Both changes are
unit-tested and mutation-killed (`test/fast-abort.test.mjs`,
`test/tier3-order.test.mjs` — the latter needed
`--experimental-test-module-mocks`, now in the `test` npm script). Unit
**55/55**, build clean. Everything below is **uncommitted**.

## Open threads
- Commit when asked (10 changed/new files — `git status --short` has the
  full list; nothing untracked from before this session was touched).
- `docs/ISSUES.md` #1 (headless-vs-headed) — root cause narrowed to
  headless-mode detection, but the actual signal is unconfirmed, and headed
  isn't reliably immune either (this session's runs alone: 4/6, 0/6, 4/6 on
  the same playlist/profile/proxy). No fix attempted.
- Consider wiring `sw.on('console',...)`/`page.on('console',...)` into
  `e2e/fixtures.mjs` permanently (behind an env var) — added and reverted as
  a one-off diagnostic three times now across 2026-09-26/27.
- If youtubei.js is ever upgraded past 16.0.1 (latest is 18.0.0), re-check
  whether Tier 3 can be promoted back — the demotion was about it never
  succeeding, not about it being architecturally wrong.

## Running / unfinished
Nothing running. `dist/` is rebuilt against current **uncommitted** source —
reload the unpacked extension before any manual run.

## Don't redo
- Tier 1.7's fast-abort window is a floor from arm (t0), NOT from when the
  zero report arrives — mirrors 2C's existing `_probeSettledNoTracks` ~10s
  design. Data behind the 10s choice: captioned arm→tracklist up to 9646ms
  observed; see `docs/LESSONS.md` 2026-09-26/27.
- A batch's overall subtitle success rate is NOT a proxy for whether the
  Tier 1.7 timing logic or the Tier 3 reorder is correct — both are pinned
  by their own unit tests; check those, not a live run's success count,
  which swings 0/6 to 4/6 on the same config from network conditions alone.
- `batch-download` e2e green ≠ real extraction, headed OR headless (see
  `docs/ISSUES.md` #1) — don't treat any single run's success count as the
  reliable baseline.
- Falsy/nullish confusion is a standing `CLAUDE.md` rule ("Coding gotchas").
- Tier 3's per-video failure tax is modest (~1-1.2s, timed from the original
  log) — it was demoted for running before the tier that works on every
  video with zero payoff, not because it was expensive by itself.

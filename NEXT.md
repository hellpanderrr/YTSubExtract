# Next

_Updated 2026-09-27 — branch playlist-download_

## State
Both 3-part-plan items from 2026-09-26 are **committed** (`e280910`): Tier
1.7 wait-level fast-abort (`src/utils/fast-abort.js`, validated live) and
Tier 3 demoted behind Tier 1 (historic-green: 0/12 real successes; order
pinned by `test/tier3-order.test.mjs`). Unit 55/55, build clean.

This turn, **uncommitted**: the recurring SW/page console-diagnostics chore
finally made permanent — `e2e/fixtures.mjs` gained `attachConsoleRelay`
behind `E2E_CONSOLE=1` (relays `[e2e:SW]`/`[e2e:PAGE]` to test stdout;
documented in `e2e/README.md`), ending three sessions of pasting temp
listeners into specs. Plus a stale-doc catch: `CLAUDE.md`'s batch
fallback-order line still listed Tier 3 *before* Tier 1 (contradicting
`e280910`) — corrected, along with the Tier 3 table row and the test-file
enumeration (`tier3-order` was missing).

## Open threads
- Commit when asked: `CLAUDE.md`, `NEXT.md`, `docs/LESSONS.md`,
  `e2e/fixtures.mjs`, `e2e/README.md`.
- `docs/ISSUES.md` #1 (headless-vs-headed extraction gap) — root cause
  narrowed to headless-mode detection, actual signal unconfirmed, headed
  not reliably immune either. No fix attempted. `E2E_CONSOLE=1` now makes
  per-tier diagnosis possible in any run without editing specs.
- If youtubei.js is ever upgraded past 16.0.1 (latest 18.0.0), re-check
  whether Tier 3 can be promoted back — demoted for never succeeding, not
  for being architecturally wrong.

## Running / unfinished
Nothing running. `dist/` matches the committed source (this turn's changes
are harness/docs only — no rebuild needed). Reload the unpacked extension
before any manual run against `e280910`.

## Don't redo
- Tier 1.7's fast-abort window is a floor from arm (t0), NOT from when the
  zero report arrives — mirrors 2C's design; data: captioned arm→tracklist
  up to 9646ms (`docs/LESSONS.md` 2026-09-26/27).
- A batch's success count is NOT a proxy for tier-logic correctness — it
  swings 0/6↔4/6 on the same config from network alone; the unit tests are
  the proof.
- `batch-download` e2e green ≠ real extraction, headed OR headless (see
  `docs/ISSUES.md` #1).
- Never paste temp console listeners into specs — run with `E2E_CONSOLE=1`
  (wired 2026-09-27).
- Falsy/nullish confusion is a standing `CLAUDE.md` rule ("Coding gotchas").

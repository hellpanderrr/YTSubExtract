# Issues

Audit- and mining-shaped findings that outlived the session that found them.
Stable IDs — never renumber. `Status: FIXED` rows stay, with their evidence.

Total: 1 open, 0 fixed.

---

### #1 — headless e2e batch-download gets 0/6 real subtitles where a manual browser gets 4/6

**Status: OPEN**

**Found:** 2026-09-26, diagnosing the WatchSeed/Tier-1.7 timing work (see
`docs/LESSONS.md` 2026-09-26 entries).

**Evidence:** Two consecutive `npx playwright test e2e/batch-download.spec.mjs`
runs against `PLQXk9_XDN67L2N_-aBQwDiNnITHWPJ9b4` (6 videos, `E2E_BATCH_LIMIT=6`)
both landed `0/6` real subtitles — every video fell through to
`_errors.txt`, including the 4 videos (`4wCNFskBpR8`, `pQHTEyUlPsQ`,
`VMGcREb1f8A`, `lIVL0TVzrko`) that succeeded via Tier 1 IOS in a manual
browser run the same day (4/6 that day, logged in the user's exported
console log). Both e2e runs show scattered `net::ERR_CONNECTION_CLOSED` and
`the server responded with a status of 403 (Forbidden)` on resource loads
— a signature consistent with YouTube treating the headless/automated
Chromium session differently from the manual profile, not with the target
videos being genuinely captionless (they aren't — the manual run proved it).

**Why it matters:** `batch-download.spec.mjs` only asserts every selected
video is *accounted for* (subtitle file or `_errors.txt`), by design (see
`e2e/README.md` "Known limitations" — some videos legitimately have no
reachable captions). That design choice means a systemic headless-vs-real
extraction gap is invisible to the suite's exit code: two runs in a row
produced a "1 passed" result while proving nothing about real extraction.
`E2E_BATCH_EXPECT_SUCCESS=1` exists and would have caught this, but is
opt-in and not part of the default `npm run e2e` invocation.

**Not fixed this session** — investigating why headless gets blocked where
the manual profile doesn't (proxy/IP difference between the two Chrome
profiles? User-agent or automation-flag detection? `.e2e-profile-golden/`
cookie staleness?) is a separate, larger task than the timing work this
session was doing. Logged here so the next session doesn't have to
re-discover it from a green CI run.

**Suggested next step:** run `batch-download.spec.mjs` once with
`E2E_HEADED=1` against the same playlist and compare — if headed passes and
headless fails, the automation flag (`navigator.webdriver` or Chromium's
`--headless` detection surface) is the likely cause, not the proxy or
cookies (both are shared with headless runs already).

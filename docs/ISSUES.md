# Issues

Audit- and mining-shaped findings that outlived the session that found them.
Stable IDs — never renumber. `Status: FIXED` rows stay, with their evidence.

Total: 16 open, 2 fixed.

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

**2026-09-27 — narrowed, NOT isolated (downgraded same day):** ran the suggested
`E2E_HEADED=1` comparison against the same playlist
(`PLQXk9_XDN67L2N_-aBQwDiNnITHWPJ9b4`, `E2E_BATCH_LIMIT=6`, same
`.e2e-profile-golden/`, same proxy). First headed run: **4/6**, the *exact same*
4 video IDs (`4wCNFskBpR8`, `pQHTEyUlPsQ`, `VMGcREb1f8A`, `lIVL0TVzrko`) that the
manual browser got and headless never got. That initially read as headless-mode
detection isolated as the variable.

**Downgraded later the same day** (second-opinion review): two further headed runs
against the identical config landed **0/6 and 4/6** (see `docs/LESSONS.md`
2026-09-27, fast-abort section) — headed is NOT a reliable positive control, so
the first 4/6 may have been network luck rather than proof that "only headlessness
flips the outcome." Standing tally: headless 0/2, headed 2/3 — a correlation, not
an isolation. Proxy/cookies are likewise not fully ruled out (a headed run failed
with them present). Still-open candidate signals, none tested in isolation:
1. **Automation flags** — `e2e/fixtures.mjs` strips neither `--enable-automation`
   nor adds `--disable-blink-features=AutomationControlled` (unlike
   `e2e/login.mjs`), so every test run carries `navigator.webdriver`; but headed
   runs carry the same flags and sometimes pass, so flags alone cannot explain
   the headless/headed split either way.
2. **The server-visible `HeadlessChrome/...` UA token** headless Chromium still
   sends — a stronger fit for the `403`/`ERR_CONNECTION_CLOSED` signature than a
   client-side JS flag, never tested.
3. **Transient network variance** — the same signature appears in runs that
   later succeed (this day's own runs), so it may be partly luck-shaped.

**What would diagnose it**: N≥3 runs per variant with variables separated (flags
/ UA / both), plus an in-page assertion recorded each run that the manipulation
actually took effect (`navigator.webdriver` value, UA string). Any single-run
flip proves nothing at the observed variance — and any fixtures change must be
env-gated, since the current un-gated config is the one producing the 4/6s.

**Still not fixed** — no code change from this.

**2026-10-01 — the driver looks like YouTube's bot-check state, not headless-ness:** headed runs on this machine today went 0/6, 0/6, 0/6, 4/6, 0/6, 0/6 (pre- and post-`5016f65` builds alike). The failing runs' service-worker logs show Tier 1 getting `LOGIN_REQUIRED` "Sign in to confirm you’re not a bot" on every client, 0 Tier 1 successes. That overshadows the headless-vs-headed correlation above (which was 0/2 vs 2/3 on a day the bot-check was apparently off). Still open; the useful next step is measuring how often the bot-check is on, not flag/UA experiments.

---

### #2 — dead embed-iframe tier weakened YouTube's framing protection and muted third-party embeds

**Status: FIXED** (2026-09-29)

**Found:** 2026-09-29, architecture review. `_fetchTranscriptViaEmbedFrame` had zero callers, yet: DNR rules 4/5 stripped `X-Frame-Options`/CSP from every youtube.com and youtube-nocookie.com sub_frame for ALL tabs (clickjacking exposure); the manifest injected the MAIN-world sniffer with `all_frames:true`, whose iframe block muted, kept muting, and force-captioned every YouTube embed on any website; and the iframe relay posted signed timedtext URLs (`pot`/`sig`) to `window.parent` with target `'*'`.

**Fix evidence:** method, `INJECT_EMBED_FRAME` handler, rules 4/5, sniffer iframe block + relay deleted; `all_frames` removed. Pinned by `test/manifest-hygiene.test.mjs` (mutation-killed both ways: all_frames restored -> fails; lowercase `x-frame-options` rule re-added -> fails).

---

### #3 — Tier 1.7 / 2C ignore `translate` but results are labelled translated

**Status: OPEN** · medium · verified

`getTranscriptForPlaylist` passes only `lang` to `_coercePlayerTranscript` / `_fetchTranscriptViaTabNav` yet sets `translated: translate`; `main.mjs` names files with `targetLang` when `translate` is on. A "translate to ru" batch can ship untranslated source-language cues under `_ru` filenames with no error. Fix: pass translation through, or fail/label honestly when a tier cannot translate.

**2026-10-01 — Tier 0 and Tier 0.1 parts FIXED** (found by CodeRabbit on PR #2, verified): Tier 0's `/get_transcript` path and Tier 0.1 never translated but ran before Tier 1. Now a translated request skips `/get_transcript` (uses timedtext `&tlang=`) and skips Tier 0.1. Pinned by `test/android-translate.test.mjs` and `test/tier01-translate.test.mjs`. The Tier 1.7 / 2C part above is still OPEN.

---

### #4 — single-video Tier 3 Legacy returns `{start,end}`; download rebuilds end = start + duration

**Status: OPEN** · medium · verified, dormant (Tier 3 has no recorded success)

Tier 3 Legacy in `translation-manager.mjs` normalizes to `{start,end,text}`; `handleGetTranscript` (main.mjs) recomputes `end = start + (duration||dur||0)`, so every cue is zero-length. Root cause is inconsistent tier return shapes (`{start,duration}` vs `{start,end}`); fix by normalizing once, at one boundary, with a test.

---

### #5 — some caption fetches have no timeout (same class as closed #12)

**Status: OPEN** · medium · verified

`_extractFromEmbed` (bare `fetch(fetchUrl)`, reached from the batch chain) and five single-video sites use `fetch()` with no AbortSignal. A stalled socket pins a semaphore slot while the 15s heartbeat keeps the popup on "running". Fix: `fetchTextWithTimeout` at those sites.

---

### #6 — ZIP can be lost while status says completed

**Status: OPEN** · medium · swallowed-error half verified, storage-quota half plausible

`main.mjs` falls back to writing the whole ZIP as base64 into `chrome.storage.local` if `downloads.download` throws; the manifest has no `unlimitedStorage`, and a failure there is only `console.error`'d before status is set to completed. Results live only in service-worker memory. Fix: surface an error status; consider `unlimitedStorage` or a retry.

**2026-10-01 (Pullfrog, PR #2):** `chrome.downloads.download` resolves when the download STARTS, so `swDownloaded = true` also claims success for a transfer that later interrupts, and nothing watches `downloads.onChanged`. Its specific scenario (a cancelled Save-As chooser reported as success) is probably wrong, since Chrome rejects that case, but this is untested headless.

---

### #7 — Tier 0.5 Auth bypasses the page-leg lock and pinned tab

**Status: OPEN** · low-medium · verified read, impact plausible

`_fetchTranscriptAuth` picks `tabs.find(active) || tabs[0]` and is not serialized; a concurrent Tier 2C navigation can close its port -> false failure of the last-resort tier. Fix: route through `_resolvePageLegTab` + `_enqueuePageLeg`.

---

### #8 — output layer is untested and triplicated; timedtext parser copied ~8x

**Status: OPEN** · medium

Zero tests for `subtitle-formats.js`, the separate SRT/VTT/TXT copies in `main.mjs`, `zip-generator.js` filename helpers, or playlist/caption response parsing. Three formatter implementations (popup, background, dead zip-generator). The XML/JSON3 timedtext parse is copy-pasted ~8 times (content.js x5, translation-manager, youtube-caption-extractor, tier3-worker) with double entity-decoding, undecoded numeric entities, and multi-line cues silently dropped (`.` without the `s` flag). Fix: one pure `parseTimedText` + one formatter module in `src/utils`, unit-tested; delete the copies.

---

### #9 — CI never runs the tests

**Status: OPEN** · medium · verified

All four `.github/workflows` only build/publish, on Node 18; `npm test` needs Node >= 22.3 (`--experimental-test-module-mocks`). `package.json` has no `engines`, no coverage tool, no lint. Fix: a test workflow on Node >= 22.3 + `engines`.

**2026-09-30:** `.github/workflows/test.yml` (Node 22, `npm ci`, `npm test`, `npm run build`) and `engines: >=22.3.0` added; the suite verified 59/59 on Node 22.3.0 locally and the YAML/`npm ci` validated. Stays OPEN until a first green run is observed on GitHub. Still open under this ID: no coverage tool, no lint, release workflows still on Node 18 without tests.

---

### #10 — page-forgeable messages into the pipeline (hardening)

**Status: OPEN** · low-medium · needs attacker JS inside a youtube.com frame

`YTSUB_CAPTURED_URL`/`YTSUB_CAPTURED_TRANSCRIPT` carry no nonce and the URL is not host-checked before the service worker fetches it; the COERCE status handler accepts the constant `requestId==='scripting'`; sniffer `REQUEST_MAIN_WORLD_FETCH` fetches any URL with credentials (blind). Since #2 removed iframe relays, `content.js` can now safely require `event.source === window`. Fix: source filter + host/path allowlist (`*.youtube.com/api/timedtext`) + per-call ids.

**2026-10-01:** how `event.source` behaves across the ISOLATED/MAIN worlds is documented inconsistently — `docs/LESSONS.md` 2026-09-20 says ISOLATED->MAIN `postMessage` does not cross worlds, while the sniffer's own probe round-trip proves messages do arrive, and two independent reviewers (one a bot) assert `event.source === window` holds. Needs a short real-browser probe before adding the filter. Comments in `content.js`/`sniffer.js` now say this instead of asserting either side.

---

### #11 — dead code and small leaks

**Status: OPEN** · low · grepped

No callers: `metadata-tier1.mjs`, `zip-generator.js`, `GET_PLAYLIST_TRANSCRIPT`/`handleGetPlaylistTranscript`, content handlers `GET_CAPTION_TRACKS` and `GET_CAPTURED_TRANSCRIPT`, `getPageVariable`, `_getLanguagesTier1`, `createZipInBackground`, several extractor functions. Leaks: sniffer `capturedResponses` is written for every capture and never read; `__ytsub_captured_transcripts` grows for the tab's life.

**2026-10-01:** the content-script half is FIXED — `capturedTranscripts` is capped at 40 videos via `pruneOldest` (`test/prune-map.test.mjs`). The sniffer's own `capturedResponses` (never read) and `__ytsub_captured_transcripts` still grow.

---

### #12 — test-harness fidelity gaps hide bugs

**Status: OPEN** · medium · verified

`test/helpers/chrome-mock.mjs`: `storage.local` keeps references (no structured clone); `runtime.lastError` is only set by `tabs.get`, so the real "Receiving end does not exist" branches in translation-manager are never exercised; callbacks fire synchronously. Also: `fast-abort.test.mjs` never varies `getTracklistCount` over time (a read-before-sleep mutant survives); `video-url.test.mjs` never tests 12-char IDs (a `{11,}` mutant survives); `batch-download.spec` never asserts subtitles + errors == selected; the smoke login test asserts only `typeof === 'boolean'`.

---

### #13 — Tier 1.7 double-drive and duplicated drive function

**Status: OPEN** · low-medium · plausible, not traced

content.js fires the scripting fallback (`DRIVE_PLAYER_MAIN`) after 6s if not finished, even when the sniffer drive is merely slow -> two drivers with independent timers on one player, uncancellable. `MAIN_DRIVE_FUNC` (main.mjs) duplicates `drivePlayerCoercion` (sniffer.js) and will drift.

---

### #14 — stale `_cachedTitle` and cross-tier track-selection drift

**Status: OPEN** · low-medium · verified

`_cachedTitle` is instance-level and never cleared: Tier 2 for video A, then a title-less result for B, caches A's title as B's. With `sourceLang='auto'` the winning tier decides the language (Android/1.5/Tier 3 prefer en, Tier 1 takes track[0], 1.7/2C take what the player arms).

---

### #15 — service worker death mid-batch loses all results (no resume)

**Status: OPEN** · low (architectural)

Results, cache, pin and `_originalTabUrl` are memory-only. The 60s staleness guard recovers the UI but not the data or the tab restore.

---

### #16 — weekly canary conflates YouTube bot-check state with extraction failure

**Status: OPEN** · medium · verified by local runs 2026-10-01

`scripts/weekly-canary.mjs` fails a run when fewer than `CANARY_MIN_OK` subtitles are produced. On this machine that happened in 5 of 6 headed runs in one day, every time with the service worker's Tier 1 receiving "Sign in to confirm you’re not a bot" (curly apostrophe). A canary that mostly measures the runner IP's bot-check state will open issues for non-bugs and train people to ignore it. Fix: capture the SW console (`E2E_CONSOLE=1`, piped rather than inherited), classify a below-threshold run with bot-check hits as INCONCLUSIVE, keep inconclusive runs out of the consecutive-failure streak, and open a separate 'blocked for N weeks' issue. Needs unit tests for the new state machine branch.

---

### #17 — PR #2 review-bot findings (Pullfrog + CodeRabbit), verified and fixed

**Status: FIXED** (2026-10-01)

Each finding was checked against the code before fixing; two bot claims were wrong or half-wrong (see `docs/LESSONS.md` 2026-10-01). Fixed, with tests where behavior changed:
- Playlist continuation pages returned every video twice (`parsePlaylistVideos`; reproduced 3 videos -> 6 entries). Latent: no caller asks for >100 videos. `test/playlist-extractor.test.mjs`.
- Tier 0 / Tier 0.1 ignored `translate` (see #3 note). `test/android-translate.test.mjs`, `test/tier01-translate.test.mjs`.
- `capturedTranscripts` never pruned (see #11 note). `test/prune-map.test.mjs`.
- `weekly-canary.yml` never installed Playwright's browser, so a clean runner could not start the spec; checkout now `persist-credentials: false`.
- `weekly-canary.mjs`: failure streak is saved BEFORE the `gh` call (verified with a deliberately invalid token), a failing `gh` call is reported and turns the job red instead of crashing, and the close-issue branch posts the report it wrote.
- Unused `puppeteer` dependency (only two untracked, documented-stale scripts used it) and their dead npm scripts (`login`, `test-batch`) removed.
- `YTSUB_CAPTURED_URL` handler now ignores messages without a string `url` instead of throwing.
- Batch e2e spec now requires every selected video to have a subtitle when there is no `_errors.txt`.
- False/stale comments corrected: `content.js` and `sniffer.js` described the deleted iframe relay; the `_enqueuePageLeg` comment claimed the failed caller times out; `fixtures.mjs` header claimed test-scoped while the code is worker-scoped (the README was right).
- `.env.e2e.example` trailing newline.

---

### #18 — a page-leg executor that throws early leaves its caller hanging

**Status: OPEN** · low · verified by `test/tab-pin.test.mjs` ("this caller is lost")

If the executor inside `_coercePlayerTranscript` / `_fetchTranscriptViaTabNav` throws before its timer is created, the lock chain recovers but that call's promise never settles, so one batch worker waits forever. Tier code is not expected to throw there, so only the misleading comment was corrected. Fix: wrap the executor body so any throw calls `passThrough(null)`.

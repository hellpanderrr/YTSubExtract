# Issues

Audit- and mining-shaped findings that outlived the session that found them.
Stable IDs — never renumber. `Status: FIXED` rows stay, with their evidence.

Total: 21 open, 6 fixed.

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

**Status: FIXED** (2026-10-02 skip → 2026-10-03 Tier 1.7 skip reversed, arming fixed → 2026-10-05 gate made bidirectional, Tier 3 fallback gated) · medium · verified in tests; whether the live player honors `translationLanguage` is unconfirmed

`getTranscriptForPlaylist` passes only `lang` to `_coercePlayerTranscript` / `_fetchTranscriptViaTabNav` yet sets `translated: translate`; `main.mjs` names files with `targetLang` when `translate` is on. A "translate to ru" batch can ship untranslated source-language cues under `_ru` filenames with no error. Fix: pass translation through, or fail/label honestly when a tier cannot translate.

**2026-10-01 — Tier 0 and Tier 0.1 parts FIXED** (found by CodeRabbit on PR #2, verified): Tier 0's `/get_transcript` path and Tier 0.1 never translated but ran before Tier 1. Now a translated request skips `/get_transcript` (uses timedtext `&tlang=`) and skips Tier 0.1. Pinned by `test/android-translate.test.mjs` and `test/tier01-translate.test.mjs`. **2026-10-02 — Tier 1.7 / 2C part FIXED too** (CodeRabbit + Pullfrog, round 2 on PR #2; Pullfrog also noted that gating Tier 0 made this path more reachable): a translated request now skips both and falls through to the translation-aware Tier 0.5 Auth fallback, which appends `&tlang=` throughout. Pinned by `test/tier01-translate.test.mjs`, mutation-killed three ways. Trade-off: a translated request for a PoToken-gated video now relies on Auth and may fail honestly, instead of returning source-language text under a target-language filename.
**2026-10-03 — Tier 1.7 part REVERSED (this trade-off came due).** A real user log the same day showed the cost: with every API tier bot-checked and 1.7/2C skipped, a translated batch had ZERO working tiers — every video `All API-only tiers failed`, no video page ever opened, empty result. Meanwhile the player's own code showed 1.7 *can* translate: `setOption('captions','track', { languageCode, translationLanguage: { languageCode } })` makes the player build `tlang=` into its timedtext request (`u.translationLanguage && (H.tlang = g.lM(u))`, extracted from the live player bundle 2026-10-03). So the fix is no longer "skip and rely on Auth" but **"arm with `translationLanguage` and accept only a verified translation"**: the sniffer already parses `tlang` off the captured URL, and `captureMatchesRequest` (`src/utils/translated-capture.js`) refuses any capture whose tlang does not equal the requested target. A player that ignores the option therefore produces an honest fall-through, not a mislabel — the #3 property is kept *by evidence* instead of by avoidance. Tier 2C stays skipped for translated requests (it never arms a track, so it can never produce a tlang capture), and the translated-batch watch-page seed is back (1.7 is the seed's reader). Pinned by `test/tier01-translate.test.mjs` (1.7 armed with tlang; 2C still skipped), `test/seed-translate.test.mjs`, `test/translated-capture.test.mjs`. **Not yet verified against a live player**: that YouTube's current player honors the `translationLanguage` field end-to-end (probe written, `e2e/probe-tlang.spec.mjs`; blocked in headless by bot-check — needs one run in the real Chrome profile). Until then the safe-failure property carries the risk.
**2026-10-03 (later) — arming clobber fixed** (`e598267`): a real batch showed 1.7 armed but every capture `tlang=none` — the driver ran a bare `setOption('captions','track')` after the translated one, overwriting it. Now the bare call runs only if the rich one throws. **2026-10-05 review — three more holes in the same family, fixed:** (1) the gate was one-directional — `captureMatchesRequest(x, null)` returned true, so an *untranslated* request could take a leftover `tlang` capture and ship translated text under the source label (the reverse mislabel); now `(captureTlang||null) === (wantTlang||null)`, and the two untranslated readers (`POLL_TRANSCRIPT` for 2C, the dead `GET_CAPTURED_TRANSCRIPT`) apply it too. (2) Every capture store keyed on `lang` alone, so a source capture (`lang=en`) and a translated one (`lang=en&tlang=ru`) overwrote each other, last writer wins — `captureKey` now keys translated entries `lang|tlang`. (3) The MAIN-world global dropped `tlang`, so backfilled captures always arrived `tlang: null`. The earlier "never a mislabel" claim was false until (1) landed. All three old behaviours are mutation-killed by `test/translated-capture.test.mjs`. The live player honoring `translationLanguage` remains unproven — `armed = true` only means `setOption` didn't throw.
**2026-10-05 — PR #2 bot round on the above, fixed:** (Pullfrog) once 1.7 succeeded for translated requests, the existing test short-circuited before 2C, so **nothing pinned 2C's translate-skip** — removing it left the suite green, and the earlier "pinned by `test/tier01-translate.test.mjs`" claim was false. A new test makes 1.7 fail first and asserts 2C is skipped and Auth answers; the gate removal is now killed. (Pullfrog) **Tier 3's engagement-panel fallback** (`info.getTranscript()`) is always source language, yet both callers labelled its result `translated: translate`; the youtubei.js 18 bump made that path reachable again (the 2026-10-03 19:01 log shows a translated batch reaching `get_transcript … 400`). The worker now refuses that fallback for a translated request, the fallback result carries `isTranslated: false`, and both callers refuse `translate && isTranslated !== true` and label from `isTranslated`. The caller-side refusal is tested and mutation-killed; the worker's own `if (translate) throw` is defence in depth and is NOT executed by any test (`tier3-worker.mjs` is `mock.module`'d in every suite that reaches Tier 3). (Pullfrog) the store-reader wiring test used `>= 2`, which could not detect a missing gate — it now lists every gate call exactly, and the one ungated fast path (`GET_CAPTURED_TRANSCRIPT`'s `videoMap.get(lang)`) is gated.

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

**2026-10-05 (CodeRabbit, PR #2, re-raised as "outside diff"):** confirmed still true at `main.mjs` (storage-fallback catch only logs, then the terminal write reports `completed`). The popup does notice — `downloadCompletedZip` finds nothing and shows "ZIP could not be delivered; reopen the popup to retry", keeping the record — but retrying cannot succeed, because the data was never stored. Left open deliberately: pre-existing and outside this PR's diff. Fix still as above: an error terminal status when both delivery paths fail.

**Correction (2026-10-05, close):** the paragraph above calls this "pre-existing and outside this PR's diff". That holds only against this session's commits. Against the PR base it is IN scope: `origin/main` has no `chrome.downloads.download`/storage fallback at all, because the whole playlist batch-download feature is new in PR #2 — so it ships in 1.1.5. CodeRabbit's suggested shape: keep the storage-fallback failure in a `deliveryError`, pick `terminalStatus = 'error'` when set, and store its message in the progress record. Before doing that, check how the popup treats `status: 'error'` in `checkAndRestoreProgress`/polling so the user sees the failure rather than a stuck UI. Still OPEN.

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
- Round 2 (Pullfrog): the batch spec's `E2E_RESULT_FILE` write sat BELOW the new strict assertion and below two older ones, so a failing run lost its counts and the comment saying otherwise was false. It now precedes every assertion.
- Round 3 (Pullfrog): `seedWatchPage` is skipped for translated batches. Its only readers are Tiers 1.7/2C, which translated requests now skip, so it was a forced navigation of the user's tab plus up to ~45s of blocking probes for nothing. `test/seed-translate.test.mjs`, mutation-killed both ways (condition removed, condition inverted).

---

### #18 — a page-leg executor that throws early leaves its caller hanging

**Status: OPEN** · low · verified by `test/tab-pin.test.mjs` ("this caller is lost")

If the executor inside `_coercePlayerTranscript` / `_fetchTranscriptViaTabNav` throws before its timer is created, the lock chain recovers but that call's promise never settles, so one batch worker waits forever. Tier code is not expected to throw there, so only the misleading comment was corrected. Fix: wrap the executor body so any throw calls `passThrough(null)`.

---

### #19 — translation requests skip the `isTranslatable` and same-language checks

**Status: OPEN** · medium · half-verified

Raised by Pullfrog, round 3 on PR #2. **Verified in the code:** every `&tlang=` append in the batch paths is unconditional on `translate` — Tier 0.5 Auth's six strategies (`content.js` ~1689-1723), Tier 1 (`youtube-caption-extractor.js:611`) and the Tier 0 timedtext fallback (`:733`). `isTranslatable` is consulted only in the single-video path (`content.js:2352`). **Not verified** (rests on the bot's yt-dlp references): that YouTube returns the source or a damaged track when the target equals the track's own language or the track is not translatable, and that an 'auto' request picks the English track. Suspected effect: a 'translate to English' batch on an English track sends `lang=en&tlang=en` and may return source text labelled translated — the #3 mislabel, relocated. Fix: one shared guard (skip `tlang` when the track is not translatable or the target equals the track language, and label the result `translated: false` truthfully), with a test. Confirm YouTube's actual behaviour with one real request first.

---

### #20 — graft wiring: unpinned MCP package, baked local path, hook latency

**Status: OPEN** · low-medium · verified 2026-10-02 (decision pending)

Raised by Pullfrog on PR #2 and checked: (1) `.mcp.json` runs `npx -y @nanonets/graft mcp` unpinned, so anyone opening the repo in Claude Code executes whatever the package publishes — a remote-code path. It cannot simply be pinned to the version exercised here: the user's global `graft` is an unreleased local build (0.17.0, symlinked to `...\tools\graft-src`), `npm view @nanonets/graft@0.17.0` is a 404, and the registry has 0.16.0 and 0.18.0-0.21.1 (0.21.1 never run here). Options: use `graft mcp` (the global build, same as the hooks; no remote exec, a clone without graft just cannot start the server), pin 0.21.1 after a sandbox check, or leave it. (2) `.claude/helpers/graft-hooks.cjs` bakes `C:\Users\hellpanderrr\tools\graft-src\dist\claude` as its first candidate: a personal path in a public repo, and the hooks use the local build while the MCP server may use a different one. Removing it doubled hook latency (478 -> 1003 ms per call, measured), so it was left. Hooks fire on every prompt and many tool calls.

---

### #21 — Tier 0.5 DOM extraction returned a different playlist's videos

**Status: FIXED** (2026-10-02, code + tests + offline verification against a live page; extension rerun still pending) · high (correctness) · user report + session log; root cause confirmed from the log, key payload facts verified against a live page

Reported 2026-10-02: the user opened a German-philosophy playlist (the page itself showed the right videos), opened the popup — it listed the previously downloaded Deep Learning videos, and the batch then downloaded DL subtitles into a ZIP named after the German playlist. The session log confirms both halves: Tier 0.5 returned `title: Введение в немецкую классическую философию` with `videos[0]=s2uXPz3wyCk` ("Deep Learning 1"), the batch processed `s2uXPz3wyCk` + `dfZ0cIQSjm4`, and the ZIP filename was the German title. **Proven:** the extractor read the right tab/page (the page-level `listId` guard passed, the German title came from the live page) but returned the wrong rows, and `readUntilStable` only compares counts (10 old ≈ 10 new → "stable"). **Mechanism confirmed from the log, not merely argued:** the wrong rows came from the live DOM path, not a stale `ytInitialData`. In `content.js` the ytInitialData branch builds its videos and its title from the *same* `initialData` object and returns early — had the videos come from there, the title would have been the DL playlist's. The log shows the German title, so the DOM path (`readDomSnapshot` + DOM title selectors) produced both, i.e. stale-for-this-page rows genuinely existed in the German document. What the log could *not* name is *which selector* matched them (logs were failure-only, and the repo's own comment says `ytd-playlist-video-renderer` is no longer emitted). Two holes regardless: the sweep ran document-wide selectors before the scoped `ytd-browse[page-subtype="playlist"]` one, and nothing checked a row's href `&list=` against the requested playlist. **Fix:** rows carry `listId` and are dropped only when *positively* tagged with a different playlist (untagged kept — absence is not evidence); `sweepPlaylistSelectors` prefers **positive evidence over position**: the first selector with a `listId === playlistId` row wins even past an earlier untagged survivor (otherwise a stale untagged container re-creates the incident with the filter neutralized), falling back to positional order only when nothing is positively tagged; `pickRowHref` takes the row link from the first anchor whose href actually bears `list=` (see hazard below); the ytInitialData fallback applies the same identity check; the sweep logs per-selector raw/kept counts (deduped across stability re-reads) plus the winning selector, and Tier 0.5 extraction logs now print on success too — previously failure-only, which is why this run was undiagnosable. Pinned by `test/playlist-rows.test.mjs` (filter + sweep + pickRowHref behaviour incl. the incident shapes, plus source-hygiene assertions that `content.js` wires the sweep with `msg.playlistId` and uses `pickRowHref`).

**Verified against a live playlist page 2026-10-02** (curl of `playlist?list=PLs-uFzw…`, no browser needed — this replaced the "needs the user's repro" step for the facts that could be settled offline):
- **Rows DO carry `list=`** — a lockup row's real link is `/watch?v=<id>&list=PLs…&index=N&pp=iAQB`, so the identity filter is live, not inert. Rows render as `lockupViewModel` (9 matched on a 10-video playlist), never `playlistVideoRenderer` — consistent with the selector list.
- **The ytInitialData guard's field IS present** — `playlistVideoRenderer.navigationEndpoint.watchEndpoint.playlistId` exists in the browse payload, so the fallback guard does not silently no-op (the round-2 worry was wrong for this payload shape).
- **New hazard found and fixed while verifying:** each row emits BOTH a bare `/watch?v=<id>` (a click-tracking endpoint) and the list-bearing link, and `el.querySelector('a[href*="/watch"]')` returns the first in DOM order — which can be the bare one. That would have made every row `listId: null` → untagged → filter passes it → the whole fix defeated. `pickRowHref` selects by presence of `list=` instead, order-independent.
- **Still genuinely needs the live extension repro:** the DOM-order half inside a hydrated SPA document and the batch-level end-to-end (popup lists the right videos; batch processes the right ids). Those are the only unverified parts left.
- Confirmed offline too: an empty Tier 0.5 result still reaches the credentialed fallback — `fetchPlaylistVideosAPI` throws (never returns `[]`) when all clients fail, and `main.mjs`'s catch calls `_fetchPlaylistPageAuth`.

**E2E attempted 2026-10-02 — a black-box spec cannot discriminate this fix, verified two ways (do NOT rebuild it without reading this):**
- A navigation spec (`goto` A → `goto` B → popup) **passed on the pre-fix build** (fix stashed, rebuilt, 2/2 green): `page.goto` is a full reload — a fresh document, so the incident's stale rows cannot exist. It asserts nothing.
- An **injection** spec (stale foreign rows planted in the live document, then the popup read) **also passed on the pre-fix build**, for two independent reasons the SW logs expose: (1) YouTube's framework re-renders and **removes injected nodes between the extractor's stability re-reads** — the log shows `Found 2 videos using selector: ytd-playlist-video-renderer` on the first read, then `No videos found in DOM or ytInitialData` (a persistent-injection interval did not beat the re-render either); (2) when a DOM tier returns empty it **falls through to the API**, which yields the correct list, so the popup is right regardless of the DOM fix (`Tier 0.5 failed or empty, falling back to API`). The incident required Tier 0.5 to *succeed with wrong rows* (short-circuiting the API) — a condition a black-box popup test cannot force reliably.
- **What actually verifies the fix:** offline curl against a live page (row hrefs carry `list=`; `watchEndpoint.playlistId` present — see above) plus **mutation testing of the unit tests** — `scripts/mutate-playlist-rows.mjs` stubs 4 mutations (filter inert; drop-untagged; positional sweep; first-anchor `pickRowHref`) and all 4 are killed by `test/playlist-rows.test.mjs`. That is the coverage that pins the behaviour; the E2E cannot. **Residuals (accepted, mimo round 3):** (a) a positively-tagged win vouches for its selector's *entire* kept set — untagged rows alongside the tagged one ship too, so the unscoped last-resort selectors can still smuggle untagged foreign lockups; (b) the positive-over-positional rule can *shorten* — a later selector with 1 positively-tagged row beats an earlier correct-but-untagged set of 10 (observable via the `Row filter: kept X of Y` line); trade accepted because wrong-playlist subtitles are worse than a short list, and merging rows across selectors would reintroduce mixing. Both live and die on the live repro: the fix is inert entirely if current YouTube renders playlist rows as bare `/watch?v=x` with no `list=` — check for `(positive list= match)` in the log.

---

### #22 — first-srt latency: doomed metadata/tier cascades precede the first subtitle (~22s machine time)

**Status: OPEN** · medium · verified from the 2026-10-02 popup log

From a real session log (2026-10-02): popup open → first srt = 37.4s wall clock, ~22s of it machine time: (a) **7.1s** language/metadata fetch for `videos[0]` walks cheap → Tier 1 → Tier 3 → Tier 2 → Tier 4, every one fails on bot-check, and the popup then falls back to the full language list anyway; (b) **8.2s** WatchSeed navigation → attested tracklist (BotGuard, unavoidable); (c) **6.5s** per-video Tier 0 → 3 → 1 → 1.5 failures before Tier 1.7 succeeds — while the srt build itself took 60ms. Second video finished 1.5s after the first, so the seed/cascade cost is paid mostly once. Overlaps #1 (bot-check is the driver) and #16. Candidate fixes, cheapest first: fail-fast the popup language fetch (fall back to the full list after the first bot-check-negative tier instead of walking every tier); skip the pre-Tier-1.7 cascade for subsequent videos once this batch has positively seen bot-check from those clients.

---

### #23 — Web Store upload automation: expired refresh token, OAuth app possibly still in Testing

**Status: OPEN** · medium · verified 2026-10-05

`publish_store_draft.yml` failed with a bare `HTTPError: Response code 400` (the upload action hides Google's error body) because `REFRESH_TOKEN` had expired; the previous successful upload was 2026-09-25. Probable cause: the OAuth consent screen of Cloud project `ytsubextract-api` was in **Testing**, whose refresh tokens expire after 7 days. A new token was generated with the OAuth Playground (`chromewebstore` scope) and set as the repo secret; the re-run succeeded (`uploadState: SUCCESS`, built from `925e361`). **Unconfirmed:** whether the app was then switched to **In production** — Google blocked it with "valid app name, support email, homepage URL and privacy policy URL are required"; the values to use are `https://github.com/hellpanderrr/YTSubExtract` and `https://github.com/hellpanderrr/YTSubExtract/blob/main/PRIVACY.MD` (both return 200). If it is still Testing, the new token stops working about 2026-10-12. **Also:** the refresh token was pasted into a chat session, so it should be revoked at https://myaccount.google.com/permissions and replaced (set it with `printf '%s' "$T" | gh secret set REFRESH_TOKEN`; `gh secret set` with no stdin stores an empty value). Fix to build: nothing in code; consider a workflow step that fails with a clear "refresh token expired" message instead of the bare 400. **2026-10-07:** built — `release.yml`'s "Verify store upload credentials" step exchanges the refresh token before the upload and fails with the cause named (it never prints the response, which carries an access token); `publish_store_draft.yml` is retired by the release-rail rework.

---

### #24 — Stop during the watch-page seed holds, but the batch only ends when the seed returns

**Status: OPEN** · low-medium · from CodeRabbit (PR #2, outside-diff), read against the code

`BatchProcessor.process()` no longer resets `shouldStop` (2026-10-05, `5b015e9`), so a Stop accepted while `seedWatchPage` runs now prevents every video from being processed. But `seedWatchPage` itself (`translation-manager.mjs`, the navigation wait and the readiness probe loop, up to roughly 45s) never checks `_batchCancelled`, so the batch stays non-terminal until the seed finishes on its own. Fix: make both waits cancellation-aware and return early; add a test beside the Stop-during-seed case in `test/seed-translate.test.mjs` that fails if the seed keeps waiting.

---

### #25 — Tier 3: both `getInfo` calls failing skips the independent direct `/player` retries

**Status: OPEN** · low (Tier 3 has no recorded real success) · from CodeRabbit (PR #2, outside-diff); the premise verified in `tier3-worker.mjs`

When the iOS and WEB `getInfo` calls both reject, `fetchTier3Transcript` does `throw e2` before the three-attempt direct `/player` loop, which does not use `info`. A direct response that carries caption tracks therefore cannot rescue the transcript. Fix: keep the error instead of throwing, make the `info.captions…` reads null-safe, run the direct loop, and rethrow the kept error only if no tracks are found — and never call `info.getTranscript()` without an `info`. Add a test (the tier3 worker is currently only exercised through `mock.module`).

---

### #26 — release rail: historical tags had drifted from their built code

**Status: FIXED** (2026-10-07) · high (release integrity) · found while answering "what is the proper workflow"

Every GitHub release before 2026-10-07 pointed its tag at a commit that did not carry the version the release was named for. `v1.1.4` was tagged at the PR #1 merge (`164162b`, manifest `1.1.2`); `v1.1.0` at `b9d3692` (manifest `1.0.2`). `v1.0.0`'s draft asset had been silently repointed to `1.1.2` code by a stray June dispatch (asset `updated_at` = the June upload), and a duplicate draft held a second copy of `v1.0.1`. Mechanism: `build-release.yml` took a free-text `version` input and hardcoded `target_commitish: main`, while the version bump lived only on `playlist-download` — so the tag landed on main's head while the zip was built from the branch. Fix: the rail (`release.yml`) derives everything from the repo (no free-text inputs, refuses non-main dispatches, tag at `${{ github.sha }}`); history repaired in place — tags `v1.1.0`/`v1.1.4` moved to their asset-build commits, `v1.0.0` published with a rebuilt-from-source asset, duplicate draft deleted, every release given a body, missing `v1.0.0`/`v1.1.0` tags created. Pinned by `test/release-rail.test.mjs`.

---

### #27 — build scripts were invisible to CI and broke silently on two major bumps

**Status: FIXED** (2026-10-07) · medium · found while merging the Dependabot dev-deps group

`npm test` + `npm run build` never touch `scripts/zip.cjs` or `scripts/pack.cjs`, so the dev-deps PR passed CI while both scripts were broken: `zip-a-folder` 7 pulls a native `@napi-rs/lzma` binding that hits the known npm optional-deps install bug (npm/cli#4828 — "Cannot find native binding") and `node-rsa` 2.0 moved its constructor to a named export (`NodeRSA is not a constructor`). `npm run zip` feeds `release.yml`'s store upload, so a native binding there is a release hazard. Fix: `zip.cjs` rewritten on `fflate` (pure JS, already a runtime dependency; all manifest-referenced entries asserted present) and `zip-a-folder` dropped; `pack.cjs` uses `const { NodeRSA } = require('node-rsa')` and packed a valid `.crx` locally. Follow-up worth doing: make CI run `npm run zip` and assert the archive contains every manifest reference.

# Next

_Updated 2026-09-29 — branch playlist-download_

## State
Architecture + test-suite review done (3 parallel reviewers, load-bearing
claims re-verified by execution). Its top finding is fixed: the dead
embed-iframe tier's global side effects are gone — DNR rules 4/5 (stripped
XFO/CSP for every tab), the sniffer's `all_frames` iframe mute/caption block
and its `window.parent` relay, plus the tier's method and content handler.
Pinned by `test/manifest-hygiene.test.mjs` (mutation-killed). Unit 59/59,
build clean. Real-browser check (headless, 6-video playlist): sniffer loads
top-frame-only, Tier 1.7 arms and reports tracklists correctly (0 tracks
for the 2 captionless videos, 1 `ru/asr` for the 4 captioned), fast-abort
fires — but caption bodies still failed (0/6, the ISSUES #1 condition), so
end-to-end capture was NOT re-verified after this change; it needs a run on a
day the network cooperates (headed). Remaining review findings are registered in `docs/ISSUES.md`
#3-#15 (14 open, 1 fixed) — that file, not this one, is the backlog.
`docs/ISSUES.md` #1 was also downgraded from "isolated" to "narrowed".

## Open threads
- Recommended order from the review: (1) done; (2) CI `npm test` job on Node
  >= 22.3 + `engines` (#9); (3) pass `translate` into Tier 1.7/2C or stop
  labelling their results translated (#3) and fix Tier 3's `{start,end}`
  shape (#4); (4) one shared `parseTimedText` + one formatter module, both
  unit-tested, delete the copies (#8); (5) timeouts on the bare fetches (#5)
  and an error status for ZIP loss (#6).
- Cheap hardening now unblocked by #2: require `event.source === window` for
  `YTSUB_CAPTURED_*` in content.js (#10). Needs a real-browser e2e pass.
- #1 experiment (headless vs headed): N>=3 per variant, flags / UA /
  both separated, in-page assertions that the manipulation took effect,
  env-gated in `e2e/fixtures.mjs`. Candidate the review added: the
  `HeadlessChrome` UA token.

## Running / unfinished
Nothing running. Reload the unpacked extension before any manual run — the
manifest and `rules.json` changed, so a stale loaded copy still has the old
DNR rules and the `all_frames` sniffer.

## Don't redo
- Tier 1.6 (embed iframe) is deleted, not disabled — don't resurrect it
  without re-adding scoped rules; `test/manifest-hygiene.test.mjs` will
  fail on any CSP/XFO-stripping rule or `all_frames:true`.
- The "popup SRT crashes on NaN" claim is false in practice
  (`handleGetTranscript` normalizes first); the real bug is ISSUES #4.
- The reviewer's ISOLATED->MAIN `postMessage` claim is UNCONFIRMED and
  contradicts the 2026-09-20 wall entry; don't edit that entry unprobed.
- Untracked `.psd`/analysis files in the repo root are not this work's;
  `YOUTUBE_POTOKEN_TRIALS.md` and `*oauth*.json` must never be committed.
- Tier 1.7 fast-abort window is a floor from arm (t0); a batch's success
  count is not a proxy for tier-logic correctness (swings 0/6 to 4/6).

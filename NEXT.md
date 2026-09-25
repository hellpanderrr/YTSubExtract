# Next

_Updated 2026-09-25 — branch playlist-download_

## State
Version 1.1.4. Stop-button + click-time tab pin shipped and triple-reviewed
(own adversarial subagent → DS via /adv → full-source adversarial review);
the review's fix-first set is IN: unified `_pageLegLock` (kills the 1.7-vs-2C
cross-lock race), conditional ZIP clears (tri-state `recoverStoppedZip`),
staleness guard covers missing `updatedAt`, 2C fast-abort re-routed to a
MAIN-world `chrome.scripting` probe (the ISOLATED read was dead code), cold
tier stop-checkpoints, re-pin after pin death, unused `google.com` host
permission removed. `npm test` = 19/19 (each new guard mutation-verified);
smoke 3 passed. CLAUDE.md lock docs synced.

## Open threads
- **Circuit breaker**: after K consecutive full-chain failures, shorten
  timeouts for the rest of the batch. Never designed, just proposed.
- **Attestation findings UNSUPPORTED**: H1/H2, steal status, lock-race theory
  were derived from stale-build runs — treat as open. Proposed guard: e2e
  asserting the `[Tier 1.7 Player Coercion]` log line appears per video.
- **e2e stop+pin spec** (the two original complaints as assertions): two tabs,
  batch runs, switch tabs → other tab untouched; Stop mid-batch → terminal
  status + restored tab. Unit tests cover the background half; popup half has
  no harness at all (jsdom or e2e — not started).

## Review backlog (full-source review 2026-09-25, non-blocking)
- **#5** Tier 3-native treats `[]` as success and caches it — single-video
  poisoned cache until Reset (batch path is safe). Needs a product call:
  "no captions" vs error. `translation-manager.mjs` ~:1691/:1730.
- **#7** TabNav leaks a poll interval if the document completes twice within
  one 2C window (`setTimeout(startPolling, 3000)` untracked) — message spam
  keeps the MV3 SW alive. Track the pending timeout in `cleanup`.
- **#10** Duplicate `clearCache`: the empty-arg version at the class end
  shadows the per-video one — popup Reset clears the ENTIRE cache including
  `playlist:*`. Remove the dead/shadowing method.
- **#11** `onProgress` read-then-write can transiently flip `stopping` →
  `running` (self-healing at the terminal write; UI-only).
- **#12** Raw `fetch` without AbortController in `tier3-worker.mjs` (~:177,
  :226, :330) and `youtube-caption-extractor.js` (~:457, :732, :613) — a
  stalled socket hangs a tier for minutes while the heartbeat keeps the UI
  fresh. Copy the `fetchInnerTube` 10s pattern.
- **#13** Docs drift: CLAUDE.md's "DNR rule 4 (iOS UA spoof on timedtext)"
  does not exist in `rules.json`; single-video tier table lists 1.7/2C/Auth
  for `extractWithTranslation` (batch-only in code).

## Running / unfinished
- 4+ commits ready locally for push (review-fix series + this fix pass).
- Golden profile holds the working login (gitignored).
- User reloads the extension from fresh `dist/` after each build (stale-build
  lesson); remind them when shipping code for user-side runs.

## Don't redo
- **Never `git checkout -- <file>` to undo a mutation** while that file has
  uncommitted work — it wiped this session's edits TWICE. Commit first, or
  reverse mutations with an exact-string script.
- **Rebuild + reload before ANY batch diagnosis** — check `dist/` mtimes vs
  HEAD, grep bundle for tier markers. A whole saga was a stale bundle.
- **Never inject `<script>` from ISOLATED, never cross-world postMessage** —
  document_start MAIN script or `chrome.scripting` (`scripting` perm added).
- **A raced 0-tracks never gates other tiers**; settled (videoId match × 2
  polls) only short-circuits its own wait. Auth always runs (0.7s).
- **Never CLEAR_DOWNLOAD_PROGRESS after a failed ZIP delivery** — the record
  is the only pointer to the parked ZIP.
- **Track truth = `getPlayerResponse`, not `getOption`**; seed pinned to batch
  video + `autoplay=0`; no cookie copies; proxy must be up.
- Full history in `docs/LESSONS.md`.

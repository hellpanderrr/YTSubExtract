// fetch() with a hard deadline covering BOTH the response headers and the
// body read — the pattern fetchInnerTube (youtube-caption-extractor.js) has
// always used, generalized for the raw fetches that had no timeout (#12).
// A stalled socket used to pin a tier while the popup heartbeat kept showing
// `running`, so a batch could look hung for minutes until the network stack
// gave up. AbortError propagates like any error: each caller's existing
// catch/retry treats it as a failed attempt.
//
// Returns { ok, status, text } — callers keep their own HTTP-status checks
// and do any JSON.parse on `text` locally, exactly as with the raw fetch.
// The body is read only on ok (error bodies were never consumed by the
// original call sites); on !ok `text` is ''. The timeout still covers the
// whole body read when one happens.

export const DEFAULT_FETCH_TIMEOUT_MS = 10000;

export async function fetchTextWithTimeout(
  url,
  init = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      return { ok: false, status: response.status, text: '' };
    }
    // Read the body inside the try: the signal stays wired to the body
    // stream, so a stalled read is aborted by the same deadline.
    const text = await response.text();
    return { ok: true, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// Same deadline, but returns the raw Response for callers that must read the
// body themselves (youtubei.js calls .json()/.text() on it and checks .ok —
// the {ok,status,text} shape above would break it). Used by the Innertube
// fetch passthrough in tier3-worker.mjs (#12 residual): a stalled socket here
// pins Tier 3 — a batch tier, demoted behind Tier 1 2026-09-27 — behind a
// fresh-looking `running` heartbeat.
//
// The timer is deliberately NOT cleared when headers arrive: the body read
// happens after this function returns, and it must stay covered by the same
// deadline (clearing at header-arrival re-opens exactly the body-stall hole).
// On the success path the timer is allowed to fire later — abort() on a
// settled fetch whose body was already consumed is a spec no-op — and the
// signal keeps guarding an unconsumed body until then. Only the rejection
// path clears it (nothing left to guard).
export function fetchResponseWithTimeout(
  input,
  init = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  return fetch(input, { ...init, signal }).catch((err) => {
    clearTimeout(timer);
    throw err;
  });
}

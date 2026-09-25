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

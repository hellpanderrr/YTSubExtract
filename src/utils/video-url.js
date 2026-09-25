/**
 * Pure YouTube URL helpers — no chrome/DOM imports, so they are unit-testable
 * (test/video-url.test.mjs).
 *
 * Replaces the popup's old `hostname.includes('youtube.com') && ?v=` check,
 * which missed /live/, /shorts/, /embed/ and youtu.be URLs (reported 2026-09-25:
 * live stream pages fell through to "Not a YouTube video or playlist page")
 * and matched spoofable hosts like `evilyoutube.com`.
 */

/** Canonical YouTube video IDs: 11 chars of [A-Za-z0-9_-]. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Path shapes that carry the ID in the path instead of ?v=. */
const PATH_ID_RE = /^\/(?:live|shorts|embed|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/;

/**
 * Strict YouTube host check (dot-boundary, so `evilyoutube.com` and
 * `youtube.com.evil.tld` are rejected).
 * @param {string} hostname
 * @returns {boolean}
 */
export function isYouTubeHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return (
    h === 'youtube.com' ||
    h.endsWith('.youtube.com') ||
    h === 'youtu.be' ||
    h.endsWith('.youtu.be') ||
    h === 'youtube-nocookie.com' ||
    h.endsWith('.youtube-nocookie.com')
  );
}

/**
 * Extract a video ID from any common YouTube URL shape:
 *   ?v=…, /live/…, /shorts/…, /embed/…, /v/…, youtu.be/…
 * @param {string} rawUrl
 * @returns {string|null} the 11-char ID, or null if this isn't a video URL.
 */
export function extractVideoId(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isYouTubeHost(u.hostname)) return null;

  const v = u.searchParams.get('v');
  if (v && VIDEO_ID_RE.test(v)) return v;

  if (u.hostname === 'youtu.be') {
    const seg = u.pathname.split('/').filter(Boolean)[0];
    if (seg && VIDEO_ID_RE.test(seg)) return seg;
  }

  const m = u.pathname.match(PATH_ID_RE);
  if (m) return m[1];

  return null;
}

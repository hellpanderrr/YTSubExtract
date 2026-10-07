/**
 * extractVideoId / isYouTubeHost — pure URL detection used by popup init.
 *
 * Covers the 2026-09-25 report: live stream pages (youtube.com/live/ID)
 * were rejected with "Not a YouTube video or playlist page".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractVideoId, isYouTubeHost } from '../src/utils/video-url.js';

const ID = 'dQw4w9WgXcQ';

test('extractVideoId: ?v= watch URLs', () => {
  assert.equal(extractVideoId(`https://www.youtube.com/watch?v=${ID}`), ID);
  assert.equal(extractVideoId(`https://youtube.com/watch?v=${ID}&list=PLxx`), ID);
  assert.equal(extractVideoId(`https://m.youtube.com/watch?v=${ID}&t=42`), ID);
  assert.equal(extractVideoId(`http://www.youtube.com/watch?v=${ID}`), ID);
});

test('extractVideoId: path-style IDs (live, shorts, embed, v) — the reported live bug', () => {
  assert.equal(extractVideoId(`https://www.youtube.com/live/${ID}`), ID);
  assert.equal(extractVideoId(`https://www.youtube.com/live/${ID}?feature=share`), ID);
  assert.equal(extractVideoId(`https://www.youtube.com/shorts/${ID}`), ID);
  assert.equal(extractVideoId(`https://www.youtube.com/embed/${ID}`), ID);
  assert.equal(extractVideoId(`https://www.youtube.com/v/${ID}`), ID);
  assert.equal(extractVideoId(`https://www.youtube-nocookie.com/embed/${ID}`), ID);
});

test('extractVideoId: youtu.be short links', () => {
  assert.equal(extractVideoId(`https://youtu.be/${ID}`), ID);
  assert.equal(extractVideoId(`https://youtu.be/${ID}?si=abc123&t=10`), ID);
});

test('extractVideoId: returns null for non-video YouTube pages', () => {
  assert.equal(extractVideoId('https://www.youtube.com/'), null);
  assert.equal(extractVideoId('https://www.youtube.com/feed/subscriptions'), null);
  assert.equal(extractVideoId('https://www.youtube.com/@somechannel'), null);
  assert.equal(extractVideoId('https://www.youtube.com/@somechannel/live'), null); // no ID in URL → MAIN probe
  assert.equal(extractVideoId('https://www.youtube.com/playlist?list=PLxx'), null);
  assert.equal(extractVideoId('https://www.youtube.com/results?search_query=cats'), null);
});

test('extractVideoId: rejects spoofed and malformed hosts/IDs', () => {
  // Strict dot-boundary host check — the old `hostname.includes('youtube.com')`
  // accepted these.
  assert.equal(extractVideoId(`https://evilyoutube.com/watch?v=${ID}`), null);
  assert.equal(extractVideoId(`https://youtube.com.evil.tld/watch?v=${ID}`), null);
  assert.equal(extractVideoId(`https://notyoutube.com/watch?v=${ID}`), null);
  assert.equal(extractVideoId('file:///watch?v=dQw4w9WgXcQ'), null);
  // Wrong-length IDs are not canonical 11-char video IDs.
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=short'), null);
  assert.equal(extractVideoId('https://www.youtube.com/watch?v='), null);
  assert.equal(extractVideoId('https://www.youtube.com/live/notanid'), null);
  // Invalid input types / garbage
  assert.equal(extractVideoId('not a url'), null);
  assert.equal(extractVideoId(''), null);
  assert.equal(extractVideoId(undefined), null);
});

test('isYouTubeHost: accepts real hosts, rejects look-alikes', () => {
  for (const h of ['youtube.com', 'www.youtube.com', 'm.youtube.com',
                   'music.youtube.com', 'youtu.be', 'www.youtu.be',
                   'youtube-nocookie.com', 'www.youtube-nocookie.com']) {
    assert.equal(isYouTubeHost(h), true, `should accept ${h}`);
  }
  for (const h of ['evilyoutube.com', 'youtube.com.evil.tld', 'notyoutube.com',
                   'example.com', '', null, undefined]) {
    assert.equal(isYouTubeHost(h), false, `should reject ${h}`);
  }
});

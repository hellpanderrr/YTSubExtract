import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTranscriptViaAndroid } from '../src/utils/youtube-caption-extractor.js';

// Tier 0's /get_transcript path has no translation parameter: it returns the
// track's own language. A translated request must therefore take the
// timedtext fallback (which appends &tlang=) instead, or the caller gets
// untranslated text labelled as translated.

const realFetch = globalThis.fetch;
let calls;

const playerResponse = {
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          languageCode: 'en',
          baseUrl: 'https://www.youtube.com/api/timedtext?v=vid&lang=en',
          getTranscriptEndpoint: { params: 'PARAMS' },
        },
      ],
    },
  },
};
const json3 = JSON.stringify({
  events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello' }] }],
});

beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/youtubei/v1/player')) return new Response(JSON.stringify(playerResponse), { status: 200 });
    if (u.includes('/youtubei/v1/get_transcript')) return new Response('{}', { status: 200 });
    if (u.includes('/api/timedtext')) return new Response(json3, { status: 200 });
    throw new Error(`unexpected fetch: ${u}`);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const getTranscriptCalls = () => calls.filter((u) => u.includes('/get_transcript'));
const timedtextCalls = () => calls.filter((u) => u.includes('/api/timedtext'));

test('a translated request never uses /get_transcript and asks timedtext for &tlang=', async () => {
  const result = await getTranscriptViaAndroid('vid', 'auto', { translate: true, translateLang: 'ru' });

  assert.equal(getTranscriptCalls().length, 0, '/get_transcript cannot translate');
  assert.equal(timedtextCalls().length, 1);
  assert.match(timedtextCalls()[0], /[?&]tlang=ru(&|$)/);
  assert.equal(result.source, 'android-bypass-timedtext');
  assert.equal(result.segments[0].text, 'hello');
});

test('without translation the /get_transcript params path is still tried first', async () => {
  const result = await getTranscriptViaAndroid('vid', 'auto', {});

  assert.equal(getTranscriptCalls().length, 1, 'control: the params path must remain the first attempt');
  // The faked /get_transcript body is empty, so it falls through to timedtext.
  assert.equal(timedtextCalls().length, 1);
  assert.doesNotMatch(timedtextCalls()[0], /tlang=/);
  assert.equal(result.source, 'android-bypass-timedtext');
});

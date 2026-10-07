import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylistVideos } from '../src/utils/playlist-extractor.js';

const item = (id) => ({
  playlistVideoRenderer: { videoId: id, title: { runs: [{ text: `title ${id}` }] } },
});

const ids = (videos) => videos.map((v) => v.videoId);

// A normal first page: videos live under twoColumn tabs -> sectionList ->
// itemSection -> playlistVideoListRenderer.
const firstPage = (...videoIds) => ({
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    itemSectionRenderer: {
                      contents: [{ playlistVideoListRenderer: { contents: videoIds.map(item) } }],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
});

// A continuation page (page 2+): no `contents`, videos arrive via
// onResponseReceivedActions.
const continuationPage = (...videoIds) => ({
  onResponseReceivedActions: [
    { appendContinuationItemsAction: { continuationItems: videoIds.map(item) } },
  ],
});

test('a continuation page returns each video exactly once, in order', () => {
  // Regression: an extra push in the no-sidebar branch returned every
  // continuation video twice ([A,B,C,A,B,C]).
  const out = parsePlaylistVideos(continuationPage('AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'));
  assert.deepEqual(ids(out), ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC']);
});

test('a normal first page still returns its videos once', () => {
  const out = parsePlaylistVideos(firstPage('AAAAAAAAAAA', 'BBBBBBBBBBB'));
  assert.deepEqual(ids(out), ['AAAAAAAAAAA', 'BBBBBBBBBBB']);
});

test('a first page contributes no phantom continuation videos', () => {
  assert.equal(parsePlaylistVideos(firstPage('AAAAAAAAAAA')).length, 1);
});

test('multiple continuation actions are all collected, still without duplicates', () => {
  const data = {
    onResponseReceivedActions: [
      { appendContinuationItemsAction: { continuationItems: [item('AAAAAAAAAAA')] } },
      { appendContinuationItemsAction: { continuationItems: [item('BBBBBBBBBBB'), item('CCCCCCCCCCC')] } },
    ],
  };
  assert.deepEqual(ids(parsePlaylistVideos(data)), ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC']);
});

test('a top-level alert surfaces as a "Playlist unavailable" error', () => {
  const data = { alerts: [{ alertRenderer: { text: { simpleText: 'The playlist does not exist.' } } }] };
  assert.throws(() => parsePlaylistVideos(data), /Playlist unavailable: The playlist does not exist/);
});

test('empty or unrecognised responses yield an empty list, never a throw', () => {
  assert.deepEqual(parsePlaylistVideos({}), []);
  assert.deepEqual(parsePlaylistVideos(null), []);
  assert.deepEqual(parsePlaylistVideos({ contents: { somethingElse: {} } }), []);
});

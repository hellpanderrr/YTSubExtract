// Unit tests for src/utils/fetch-timeout.js (#12).
// Raw fetches without AbortController let a stalled socket pin a tier while
// the 15s heartbeat keeps the popup fresh-`running` — a batch can look hung
// for minutes. The helper covers BOTH the header wait and the body read
// under one deadline (the fetchInnerTube pattern, generalized).
// Callers keep their own ok-handling and do any JSON.parse locally, exactly
// as the raw fetches did.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTextWithTimeout } from '../src/utils/fetch-timeout.js';

const withFetchStub = async (stub, fn) => {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
};

/** A fetch that never settles until its signal aborts (stalled socket). */
const hangingFetch = () => (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    );
  });

test(
  'stalled response headers abort at timeoutMs',
  { timeout: 5000 },
  async () => {
    await withFetchStub(hangingFetch(), async () => {
      const t0 = Date.now();
      await assert.rejects(
        () => fetchTextWithTimeout('https://example.test/x', {}, 25),
        (err) => err.name === 'AbortError'
      );
      assert.ok(Date.now() - t0 < 2000, 'rejected promptly, not after a default hang');
    });
  }
);

test(
  'stalled body read aborts under the same deadline',
  { timeout: 5000 },
  async () => {
    // Headers arrive instantly; the body stream never delivers. The timer
    // must stay armed until the body read finishes (mutation: clear it after
    // the header wait → this test times out and fails).
    await withFetchStub(
      (_url, init) =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener('abort', () =>
                reject(new DOMException('The operation was aborted.', 'AbortError'))
              );
            }),
        }),
      async () => {
        const t0 = Date.now();
        await assert.rejects(
          () => fetchTextWithTimeout('https://example.test/x', {}, 25),
          (err) => err.name === 'AbortError'
        );
        assert.ok(Date.now() - t0 < 2000, 'body stall aborted promptly');
      }
    );
  }
);

test('success path returns ok/status and the body', async () => {
  await withFetchStub(
    async () => ({
      ok: true,
      status: 200,
      text: async () => 'caption-xml',
    }),
    async () => {
      const res = await fetchTextWithTimeout('https://example.test/x');
      assert.equal(res.ok, true);
      assert.equal(res.status, 200);
      assert.equal(res.text, 'caption-xml');
    }
  );
});

test('HTTP error status is surfaced without consuming the body', async () => {
  let bodyRead = false;
  await withFetchStub(
    async () => ({
      ok: false,
      status: 403,
      text: async () => {
        bodyRead = true;
        return 'denied';
      },
    }),
    async () => {
      const res = await fetchTextWithTimeout('https://example.test/x');
      assert.equal(res.ok, false);
      assert.equal(res.status, 403);
      assert.equal(res.text, '', 'error bodies are never consumed (raw-fetch parity)');
      assert.equal(bodyRead, false, 'text() must not be called on !ok');
    }
  );
});

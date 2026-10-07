// Unit tests for src/utils/stable-read.js (Tier 0.5 partial-count harden).
//
// The one-shot DOM read accepted any partial count > 0 as complete — a slow
// hydration yielded a silently short playlist. readUntilStable re-reads until
// two consecutive counts agree, bounded by maxReads. sleep is injected so the
// tests need no fake timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUntilStable } from '../src/utils/stable-read.js';

/** read() over a scripted sequence of snapshots; records call order. */
const scriptedRead = (snapshots) => {
  let i = 0;
  const read = async () => snapshots[Math.min(i++, snapshots.length - 1)];
  return { read, calls: () => i };
};

/** sleep stub that records requested delays and resolves immediately. */
const recordingSleep = () => {
  const delays = [];
  return { delays, sleep: async (ms) => void delays.push(ms) };
};

test('stable on second read → returns it after exactly one sleep', async () => {
  const a = ['v1', 'v2', 'v3', 'v4', 'v5'];
  const b = ['x1', 'x2', 'x3', 'x4', 'x5']; // same count, new array
  const { read, calls } = scriptedRead([a, b]);
  const { delays, sleep } = recordingSleep();

  const out = await readUntilStable(read, { sleep });

  assert.equal(out, b, 'must return the SECOND read, not the first');
  assert.equal(calls(), 2);
  assert.deepEqual(delays, [400]);
});

test('grows then stabilizes (3,5,5) → returns 5', async () => {
  const s1 = ['a', 'b', 'c'];
  const s2 = ['a', 'b', 'c', 'd', 'e'];
  const s3 = ['a', 'b', 'c', 'd', 'e'];
  const { read, calls } = scriptedRead([s1, s2, s3]);
  const { delays, sleep } = recordingSleep();

  const out = await readUntilStable(read, { sleep });

  // Mutation: accept the first read → returns s1 (length 3) and fails here.
  assert.equal(out, s3, 'must keep re-reading until two counts agree');
  assert.equal(out.length, 5);
  assert.equal(calls(), 3);
  assert.equal(delays.length, 2);
});

test('never stabilizes → returns the last read after maxReads reads', async () => {
  const snaps = [['a'], ['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd', 'e']];
  const { read, calls } = scriptedRead(snaps);
  const { delays, sleep } = recordingSleep();

  const out = await readUntilStable(read, { sleep, maxReads: 4 });

  assert.equal(calls(), 4, 'bounded by maxReads — no runaway polling');
  assert.equal(out, snaps[3], 'freshest snapshot at the bound');
  assert.equal(delays.length, 3, 'maxReads reads = maxReads-1 sleeps');
});

test('empty first read → returned immediately with zero sleeps', async () => {
  const { read, calls } = scriptedRead([[]]);
  const { delays, sleep } = recordingSleep();

  const out = await readUntilStable(read, { sleep });

  assert.deepEqual(out, []);
  assert.equal(calls(), 1, 'must not poll an empty snapshot — fallbacks own that case');
  assert.deepEqual(delays, []);
});

test('mid-loop empty snapshot counts as changed, not as done', async () => {
  const full = ['a', 'b', 'c'];
  const empty = [];
  const { read, calls } = scriptedRead([full, empty, empty]);
  const { delays, sleep } = recordingSleep();

  const out = await readUntilStable(read, { sleep, maxReads: 3 });

  assert.equal(calls(), 3, 'a 0-after-N read must not count as stable-N');
  assert.equal(out, empty);
  assert.equal(delays.length, 2);
});

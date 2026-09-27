import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFastAbort } from '../src/utils/fast-abort.js';

// A fake clock where `sleep(ms)` advances the same clock `now()` reads —
// models real elapsed-time behavior deterministically, no real delay.
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

test('fires when tracklist is still confirmed-zero once the window closes', async () => {
  const clock = makeClock(1200); // matches observed captionless zero-report time
  const result = await runFastAbort({
    armedAt: 1200,
    windowMs: 10000,
    getTracklistCount: () => 0,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.deepEqual(result, { fire: true, elapsedMs: 10000 });
});

test('does not fire if a non-zero tracklist arrives before the window closes', async () => {
  const clock = makeClock(1200);
  const result = await runFastAbort({
    armedAt: 1200,
    windowMs: 10000,
    getTracklistCount: () => 3, // overridden by the time the check runs
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(result.fire, false);
});

test('skips waiting (no negative sleep) if armed after the window already elapsed', async () => {
  const clock = makeClock(15000);
  let sleptFor = null;
  const result = await runFastAbort({
    armedAt: 5000,
    windowMs: 10000,
    getTracklistCount: () => 0,
    now: clock.now,
    sleep: (ms) => {
      sleptFor = ms;
      return clock.sleep(ms);
    },
  });
  assert.equal(sleptFor, null);
  assert.deepEqual(result, { fire: true, elapsedMs: 10000 });
});

test('waits exactly the remaining window, not the full window, when armed late', async () => {
  const clock = makeClock(4000); // zero reported 4s after arm (armedAt=0)
  const result = await runFastAbort({
    armedAt: 0,
    windowMs: 10000,
    getTracklistCount: () => 0,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.deepEqual(result, { fire: true, elapsedMs: 10000 });
});

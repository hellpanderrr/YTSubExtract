import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  intEnv,
  evaluate,
  runPasses,
  decideAction,
  buildReport,
  FAILURES_BEFORE_ISSUE,
} from '../scripts/weekly-canary.mjs';

test('intEnv: unset and empty (an unset ${{ vars.X }}) fall back to the default', () => {
  assert.equal(intEnv({}, 'N', 6), 6);
  assert.equal(intEnv({ N: '' }, 'N', 6), 6);
});

test('intEnv: an explicit 0 is respected, not treated as "absent"', () => {
  assert.equal(intEnv({ N: '0' }, 'N', 6), 0);
});

test('intEnv: parses integers and rejects junk loudly', () => {
  assert.equal(intEnv({ N: '12' }, 'N', 6), 12);
  assert.throws(() => intEnv({ N: 'abc' }, 'N', 6), /must be an integer/);
  assert.throws(() => intEnv({ N: '5x' }, 'N', 6), /must be an integer/);
});

test('evaluate: the threshold is inclusive', () => {
  assert.equal(evaluate({ subtitles: 3, selected: 6 }, 3).ok, true);
  assert.equal(evaluate({ subtitles: 2, selected: 6 }, 3).ok, false);
  assert.equal(evaluate({ subtitles: 4, selected: 6 }, 3).ok, true);
});

test('evaluate: a missing or malformed result is a failure, never a pass', () => {
  assert.equal(evaluate(null, 0).ok, false);
  assert.equal(evaluate({}, 0).ok, false);
  assert.equal(evaluate({ subtitles: '4' }, 3).ok, false);
});

test('runPasses: one clearing attempt is a pass; none (or no attempts) is not', () => {
  assert.equal(runPasses([{ ok: false }, { ok: false }, { ok: true }]), true);
  assert.equal(runPasses([{ ok: false }, { ok: false }]), false);
  assert.equal(runPasses([]), false);
});

test('decideAction: a passing run with no open issue does nothing and resets the streak', () => {
  assert.deepEqual(decideAction({ passed: true, consecutiveFailures: 1, openIssue: null }), {
    action: 'none',
    consecutiveFailures: 0,
  });
});

test('decideAction: the FIRST failing run is quiet', () => {
  assert.deepEqual(decideAction({ passed: false, consecutiveFailures: 0, openIssue: null }), {
    action: 'none',
    consecutiveFailures: 1,
  });
});

test('decideAction: the second consecutive failure opens exactly one issue', () => {
  assert.equal(FAILURES_BEFORE_ISSUE, 2);
  assert.deepEqual(decideAction({ passed: false, consecutiveFailures: 1, openIssue: null }), {
    action: 'open-issue',
    consecutiveFailures: 2,
  });
});

test('decideAction: while an issue is open, failures comment on it instead of duplicating', () => {
  assert.deepEqual(decideAction({ passed: false, consecutiveFailures: 5, openIssue: 42 }), {
    action: 'comment-issue',
    consecutiveFailures: 6,
  });
  // A human-opened issue with a lost local counter still gets a comment, not a duplicate.
  assert.equal(decideAction({ passed: false, consecutiveFailures: 0, openIssue: 7 }).action, 'comment-issue');
});

test('decideAction: a passing run closes the open issue', () => {
  assert.deepEqual(decideAction({ passed: true, consecutiveFailures: 3, openIssue: 42 }), {
    action: 'close-issue',
    consecutiveFailures: 0,
  });
});

test('buildReport: carries counts, threshold, run link and the variance caveat', () => {
  const body = buildReport({
    playlistUrl: 'https://www.youtube.com/playlist?list=PLx',
    minOk: 3,
    evals: [
      { ok: false, subtitles: 0, selected: 6, reason: '0 subtitles < threshold 3', exitCode: 0 },
      { ok: false, subtitles: 2, selected: 6, reason: '2 subtitles < threshold 3', exitCode: 0 },
    ],
    runUrl: 'https://github.com/o/r/actions/runs/1',
    consecutiveFailures: 2,
  });
  assert.match(body, /FAILING/);
  assert.match(body, /threshold 3/);
  assert.match(body, /0\/6/);
  assert.match(body, /2\/6/);
  assert.match(body, /actions\/runs\/1/);
  assert.match(body, /ISSUES\.md #1/);
});

test('buildReport: reads "passing" when any attempt cleared the threshold', () => {
  const body = buildReport({
    playlistUrl: 'p',
    minOk: 3,
    evals: [
      { ok: false, subtitles: 0, selected: 6, reason: 'x' },
      { ok: true, subtitles: 4, selected: 6, reason: 'ok' },
    ],
    runUrl: null,
    consecutiveFailures: 0,
  });
  assert.match(body, /passing/);
  assert.doesNotMatch(body, /FAILING/);
});

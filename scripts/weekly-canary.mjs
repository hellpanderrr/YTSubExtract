// Weekly playlist canary. Runs the real e2e batch download (real extension,
// real signed-in Chromium) and reports regressions as ONE GitHub issue.
//
// Designed for a SELF-HOSTED runner (see .github/workflows/weekly-canary.yml):
// a cookie-less API probe is bot-checked by YouTube and a hosted runner has no
// signed-in profile (docs/LESSONS.md 2026-09-30).
//
// Why it is not just "run the spec":
//  - Identical configs swing between 0/6 and 4/6 subtitles (docs/ISSUES.md #1),
//    so the job retries and passes if ANY attempt clears the threshold.
//  - One bad week must not page anyone: an issue opens only after
//    FAILURES_BEFORE_ISSUE consecutive failing runs, is updated (not
//    duplicated) while it stays broken, and is closed when a run passes.
//  - The open-issue lookup asks GitHub (label), not a local file, so losing
//    the state file can delay an issue by a week but never duplicates one.
//
// Flags: --dry-run  print gh WRITE commands instead of running them
//        --from-result <file>  skip the browser; evaluate an existing result
//        (used to test the decision pipeline cheaply)
// Env:   CANARY_PLAYLIST_URL (or E2E_BATCH_URL), CANARY_LIMIT=6,
//        CANARY_MIN_OK=3, CANARY_ATTEMPTS=3, CANARY_HEADLESS=1 (default headed)
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, '.canary-state.json');

export const ISSUE_LABEL = 'weekly-canary';
export const FAILURES_BEFORE_ISSUE = 2;

// Unset AND empty ('' is what an unset ${{ vars.X }} expands to) mean "use the
// default"; anything else must be a real integer.
export function intEnv(env, name, dflt) {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || String(n) !== String(raw).trim()) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  return n;
}

// One attempt's result file vs the success threshold.
export function evaluate(result, minOk) {
  if (!result || typeof result.subtitles !== 'number') {
    return { ok: false, subtitles: 0, selected: result?.selected ?? 0, reason: 'no usable result file' };
  }
  const ok = result.subtitles >= minOk;
  return {
    ok,
    subtitles: result.subtitles,
    selected: result.selected ?? 0,
    reason: ok ? 'ok' : `${result.subtitles} subtitles < threshold ${minOk}`,
  };
}

// Run-to-run variance is large on identical configs, so one clearing attempt
// is a pass.
export function runPasses(evals) {
  return evals.some((e) => e.ok);
}

// consecutiveFailures: failing runs in a row BEFORE this one.
// openIssue: number of an open canary issue, or null.
export function decideAction({ passed, consecutiveFailures, openIssue }) {
  if (passed) {
    return { action: openIssue === null ? 'none' : 'close-issue', consecutiveFailures: 0 };
  }
  const failures = consecutiveFailures + 1;
  if (openIssue !== null) return { action: 'comment-issue', consecutiveFailures: failures };
  if (failures >= FAILURES_BEFORE_ISSUE) return { action: 'open-issue', consecutiveFailures: failures };
  return { action: 'none', consecutiveFailures: failures };
}

export function buildReport({ playlistUrl, minOk, evals, runUrl, consecutiveFailures }) {
  const rows = evals.map(
    (e, i) =>
      `| ${i + 1} | ${e.subtitles}/${e.selected} | ${e.ok ? 'pass' : 'fail'} | ${e.reason} | ${e.exitCode ?? '-'} |`
  );
  return [
    `Weekly playlist canary: **${runPassesLabel(evals)}** (threshold ${minOk} subtitles, ${consecutiveFailures} consecutive failing run(s)).`,
    '',
    `Playlist: ${playlistUrl}`,
    runUrl ? `Run: ${runUrl}` : null,
    '',
    '| attempt | subtitles | result | reason | playwright exit |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    'Caveats: identical configs have swung 0/6 <-> 4/6 (docs/ISSUES.md #1), and ' +
      'a failure can also mean the playlist changed or the profile login expired. ' +
      'Check `e2e/README.md` before assuming the extension regressed.',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

function runPassesLabel(evals) {
  return runPasses(evals) ? 'passing' : 'FAILING';
}

function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function runAttempt(index, cfg) {
  const resultFile = path.join(ROOT, `.canary-result-${index}.json`);
  fs.rmSync(resultFile, { force: true });
  const env = {
    ...process.env,
    E2E_BATCH_URL: cfg.playlistUrl,
    E2E_BATCH_LIMIT: String(cfg.limit),
    E2E_RESULT_FILE: resultFile,
  };
  if (!cfg.headless) env.E2E_HEADED = '1';
  const r = spawnSync('npx', ['playwright', 'test', 'e2e/batch-download.spec.mjs'], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: true,
  });
  return { exitCode: r.status, ...evaluate(readJsonSafe(resultFile), cfg.minOk) };
}

// gh READ: always executed (harmless). Returns null when gh is unavailable so a
// missing CLI degrades to "no open issue" with a warning, never a crash.
function findOpenIssue() {
  try {
    const out = execFileSync(
      'gh',
      ['issue', 'list', '--label', ISSUE_LABEL, '--state', 'open', '--json', 'number', '--limit', '1'],
      { encoding: 'utf8', cwd: ROOT }
    );
    const list = JSON.parse(out);
    return list.length > 0 ? list[0].number : null;
  } catch (e) {
    console.warn(`[canary] could not query GitHub issues (${e.message.split('\n')[0]}); assuming none open`);
    return null;
  }
}

// gh WRITE: skipped under --dry-run.
function gh(args, dryRun) {
  if (dryRun) {
    console.log(`[canary] DRY-RUN gh ${args.join(' ')}`);
    return;
  }
  execFileSync('gh', args, { stdio: 'inherit', cwd: ROOT });
}

function applyAction(decision, openIssue, body, dryRun) {
  const bodyFile = path.join(ROOT, '.canary-body.md');
  fs.writeFileSync(bodyFile, body);
  try {
    if (decision.action === 'open-issue') {
      gh(['label', 'create', ISSUE_LABEL, '--color', 'D93F0B', '--description', 'Weekly playlist canary failure', '--force'], dryRun);
      gh(['issue', 'create', '--title', 'Weekly playlist canary is failing', '--label', ISSUE_LABEL, '--body-file', bodyFile], dryRun);
    } else if (decision.action === 'comment-issue') {
      gh(['issue', 'comment', String(openIssue), '--body-file', bodyFile], dryRun);
    } else if (decision.action === 'close-issue') {
      fs.writeFileSync(bodyFile, `Canary passing again.\n\n${body}`);
      gh(['issue', 'comment', String(openIssue), '--body-file', bodyFile], dryRun);
      gh(['issue', 'close', String(openIssue)], dryRun);
    }
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const fromIdx = argv.indexOf('--from-result');
  const fromResult = fromIdx >= 0 ? argv[fromIdx + 1] : null;
  const env = process.env;

  const cfg = {
    playlistUrl: env.CANARY_PLAYLIST_URL || env.E2E_BATCH_URL || '',
    limit: intEnv(env, 'CANARY_LIMIT', 6),
    minOk: intEnv(env, 'CANARY_MIN_OK', 3),
    attempts: intEnv(env, 'CANARY_ATTEMPTS', 3),
    headless: env.CANARY_HEADLESS === '1',
  };
  if (!fromResult && !cfg.playlistUrl) {
    console.error('[canary] set CANARY_PLAYLIST_URL (or E2E_BATCH_URL)');
    process.exitCode = 2;
    return;
  }

  const evals = [];
  if (fromResult) {
    evals.push({ exitCode: null, ...evaluate(readJsonSafe(fromResult), cfg.minOk) });
  } else {
    for (let i = 1; i <= cfg.attempts; i++) {
      console.log(`[canary] attempt ${i}/${cfg.attempts}`);
      const e = runAttempt(i, cfg);
      evals.push(e);
      console.log(`[canary] attempt ${i}: ${e.subtitles}/${e.selected} -> ${e.ok ? 'pass' : 'fail'} (${e.reason})`);
      if (e.ok) break;
    }
  }

  const passed = runPasses(evals);
  const state = readJsonSafe(STATE_FILE, { consecutiveFailures: 0 });
  const openIssue = findOpenIssue();
  const decision = decideAction({
    passed,
    consecutiveFailures: state.consecutiveFailures ?? 0,
    openIssue,
  });
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null;
  const body = buildReport({
    playlistUrl: cfg.playlistUrl,
    minOk: cfg.minOk,
    evals,
    runUrl,
    consecutiveFailures: decision.consecutiveFailures,
  });

  console.log(`[canary] ${passed ? 'PASSED' : 'FAILED'}; decision=${decision.action}; consecutiveFailures=${decision.consecutiveFailures}; openIssue=${openIssue}`);
  console.log(body);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, body + '\n');

  // Persist the streak BEFORE touching GitHub: a failing gh call (network,
  // expired token) must not lose the failure count.
  if (!dryRun) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ consecutiveFailures: decision.consecutiveFailures }));
  } else {
    console.log(`[canary] DRY-RUN not writing ${path.basename(STATE_FILE)}`);
  }
  let actionFailed = false;
  try {
    applyAction(decision, openIssue, body, dryRun);
  } catch (e) {
    actionFailed = true;
    console.error(`[canary] gh action "${decision.action}" failed: ${e.message.split('\n')[0]}`);
  }
  // A failed issue update makes the job red even when the run itself passed.
  process.exitCode = passed && !actionFailed ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 2;
  });
}

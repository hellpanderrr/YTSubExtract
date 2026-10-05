// Mutation-test the playlist-rows unit tests: each mutation must make the
// suite FAIL. Restores the file in `finally`. Exits non-zero if any mutant
// survives (i.e. the tests do not pin that behaviour).
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const FILE = 'src/utils/playlist-rows.js';
const original = readFileSync(FILE, 'utf8');

const MUTATIONS = [
  {
    name: 'filter: keep everything (identity filter inert)',
    from: "return rows.filter((r) => r && (!r.listId || r.listId === playlistId));",
    to: "return rows.filter((r) => r);",
  },
  {
    name: 'filter: drop untagged rows too (the shortening bug)',
    from: "return rows.filter((r) => r && (!r.listId || r.listId === playlistId));",
    to: "return rows.filter((r) => r && r.listId === playlistId);",
  },
  {
    name: 'sweep: positional first-non-empty (no positive preference)',
    from: "    if (kept.some((r) => r && r.listId === playlistId)) {\n      return { selector, rows: kept, rawCount: raw.length, match: 'tagged' };\n    }\n    if (!fallback) fallback = { selector, rows: kept, rawCount: raw.length, match: 'untagged' };",
    to: "    return { selector, rows: kept, rawCount: raw.length, match: 'tagged' };",
  },
  {
    name: 'pickRowHref: always take the first anchor (no list= preference)',
    from: "    if (extractPlaylistListId(href)) return href;\n    if (!first) first = href;",
    to: "    if (!first) first = href;",
  },
];

const runSuite = () =>
  spawnSync(
    process.execPath,
    ['--test', '--experimental-test-module-mocks', 'test/playlist-rows.test.mjs'],
    { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' }
  );

// Baseline: the unmodified suite must pass, or every mutant would look
// "killed" by a suite that cannot run at all.
const baseline = runSuite();
if (baseline.status !== 0) {
  console.error('BASELINE FAILED: test/playlist-rows.test.mjs does not pass unmodified — aborting.');
  console.error((baseline.stdout || '') + (baseline.stderr || ''));
  process.exit(2);
}

let survived = 0;
for (const m of MUTATIONS) {
  if (!original.includes(m.from)) {
    console.log(`SKIP (anchor not found): ${m.name}`);
    survived++;
    continue;
  }
  writeFileSync(FILE, original.replace(m.from, m.to));
  const r = runSuite();
  const killed = r.status !== 0;
  console.log(`${killed ? 'KILLED' : 'SURVIVED'}: ${m.name}`);
  if (!killed) survived++;
  writeFileSync(FILE, original);
}

writeFileSync(FILE, original);
console.log(survived === 0 ? '\nAll mutants killed.' : `\n${survived} mutant(s) SURVIVED.`);
process.exit(survived === 0 ? 0 : 1);

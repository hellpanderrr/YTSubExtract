import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { whatsNewBlock, readVersion } from '../scripts/release-notes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// The 2026-10-07 release-rail cleanup: four release paths (two of them
// dead) let tag targets, GitHub release bodies and the store upload drift
// apart. These assertions pin the single-version and single-text rules the
// new release.yml / bump-version.mjs depend on.

test('every version copy agrees (manifest, package, lock x2, popup)', () => {
  const manifestV = JSON.parse(read('manifest.json')).version;
  assert.match(manifestV, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(read('package.json')).version, manifestV, 'package.json');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, manifestV, 'package-lock.json root');
  assert.equal(lock.packages[''].version, manifestV, 'package-lock.json packages[""]');
  const popup = read('src/popup/index.html').match(/<span class="version">v(\d+\.\d+\.\d+)<\/span>/);
  assert.ok(popup, 'popup has no version span');
  assert.equal(popup[1], manifestV, 'src/popup/index.html');
  assert.equal(readVersion(), manifestV, 'release-notes.mjs readVersion');
});

test("STORE_DESCRIPTION.md carries a What's New block and it parses", () => {
  const block = whatsNewBlock(read('STORE_DESCRIPTION.md'));
  assert.ok(block, "no What's New block — release.yml would refuse to publish");
  assert.match(block, /^What's New \(\w+ \d{4}\):/);
  assert.ok(block.split('\n').length >= 2, 'block has no bullets');
});

test("whatsNewBlock takes the TOP block when several exist", () => {
  const text = "What's New (October 2026):\n- new\n\nWhat's New (April 2026):\n- old\n";
  assert.equal(whatsNewBlock(text), "What's New (October 2026):\n- new");
});

test('release workflows build on Node 22+ (mock.module floor) and are dispatch-only', () => {
  for (const wf of ['release.yml', 'announce.yml']) {
    const text = read(`.github/workflows/${wf}`);
    const nodes = [...text.matchAll(/node-version:\s*'(\d+)'/g)].map((m) => Number(m[1]));
    assert.ok(nodes.length >= 1, `${wf}: no node-version`);
    for (const n of nodes) assert.ok(n >= 22, `${wf}: Node ${n} < 22`);
    assert.match(text, /workflow_dispatch:/, `${wf} must be manual-only`);
    assert.doesNotMatch(text, /^\s{2}push:/m, `${wf} must not run on every push`);
    assert.doesNotMatch(text, /^\s{2}pull_request:/m, `${wf} must not run on PRs`);
  }
});

test('release.yml derives everything from the repo, not free-text inputs', () => {
  const raw = read('.github/workflows/release.yml');
  // Comments explain the historical bug by name; only live YAML counts.
  const text = raw
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.match(text, /node scripts\/release-notes\.mjs --version/, 'version must come from the script (manifest)');
  assert.match(text, /node scripts\/release-notes\.mjs\b/, 'notes must come from the store description');
  assert.match(text, /tag_name: v\$\{\{ steps\.version\.outputs\.version \}\}/, 'tag must be derived, not typed');
  assert.doesNotMatch(text, /inputs\.version/, 'no free-text version input — that is how tags drifted');
  assert.match(
    text,
    /target_commitish: \$\{\{ github\.sha \}\}/,
    'tag must target THIS run\'s commit — a hardcoded branch is what put v1.1.4 on 1.1.2 code'
  );
  assert.doesNotMatch(text, /target_commitish:\s*(main|master)\b/, 'never target a branch name');
  assert.match(text, /refs\/heads\/main/, 'release.yml must refuse non-main dispatches');
  assert.match(text, /publish: false/, 'the store step must stay draft-only');
});

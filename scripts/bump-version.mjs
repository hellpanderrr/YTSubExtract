/**
 * One-command version bump for every copy of the version string.
 *
 *   node scripts/bump-version.mjs 1.1.6
 *
 * Updates manifest.json, package.json, package-lock.json (both the root and
 * the packages[""] copies) and the popup's version span. Refuses when the
 * copies already disagree — silently normalizing would hide the exact drift
 * this guards (see test/release-rail.test.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const write = (p, t) => fs.writeFileSync(path.join(ROOT, p), t);

const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next || '')) {
  console.error('usage: node scripts/bump-version.mjs X.Y.Z');
  process.exit(1);
}

const manifestPath = 'manifest.json';
const pkgPath = 'package.json';
const lockPath = 'package-lock.json';
const popupPath = 'src/popup/index.html';

const manifestRaw = read(manifestPath);
const pkgRaw = read(pkgPath);
const lockRaw = read(lockPath);
const popupRaw = read(popupPath);

const manifestV = JSON.parse(manifestRaw).version;
const pkgV = JSON.parse(pkgRaw).version;
const lockV = JSON.parse(lockRaw).version;
const lockPkgV = JSON.parse(lockRaw).packages[''].version;
const popupMatch = popupRaw.match(/<span class="version">v(\d+\.\d+\.\d+)<\/span>/);
const popupV = popupMatch ? popupMatch[1] : null;

const copies = [
  [manifestPath, manifestV],
  [pkgPath, pkgV],
  [`${lockPath} (root)`, lockV],
  [`${lockPath} packages[""]`, lockPkgV],
  [popupPath, popupV],
];
if (copies.some(([, v]) => v !== manifestV)) {
  console.error('version copies disagree — fix by hand first:');
  for (const [name, v] of copies) console.error(`  ${name}: ${v}`);
  process.exit(1);
}
if (next === manifestV) {
  console.log(`already at ${next}`);
  process.exit(0);
}
const cmp = (a, b) => {
  const [a1, a2, a3] = a.split('.').map(Number);
  const [b1, b2, b3] = b.split('.').map(Number);
  return (a1 - b1) || (a2 - b2) || (a3 - b3);
};
if (cmp(next, manifestV) <= 0) {
  console.error(`${next} is not greater than ${manifestV} — the store rejects non-increasing versions`);
  process.exit(1);
}

// Targeted replacements keep the files byte-identical outside the version.
const first = (text, from, to) => {
  const i = text.indexOf(from);
  if (i === -1) throw new Error(`marker not found: ${from}`);
  return text.slice(0, i) + to + text.slice(i + from.length);
};
const fromPair = `"version": "${manifestV}"`;
const toPair = `"version": "${next}"`;

const manifestOut = first(manifestRaw, fromPair, toPair);
const pkgOut = first(pkgRaw, fromPair, toPair);

// package-lock.json has two copies: the root one first, then packages[""] which
// is the first occurrence after the "packages" key. Replace the later one
// first so the earlier index stays valid.
const packagesKey = lockRaw.indexOf('"packages": {');
if (packagesKey === -1) throw new Error('package-lock.json: no "packages" block');
const lockRootIdx = lockRaw.indexOf(fromPair);
const lockPkgIdx = lockRaw.indexOf(fromPair, packagesKey);
if (lockRootIdx === -1 || lockPkgIdx === -1) throw new Error('package-lock.json: version copy not found');
let lockOut = lockRaw.slice(0, lockPkgIdx) + toPair + lockRaw.slice(lockPkgIdx + fromPair.length);
lockOut = lockOut.slice(0, lockRootIdx) + toPair + lockOut.slice(lockRootIdx + fromPair.length);

const popupOut = popupRaw.replace(popupMatch[0], `<span class="version">v${next}</span>`);

write(manifestPath, manifestOut);
write(pkgPath, pkgOut);
write(lockPath, lockOut);
write(popupPath, popupOut);
for (const [name] of copies) console.log(`${name}: ${manifestV} -> ${next}`);

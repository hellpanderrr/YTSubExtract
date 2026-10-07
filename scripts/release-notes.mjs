/**
 * Release notes come from ONE place: the top "What's New" block of
 * STORE_DESCRIPTION.md. release.yml uses this for the GitHub Release body
 * (and FAILS when the block is missing — an empty release body is how the
 * pre-2026-10-07 releases rotted), announce.yml for the Discussions post.
 *
 * CLI:
 *   node scripts/release-notes.mjs            # print the top What's New block
 *   node scripts/release-notes.mjs --version  # print manifest.json's version
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Top "What's New (...)" block of the store description, or null. */
export function whatsNewBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith("What's New ("));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("What's New (")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

/** The single source of truth for the version: manifest.json. */
export function readVersion(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  if (process.argv.includes('--version')) {
    console.log(readVersion());
  } else {
    const block = whatsNewBlock(fs.readFileSync(path.join(ROOT, 'STORE_DESCRIPTION.md'), 'utf8'));
    if (!block) {
      console.error("STORE_DESCRIPTION.md has no What's New block — write release notes before releasing");
      process.exit(1);
    }
    console.log(block);
  }
}

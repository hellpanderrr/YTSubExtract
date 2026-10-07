import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));

const manifest = readJson('manifest.json');
const rules = readJson('rules.json');

// Deleted 2026-09-29 (docs/LESSONS.md): the hidden-embed-iframe tier had no
// callers, yet its DNR rules stripped clickjacking protection from youtube.com
// for every tab, and its sniffer block muted + force-captioned every YouTube
// embed on third-party sites. These guards keep that from coming back.

test('no DNR rule strips framing/CSP protection headers', () => {
  const guarded = new Set([
    'x-frame-options',
    'content-security-policy',
    'content-security-policy-report-only',
  ]);
  for (const rule of rules) {
    for (const h of rule.action?.responseHeaders ?? []) {
      assert.ok(
        !guarded.has(String(h.header).toLowerCase()),
        `rule ${rule.id} modifies response header ${h.header}`
      );
    }
  }
});

test('DNR rule ids are unique', () => {
  const ids = rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('no content script runs in all frames (would hit third-party embeds)', () => {
  for (const cs of manifest.content_scripts) {
    assert.notEqual(
      cs.all_frames,
      true,
      `content script ${JSON.stringify(cs.js)} has all_frames:true`
    );
  }
});

test('the MAIN-world sniffer is document_start and top-frame-only', () => {
  const sniffer = manifest.content_scripts.find((cs) => cs.js.includes('sniffer.js'));
  assert.ok(sniffer, 'sniffer content script missing');
  assert.equal(sniffer.world, 'MAIN');
  assert.equal(sniffer.run_at, 'document_start');
});

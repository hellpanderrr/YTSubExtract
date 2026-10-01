import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneOldest } from '../src/utils/prune-map.js';

const mapOf = (...keys) => new Map(keys.map((k) => [k, k.toUpperCase()]));

test('under the cap nothing is evicted', () => {
  const m = pruneOldest(mapOf('a', 'b'), 3);
  assert.deepEqual([...m.keys()], ['a', 'b']);
});

test('exactly at the cap nothing is evicted (the bound is inclusive)', () => {
  const m = pruneOldest(mapOf('a', 'b', 'c'), 3);
  assert.deepEqual([...m.keys()], ['a', 'b', 'c']);
});

test('over the cap evicts the OLDEST inserted keys, keeping the newest', () => {
  const m = pruneOldest(mapOf('a', 'b', 'c', 'd', 'e'), 3);
  assert.deepEqual([...m.keys()], ['c', 'd', 'e']);
});

test('re-setting an existing key does not refresh its age', () => {
  const m = mapOf('a', 'b', 'c');
  m.set('a', 'A2'); // 'a' is still the oldest-inserted key
  pruneOldest(m, 2);
  assert.deepEqual([...m.keys()], ['b', 'c']);
});

test('a cap of 0 empties the map, and an empty map is left alone', () => {
  assert.equal(pruneOldest(mapOf('a', 'b'), 0).size, 0);
  assert.equal(pruneOldest(new Map(), 5).size, 0);
});

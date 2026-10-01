// pruneOldest — cap a Map at `max` entries by evicting the oldest-INSERTED
// keys first (Map iterates in insertion order).
//
// Exists for content.js's capturedTranscripts: it stores one full caption
// body per (videoId, lang) and the content script lives as long as the tab,
// so a long playlist batch otherwise accumulates every video's raw body with
// nothing releasing it. Re-setting an existing key keeps its original
// position, so a video that gains a second language is not "refreshed".
export function pruneOldest(map, max) {
  while (map.size > max) {
    map.delete(map.keys().next().value);
  }
  return map;
}

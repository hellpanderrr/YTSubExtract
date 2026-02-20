
// Helper to format time for SRT: HH:MM:SS,mmm
function formatTimeSRT(seconds) {
  const date = new Date(0);
  date.setMilliseconds(seconds * 1000);
  const isoString = date.toISOString();
  // "1970-01-01T00:00:00.000Z" -> "00:00:00,000"
  return isoString.substr(11, 12).replace('.', ',');
}

// Helper to format time for VTT: HH:MM:SS.mmm
function formatTimeVTT(seconds) {
  const date = new Date(0);
  date.setMilliseconds(seconds * 1000);
  const isoString = date.toISOString();
  // "1970-01-01T00:00:00.000Z" -> "00:00:00.000"
  return isoString.substr(11, 12);
}

// === Converter JSON -> SRT ===
export function toSRT(subtitles) {
  return subtitles.map((sub, idx) => {
    const startTime = formatTimeSRT(sub.start);
    const endTime = formatTimeSRT(sub.end);
    return `${idx + 1}\n${startTime} --> ${endTime}\n${sub.text}\n`;
  }).join('\n');
}

// === Converter JSON -> VTT ===
export function toVTT(subtitles) {
  const header = "WEBVTT\n\n";
  const body = subtitles.map((sub) => {
    const startTime = formatTimeVTT(sub.start);
    const endTime = formatTimeVTT(sub.end);
    return `${startTime} --> ${endTime}\n${sub.text}\n`;
  }).join('\n');
  return header + body;
}

// === Converter JSON -> TXT ===
export function toTXT(subtitles) {
  return subtitles.map(sub => sub.text).join('\n');
}

// === Normalize to Standard Format ===
// Standard: { start: number, end: number, text: string }
export function normalizeTranscript(transcript, source) {
  if (!transcript) return [];
  
  if (source === 'youtube-caption-extractor') {
    // Already matches or close
    // { start: 0.5, end: 3.2, text: "..." }
    return transcript.map(item => ({
      start: Number(item.start),
      end: Number(item.end),
      text: item.text
    }));
  }
  
  if (source === '@playzone/youtube-transcript') {
    // { text: "...", start: 0.5, duration: 2.7 }
    return transcript.map(item => ({
      start: Number(item.start),
      end: Number(item.start) + Number(item.duration),
      text: item.text
    }));
  }
  
  if (source === 'youtubei.js') {
    // Complex structure, usually handled by Tier 3 worker logic before calling this
    // But if we pass raw, we need to parse. 
    // Assuming Tier 3 worker returns simplified format or we handle it here.
    // Let's assume Tier 3 worker returns standard format for simplicity.
    return transcript;
  }
  
  return transcript;
}

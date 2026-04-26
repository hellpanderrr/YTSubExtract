import { zip, strToU8 } from 'fflate';

/**
 * Create ZIP archive from files
 * @param {Array<{name: string, content: string}>} files - Array of files with name and content
 * @returns {Promise<Blob>} - ZIP file as Blob
 */
export async function createZip(files) {
  return new Promise((resolve, reject) => {
    // Convert files to the format expected by fflate
    const zipData = {};
    
    for (const file of files) {
      // Sanitize filename
      const safeName = sanitizeFilename(file.name);
      // Convert string to Uint8Array
      zipData[safeName] = strToU8(file.content);
    }

    // Create ZIP with compression level 6 (good balance)
    zip(zipData, { level: 6 }, (err, data) => {
      if (err) {
        reject(new Error(`ZIP creation failed: ${err.message}`));
        return;
      }
      
      // Create Blob from compressed data
      const blob = new Blob([data], { type: 'application/zip' });
      resolve(blob);
    });
  });
}

/**
 * Sanitize filename for ZIP
 * Remove/replace characters that are problematic in filenames
 */
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '') // Remove illegal Windows chars
    .replace(/\s+/g, '_')          // Replace spaces with underscores
    .substring(0, 100);           // Limit length
}

/**
 * Generate filename for individual subtitle file
 * Format: {index}_{sanitizedTitle}_{videoId}_{language}.{ext}
 */
export function generateSubtitleFilename(index, videoId, title, language, format) {
  const ext = format.toLowerCase();
  const paddedIndex = String(index).padStart(2, '0');
  const sanitizedTitle = sanitizeVideoTitle(title);
  return `${paddedIndex}_${sanitizedTitle}_${videoId}_${language}.${ext}`;
}

/**
 * Sanitize video title for use in filename
 * Keeps alphanumeric and spaces, removes special chars, limits length
 */
function sanitizeVideoTitle(title) {
  if (!title) return 'untitled';
  return title
    .replace(/[<>:"/\\|?*]/g, '')     // Remove illegal chars
    .replace(/[#&%+@!^()\[\]{}]/g, '') // Remove other special chars
    .replace(/\s+/g, '_')               // Replace spaces with underscores
    .replace(/_{2,}/g, '_')              // Collapse multiple underscores
    .replace(/^_|_$/g, '')              // Trim leading/trailing underscores
    .substring(0, 50);                   // Limit length to 50 chars
}

/**
 * Generate ZIP filename
 * Format: playlist_{sanitizedTitle}_{playlistId}_{language}_{timestamp}.zip
 */
export function generateZipFilename(playlistId, language, title = '') {
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const shortPlaylistId = playlistId.substring(0, 15);
  const sanitizedTitle = title
    ? sanitizeVideoTitle(title).substring(0, 30) + '_'
    : '';
  return `playlist_${sanitizedTitle}${shortPlaylistId}_${language}_${timestamp}.zip`;
}

/**
 * Download ZIP file
 * @param {Blob} blob - ZIP blob
 * @param {string} filename - Download filename
 */
export function downloadZip(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

import { translationManager } from './translation-manager.mjs';

/**
 * Batch processor for playlist video processing
 * Handles multiple videos with rate limiting and concurrency control
 */
export class BatchProcessor {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 3;
    this.delayMs = options.delayMs || 500;
    this.onProgress = options.onProgress || (() => {});
    this.onVideoComplete = options.onVideoComplete || (() => {});
    this.onVideoError = options.onVideoError || (() => {});
    
    this.isRunning = false;
    this.shouldStop = false;
  }

  /**
   * Process array of videos
   * @param {Array<{videoId: string, title: string, index: number}>} videos
   * @param {Object} options - Transcript options (sourceLang, translate, targetLang, format)
   * @returns {Promise<{success: Array, errors: Array}>}
   */
  async process(videos, options) {
    if (this.isRunning) {
      throw new Error('Batch processor is already running');
    }

    this.isRunning = true;
    this.shouldStop = false;

    const results = {
      success: [],
      errors: []
    };

    const total = videos.length;
    let completed = 0;

    this.onProgress({ completed: 0, total, failed: 0, current: null });

    try {
      // Process videos sequentially for better progress tracking
      // (even though it's slower, it gives accurate 0->1->2->3 progress)
      for (let i = 0; i < videos.length; i++) {
        if (this.shouldStop) {
          break;
        }

        const video = videos[i];

        // Initial delay to show "processing video X"
        await this._delay(200);

        try {
          // Report progress BEFORE processing (shows "processing X/Y")
          this.onProgress({
            completed,
            total,
            failed: results.errors.length,
            current: video.videoId
          });

          const transcript = await this._processVideo(video.videoId, options);

          const result = {
            videoId: video.videoId,
            title: video.title,
            index: video.index,
            transcript,
            format: options.format || 'srt'
          };

          results.success.push(result);
          this.onVideoComplete(result);

        } catch (err) {
          const error = {
            videoId: video.videoId,
            title: video.title,
            index: video.index,
            error: err.message,
            logs: err.logs || []
          };

          results.errors.push(error);
          this.onVideoError(error);
        }

        // Update progress after each video
        completed++;
        this.onProgress({
          completed: Math.min(completed, total),
          total,
          failed: results.errors.length,
          current: null
        });

        // Rate limiting delay between videos
        if (i < videos.length - 1 && !this.shouldStop) {
          await this._delay(this.delayMs);
        }
      }
    } finally {
      this.isRunning = false;
    }

    return results;
  }

  /**
   * Process single video using API-only tiers
   */
  async _processVideo(videoId, options) {
    const { sourceLang = 'auto', translate = false, targetLang = 'en' } = options;

    const response = await translationManager.getTranscriptForPlaylist(videoId, {
      sourceLang,
      translate,
      targetLang
    });

    return response;
  }

  /**
   * Stop processing
   */
  stop() {
    this.shouldStop = true;
  }

  /**
   * Check if running
   */
  getRunning() {
    return this.isRunning;
  }

  /**
   * Delay helper
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Generate error report content
 */
export function generateErrorReport(errors) {
  if (errors.length === 0) {
    return '';
  }

  const lines = [
    '=== Subtitle Download Errors ===',
    `Total failed: ${errors.length}`,
    '',
    'Failed videos:',
    ...errors.map(e => `  ${e.index}. ${e.videoId}: ${e.title} - ${e.error}`),
    '',
    'Detailed logs:',
    ...errors.flatMap(e => [
      `\n--- ${e.videoId} ---`,
      ...(e.logs || [e.error])
    ])
  ];

  return lines.join('\n');
}

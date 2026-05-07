import { translationManager } from './translation-manager.mjs';

/**
 * Semaphore for controlling concurrent async operations
 */
class Semaphore {
  constructor(maxConcurrency) {
    this.maxConcurrency = maxConcurrency;
    this.currentCount = 0;
    this.waitQueue = [];
  }

  async acquire() {
    if (this.currentCount < this.maxConcurrency) {
      this.currentCount++;
      return;
    }

    return new Promise(resolve => {
      this.waitQueue.push(resolve);
    });
  }

  release() {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      next();
    } else {
      this.currentCount--;
    }
  }
}

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
    // Atomic check-and-set using isRunning flag
    if (this.isRunning) {
      console.warn('[BatchProcessor] Already running, ignoring request');
      throw new Error('Batch processor is already running');
    }

    try {
      this.isRunning = true;
      this.shouldStop = false;

      const results = {
        success: [],
        errors: []
      };

      const total = videos.length;
      let completed = 0;

      this.onProgress({ completed: 0, total, failed: 0, current: null });

      // Process videos in parallel with concurrency control
      // Uses semaphore pattern for rate limiting and controlled parallelism
      const semaphore = new Semaphore(this.concurrency);

      // Create processing tasks for all videos
      const tasks = videos.map(async (video, index) => {
        // Wait for semaphore slot (controls concurrency)
        await semaphore.acquire();

        try {
          if (this.shouldStop) {
            return; // Skip processing if stopped
          }

          // Initial delay with jitter for staggered start
          await this._delay(200, 100);

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
          } finally {
            // Update progress after each video (atomic increment)
            completed++;
            this.onProgress({
              completed: Math.min(completed, total),
              total,
              failed: results.errors.length,
              current: null
            });
          }

          // Rate limiting delay between videos with jitter
          if (index < videos.length - 1 && !this.shouldStop) {
            await this._delay(this.delayMs, 100);
          }

        } finally {
          // Always release semaphore slot
          semaphore.release();
        }
      });

      // Wait for all tasks to complete
      await Promise.all(tasks);
      return results;
    } finally {
      this.isRunning = false;
    }
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
   * Delay helper with optional jitter for rate limit distribution
   * @param {number} ms - Base delay in milliseconds
   * @param {number} jitter - Random jitter to add (0-100ms default)
   */
  _delay(ms, jitter = 0) {
    const actualDelay = ms + (jitter > 0 ? Math.floor(Math.random() * jitter) : 0);
    return new Promise(resolve => setTimeout(resolve, actualDelay));
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

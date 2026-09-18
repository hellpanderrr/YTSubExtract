/**
 * Single-video subtitle download.
 *
 * Set E2E_VIDEO_URL to a video known to have captions. Without it the test
 * skips with a clear message.
 */
import { test, expect } from './fixtures.mjs';
import {
  openPopup,
  waitForSingleVideoReady,
  waitForDownload,
  clearDownloads,
  eraseDownloadHistory,
} from './helpers.mjs';
import fs from 'fs';

const VIDEO_URL = process.env.E2E_VIDEO_URL;

test.describe('single video download', () => {
  test.skip(!VIDEO_URL, 'Set E2E_VIDEO_URL to a video with captions to run this test.');

  test.beforeEach(async ({ context }) => {
    clearDownloads();
    await eraseDownloadHistory(context);
  });

  test('fetches languages and downloads an SRT', async ({ context, extensionId }) => {
    const yt = await context.newPage();
    await yt.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
    await yt.waitForTimeout(3000);

    const popup = await openPopup(context, extensionId, yt);
    await waitForSingleVideoReady(popup);

    // Arm the download listener BEFORE clicking, so a fast download isn't missed.
    const downloadPromise = waitForDownload(context, (f) => f.toLowerCase().endsWith('.srt'), 180_000);
    await popup.evaluate(() => document.getElementById('btn-srt').click());

    const file = await downloadPromise;
    const body = fs.readFileSync(file, 'utf8');

    // Basic SRT shape: a numeric cue index and an arrow timestamp line.
    expect(body).toMatch(/^\d+\s*$/m);
    expect(body).toContain('-->');
    expect(body.length).toBeGreaterThan(50);

  });

  test('downloads a VTT with a WEBVTT header', async ({ context, extensionId }) => {
    const yt = await context.newPage();
    await yt.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
    await yt.waitForTimeout(3000);

    const popup = await openPopup(context, extensionId, yt);
    await waitForSingleVideoReady(popup);

    const downloadPromise = waitForDownload(context, (f) => f.toLowerCase().endsWith('.vtt'), 180_000);
    await popup.evaluate(() => document.getElementById('btn-vtt').click());

    const file = await downloadPromise;
    const body = fs.readFileSync(file, 'utf8');
    expect(body.startsWith('WEBVTT')).toBe(true);

  });
});
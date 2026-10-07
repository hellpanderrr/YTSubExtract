import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const EXTENSION_DIR = path.resolve(__dirname, 'dist');
export const PROFILE_DIR = path.resolve(__dirname, '.e2e-profile');
export const DOWNLOAD_DIR = path.resolve(__dirname, '.e2e-downloads');

export default defineConfig({
  testDir: path.resolve(__dirname, 'e2e'),
  testMatch: '**/*.spec.mjs',

  // Extension tests share one persistent browser profile — no parallelism.
  fullyParallel: false,
  workers: 1,

  // Real YouTube round-trips are slow and a batch download of N videos runs
  // serially through the extension's tiered extractor; allow generous time.
  timeout: 600_000,
  expect: { timeout: 15_000 },

  // Headless Chromium with an extension intermittently dies at startup on
  // Windows with a native crash (0xC0000005 / 0x80000003) under memory
  // pressure. These are browser-process faults, not test failures — a retry
  // tears down the worker and relaunches the browser, which clears them. One
  // retry is enough; a genuine product failure still fails the second attempt.
  retries: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});

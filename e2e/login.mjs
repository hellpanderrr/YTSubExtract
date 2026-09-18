/**
 * One-time YouTube login for the e2e suite.
 *
 * Opens a HEADED browser using the golden profile
 * (.e2e-profile-golden/). Sign into YouTube in that window; cookies persist in
 * the profile directory, and every `npm run e2e` run starts from a fresh COPY of
 * it. That copy step is deliberate: reusing one profile in place made a warm
 * profile fail where a fresh copy passed (see docs/LESSONS.md).
 *
 * Why not reuse the real Chrome profile: Chrome refuses to launch with a profile
 * that is already open, and the raw profile is large. A dedicated test profile is
 * cleaner and never touches your everyday browsing data.
 *
 * Usage: npm run e2e:login
 */
import { chromium } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILE_DIR = path.resolve(ROOT, '.e2e-profile-golden');
const EXTENSION_DIR = path.resolve(ROOT, 'dist');

const AUTH_COOKIES = ['__Secure-1PSID', 'SAPISID', 'SID', '__Secure-3PSID'];

async function isLoggedIn(context) {
  const cookies = await context.cookies('https://www.youtube.com');
  const names = new Set(cookies.map((c) => c.name));
  return AUTH_COOKIES.some((n) => names.has(n));
}

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  YTSubExtract — one-time YouTube login       ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log('A browser window will open. Sign into YouTube there, then come back.\n');

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chromium',
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: EXTENSION_DIR && fs.existsSync(EXTENSION_DIR)
      ? [
          `--disable-extensions-except=${EXTENSION_DIR}`,
          `--load-extension=${EXTENSION_DIR}`,
          '--no-first-run',
          '--no-default-browser-check',
        ]
      : ['--no-first-run', '--no-default-browser-check'],
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded' });

  await waitForEnter('Press Enter here once you are signed in... ');

  if (await isLoggedIn(context)) {
    console.log('\n✅ Signed in — auth cookies are stored in the profile.');
    console.log('   Headless test runs will now reuse this session.');
    console.log('   Verify with:  npm run e2e\n');
  } else {
    console.log('\n⚠️  No YouTube auth cookies found in the profile.');
    console.log('   The window may have closed before login completed, or you');
    console.log('   signed in but YouTube did not set __Secure-1PSID/SAPISID.');
    console.log('   Re-run `npm run e2e:login` and make sure YouTube shows your');
    console.log('   avatar in the top-right before pressing Enter.\n');
  }

  await context.close();
}

main().catch((err) => {
  console.error('❌ Login setup failed:', err);
  process.exit(1);
});

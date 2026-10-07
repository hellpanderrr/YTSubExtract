// Zip dist/ for the Chrome Web Store. Uses fflate (pure JS, already a
// runtime dependency) instead of zip-a-folder: zip-a-folder 7 pulls in a
// native @napi-rs/lzma binary that intermittently fails to install (npm
// optional-dependencies bug, npm/cli#4828) — a build-tool dependency that
// can break `npm ci` on the release rail for no benefit, since fflate does
// the same job with zero platform bindings.
const { zipSync } = require('fflate');
const {
  readdirSync, statSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} = require('fs');
const { join, resolve, relative, sep } = require('path');

const DIST_PATH = resolve(__dirname, '../dist');
const BUILDS_PATH = resolve(__dirname, '../builds');
const ZIP_PATH = join(BUILDS_PATH, 'extension.zip');

/** All regular files under dir as { "posix/rel/path": Buffer }. */
function collectFiles(dir, base = dir, out = {}) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectFiles(full, base, out);
    } else {
      // ZIP entry names must use forward slashes on every platform.
      out[relative(base, full).split(sep).join('/')] = readFileSync(full);
    }
  }
  return out;
}

function main() {
  if (!existsSync(BUILDS_PATH)) {
    mkdirSync(BUILDS_PATH);
  }
  if (!existsSync(DIST_PATH)) {
    console.error('dist/ does not exist — run `npm run build` first');
    process.exit(1);
  }

  console.log(`Zipping ${DIST_PATH} to ${ZIP_PATH}...`);
  const files = collectFiles(DIST_PATH);
  const zip = zipSync(files, { level: 6 });
  writeFileSync(ZIP_PATH, zip);
  console.log(`Done! ${Object.keys(files).length} files, ${zip.length} bytes`);
}

main();

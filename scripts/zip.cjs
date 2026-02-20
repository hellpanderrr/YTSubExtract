const { zip } = require('zip-a-folder');
const { resolve, join } = require('path');
const { existsSync, mkdirSync } = require('fs');

const DIST_PATH = resolve(__dirname, '../dist');
const BUILDS_PATH = resolve(__dirname, '../builds');

async function main() {
  if (!existsSync(BUILDS_PATH)) {
    mkdirSync(BUILDS_PATH);
  }

  const zipPath = join(BUILDS_PATH, 'extension.zip');
  console.log(`Zipping ${DIST_PATH} to ${zipPath}...`);
  
  try {
    await zip(DIST_PATH, zipPath);
    console.log('Done!');
  } catch (e) {
    console.error('Error zipping:', e);
  }
}

main();

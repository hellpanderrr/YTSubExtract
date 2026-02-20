const crx = require('crx');
const { readdirSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { join, resolve } = require('path');
const NodeRSA = require('node-rsa');

const DIST_PATH = resolve(__dirname, '../dist');
const BUILDS_PATH = resolve(__dirname, '../builds');
const KEY_PATH = resolve(__dirname, '../key.pem');

if (!existsSync(BUILDS_PATH)) {
  mkdirSync(BUILDS_PATH);
}

async function pack() {
  try {
    if (!existsSync(KEY_PATH)) {
      console.log('Generating new key...');
      const key = new NodeRSA({b: 2048});
      const privateKey = key.exportKey('private');
      writeFileSync(KEY_PATH, privateKey);
      console.log('Key saved to key.pem');
    }

    const c = new crx({
      codebase: 'http://localhost:8000/extension.crx',
      privateKey: readFileSync(KEY_PATH)
    });

    console.log('Packing extension...');
    const crxBuffer = await c.load(DIST_PATH).then(crx => crx.pack());
    const fileName = `extension.crx`;
    writeFileSync(join(BUILDS_PATH, fileName), crxBuffer);
    console.log(`Packed to builds/${fileName}`);
    
  } catch (err) {
    console.error('Error packing:', err);
  }
}

pack();

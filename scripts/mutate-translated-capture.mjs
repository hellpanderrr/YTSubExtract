// Mutation-test test/translated-capture.test.mjs: each mutant reinstates one
// real defect from 2026-10-03/05 and must make the suite FAIL. Restores the
// file in `finally`; a hung run is SIGKILLed. Exits non-zero if any survives.
//   node scripts/mutate-translated-capture.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const FILE = 'src/utils/translated-capture.js';
const original = readFileSync(FILE, 'utf8');

const MUTATIONS = [
  {
    name: 'gate one-directional (untranslated accepts a tlang capture)',
    from: 'return (captureTlang || null) === (wantTlang || null);',
    to: 'if (!wantTlang) return true;\n  return captureTlang === wantTlang;',
  },
  {
    name: 'key ignores tlang (source/translated collide)',
    from: 'return tlang ? `${base}|${tlang}` : base;',
    to: 'return base;',
  },
  {
    name: 'bare fallback option drops translationLanguage (clobber)',
    from: 'if (wantTlang) bare.translationLanguage = { languageCode: wantTlang };',
    to: '',
  },
];

const runSuite = () =>
  spawnSync(process.execPath, ['--test', 'test/translated-capture.test.mjs'], {
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });

// Baseline: the unmodified suite must pass, or every mutant would look
// "killed" by a suite that cannot run at all.
const baseline = runSuite();
if (baseline.status !== 0) {
  console.error('BASELINE FAILED: test/translated-capture.test.mjs does not pass unmodified — aborting.');
  console.error((baseline.stdout || '') + (baseline.stderr || ''));
  process.exit(2);
}

let survived = 0;
try {
  for (const m of MUTATIONS) {
    if (original.split(m.from).length - 1 !== 1) {
      console.log(`ANCHOR NOT UNIQUE/FOUND: ${m.name}`);
      survived++;
      continue;
    }
    writeFileSync(FILE, original.replace(m.from, m.to));
    const r = runSuite();
    const killed = r.status !== 0;
    console.log(`${killed ? 'KILLED' : 'SURVIVED'}: ${m.name}`);
    if (!killed) survived++;
  }
} finally {
  writeFileSync(FILE, original);
}

console.log(survived === 0 ? '\nAll mutants killed.' : `\n${survived} mutant(s) SURVIVED.`);
process.exit(survived === 0 ? 0 : 1);

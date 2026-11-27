import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from '../js/version.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('version is the same everywhere', () => {
  assert.equal(JSON.parse(read('version.json')).version, APP_VERSION);
  assert.equal(JSON.parse(read('package.json')).version, APP_VERSION);
  assert.match(read('sw.js'), new RegExp(`const VERSION = 'wcsim-${APP_VERSION.replace(/\./g, '\\.')}'`));
});

test('every app file is precached for offline use', () => {
  const sw = read('sw.js');
  for (const f of ['js/app.js', 'js/version.js', 'js/store.js', 'js/ui/sim.js', 'js/core/engine.js', 'css/app.css', 'version.json', 'js/disclaimer.js']) {
    assert.ok(sw.includes(`'./${f}'`), `${f} missing from sw.js`);
  }
});

test('certification bodies are only named in the not-affiliated disclaimer', () => {
  for (const f of ['index.html', 'manifest.webmanifest', 'README.md', 'js/app.js', 'js/ui/sim.js', 'js/ui/killsheet-form.js', 'js/disclaimer.js', 'js/version.js']) {
    const text = read(f);
    // join wrapped lines into sentences, then every sentence naming a body must say "not affiliated"
    for (const sentence of text.replace(/\n(?!\n)/g, ' ').split(/(?<=[.!?])\s+|\n\n/)) {
      if (/\b(IWCF|IADC)\b/i.test(sentence)) assert.match(sentence, /not affiliated/i, `${f}: ${sentence.slice(0, 120)}`);
    }
  }
  assert.match(read('js/disclaimer.js'), /not affiliated with, endorsed by or connected to IWCF/);
});

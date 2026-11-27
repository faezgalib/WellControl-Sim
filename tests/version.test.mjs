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
  for (const f of ['js/app.js', 'js/version.js', 'js/store.js', 'js/ui/sim.js', 'js/core/engine.js', 'css/app.css', 'version.json']) {
    assert.ok(sw.includes(`'./${f}'`), `${f} missing from sw.js`);
  }
});

test('no claims of affiliation in user-facing files', () => {
  for (const f of ['index.html', 'manifest.webmanifest', 'README.md', 'js/app.js', 'js/ui/sim.js', 'js/ui/killsheet-form.js']) {
    assert.doesNotMatch(read(f), /\b(IWCF|IADC)\b/i, f);
  }
});

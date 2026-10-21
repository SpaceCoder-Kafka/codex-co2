import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const locales = JSON.parse(fs.readFileSync(new URL('../owner/locales.json', import.meta.url), 'utf8'));
const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('all three locale catalogs translate the same keys and preserve template values', () => {
  const keys = Object.keys(locales['zh-CN']).sort();
  assert.deepEqual(Object.keys(locales).sort(), ['en', 'zh-CN', 'zh-TW']);
  for (const language of Object.keys(locales)) {
    assert.deepEqual(Object.keys(locales[language]).sort(), keys);
    for (const source of keys) {
      const translated = locales[language][source];
      assert.ok(typeof translated === 'string' && translated.trim());
      assert.deepEqual(placeholders(translated), placeholders(source), `${language}: ${source}`);
      if (language === 'en') assert.ok(!/[\u4e00-\u9fff]/u.test(translated), source);
    }
  }
});

test('all marked static management labels and dynamic translation literals have translations', () => {
  const html = fs.readFileSync(new URL('../owner/index.html', import.meta.url), 'utf8');
  const script = fs.readFileSync(new URL('../owner/owner.js', import.meta.url), 'utf8');
  const sources = [...html.matchAll(/data-i18n(?:-placeholder|-aria-label|-title)?="([^"]+)"/g)].map(m => m[1]);
  sources.push(...[...script.matchAll(/\bt\('([^'\n]+)'/g)].map(m => m[1]));
  for (const source of sources) assert.ok(Object.hasOwn(locales.en, source), `Missing: ${source}`);
  const languageSelect = html.match(/<select id="language"[^>]*>(.*?)<\/select>/s)[1];
  assert.equal((languageSelect.match(/<option value=/g) || []).length, 3);
});

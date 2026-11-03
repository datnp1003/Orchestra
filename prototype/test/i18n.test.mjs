// i18n: en/vi cùng key + cùng {placeholder}, interpolate, fallback, detectLocale
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../dist/i18n/en.js';
import { vi } from '../dist/i18n/vi.js';
import { t, setLocale, getLocale, detectLocale, messages, missing } from '../dist/i18n/index.js';

const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('en/vi: cùng key set, cùng placeholder, không rỗng, namespace hợp lệ', () => {
  assert.deepEqual(Object.keys(vi).sort(), Object.keys(en).sort());
  for (const k of Object.keys(en)) {
    assert.deepEqual(ph(vi[k]), ph(en[k]), `placeholder lệch: ${k}`);
    assert.ok(en[k].trim() && vi[k].trim(), `chuỗi rỗng: ${k}`);
    assert.match(k, /^(desktop|cli|core|router|ext|brain)\./, `namespace: ${k}`);
  }
});

test('t: locale, interpolate, fallback → key + missing', () => {
  setLocale('vi');
  assert.equal(getLocale(), 'vi');
  assert.equal(t('desktop.tray.quit'), 'Thoát');
  assert.equal(t('desktop.err.repoMissing', { repo: 'C:/x' }), 'Repo không tồn tại: C:/x');
  setLocale('en');
  assert.equal(t('desktop.err.repoMissing', { repo: 'C:/x' }), 'Repo does not exist: C:/x');
  assert.equal(t('desktop.err.repoMissing'), 'Repo does not exist: {repo}', 'thiếu param → giữ placeholder');
  assert.equal(t('desktop.time.minutes', { n: 0 }), '0m ago');
  setLocale('fr'); // không hỗ trợ → en
  assert.equal(getLocale(), 'en');
  assert.equal(missing.size, 0);
  assert.equal(t('no.such.key'), 'no.such.key');
  assert.ok(missing.has('no.such.key'), 'key thiếu phát hiện được');
  missing.clear();
});

test('messages(prefix): chỉ key theo prefix, theo locale', () => {
  setLocale('vi');
  const d = messages('desktop.');
  assert.ok(Object.keys(d).length > 0 && Object.keys(d).every((k) => k.startsWith('desktop.')));
  assert.equal(d['desktop.tray.quit'], 'Thoát');
  setLocale('en');
});

// string literal ('…' "…" `…`) of a .ts source with comments stripped — tokenizer, not regex, so '//' inside strings is safe.
// ponytail: `${…}` nested quotes inside template literals are treated as part of the literal (fine for a diacritic scan).
function literals(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const end = (s, from) => (src.indexOf(s, from) + 1 || src.length + 1) - 1;
    if (c === '/' && src[i + 1] === '/') i = end('\n', i);
    else if (c === '/' && src[i + 1] === '*') i = end('*/', i + 2) + 1;
    else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out.push(src.slice(i + 1, j));
      i = j;
    }
  }
  return out;
}

test('không còn tiếng Việt có dấu trong string literal ngoài i18n/vi.ts (prototype/src + extension/src)', () => {
  const VI = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
  const ALLOW = new Set(['Tiếng Việt']); // tên ngôn ngữ trong en.ts (endonym, giữ nguyên ở mọi locale)
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const files = ['prototype/src', 'extension/src'].flatMap((d) =>
    readdirSync(join(root, d), { recursive: true }).filter((f) => f.endsWith('.ts')).map((f) => join(d, f)),
  );
  assert.ok(files.length > 20, 'scan thấy file');
  const bad = files
    .filter((f) => !/i18n[\\/]vi\.ts$/.test(f))
    .flatMap((f) => literals(readFileSync(join(root, f), 'utf8')).filter((s) => VI.test(s) && !ALLOW.has(s)).map((s) => `${f}: ${s.slice(0, 80)}`));
  assert.deepEqual(bad, []);
  assert.deepEqual(literals("a = 'x'; // 'đ'\n/* \"đ\" */ b = `y${1}` + \"//z\""), ['x', 'y${1}', '//z'], 'tokenizer bỏ comment');
});

test('detectLocale', () => {
  for (const v of ['vi', 'vi-VN', 'VI_vn.UTF-8']) assert.equal(detectLocale(v), 'vi', v);
  for (const v of [undefined, '', 'en-US', 'fr', 'xvi']) assert.equal(detectLocale(v), 'en', String(v));
});

test('prompt gửi LLM không phụ thuộc locale UI — theo ngôn ngữ của user', async () => {
  const { setLocale } = await import('../dist/i18n/index.js');
  const { buildPrompt } = await import('../dist/dispatch.js');
  const b = { goal: 'thêm hàm isPositive vào stripe.ts', files_in_scope: ['src/**'], constraints: [], forbidden_actions: [], acceptance_criteria: [] };
  setLocale('vi'); const vi = buildPrompt(b);
  setLocale('en'); const en = buildPrompt(b);
  assert.equal(vi, en, 'buildPrompt đổi theo locale UI');
  assert.ok(en.includes('GOAL: thêm hàm isPositive vào stripe.ts'), 'goal của user phải giữ nguyên văn');
});

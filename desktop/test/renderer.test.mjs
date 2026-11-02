// Renderer static check — node thường: CSP (script-src 'self') chặn inline handler, esc() phải attribute-safe
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dir = new URL('../src/renderer/', import.meta.url);
const js = readFileSync(new URL('app.js', dir), 'utf8');
const html = readFileSync(new URL('index.html', dir), 'utf8');

for (const [name, src] of [['app.js', js], ['index.html', html]]) {
  const hit = src.match(/\son[a-z]+\s*=\s*["']/i);
  assert.equal(hit, null, `${name}: inline handler bị CSP chặn: ${hit?.[0]}`);
}
console.log('✓ không có inline on*= handler');

const line = js.split(/\r?\n/).find((l) => l.startsWith('const esc ='));
assert.ok(line, 'không tìm thấy const esc');
const esc = new Function(`${line}; return esc;`)();
const out = esc(`a"b'<c>&`);
assert.equal(out, 'a&quot;b&#39;&lt;c&gt;&amp;');
assert.ok(!/["'<>]/.test(out), 'esc còn ký tự nguy hiểm');
assert.equal(esc(null), '');
console.log('✓ esc attribute-safe:', out);

assert.ok(!js.includes("addEventListener('message'"), 'listener message (leak) phải bị xoá');
console.log('✓ không còn window message listener');

// M1: chat không chọn worker; chỉ model Orchestra
assert.ok(!html.includes('cbWorker') && !js.includes('cbWorker'), 'composer không còn chọn worker');
assert.ok(html.includes('id="cbModel"') && js.includes("'brain:models'"), 'composer có model Orchestra từ brain:models');
assert.ok(!js.includes('orchestratorWorker'), 'renderer không dùng CLI brain cũ');
console.log('✓ composer: chỉ chọn model Orchestra');
assert.ok(html.includes('id="chatStop"') && js.includes("'chat:cancel'"), 'composer có nút Dừng → chat:cancel');
console.log('✓ composer: nút Dừng');
console.log('RENDERER TEST PASS ✓');

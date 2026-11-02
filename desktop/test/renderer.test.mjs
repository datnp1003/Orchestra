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

// R2a: tab Providers thay Vault; key input là password, không còn kênh vault/brain:config
assert.ok(js.includes("['providers', 'Providers']") && !js.includes("'vault'"), 'tab Providers thay Vault');
for (const c of ["'brain:config'", "'vault:set'", "'vault:delete'"]) assert.ok(!js.includes(c), `renderer không gọi ${c}`);
assert.ok(/id="prKey" type="password"/.test(js), 'key input type=password');
assert.ok(/confirm\([^)]*claude\/settings\.json/.test(js), 'import có confirm()');
console.log('✓ Providers tab: password key, import có confirm, không còn vault/brain:config');

// R3: OAuth — cảnh báo đỏ + checkbox bắt buộc trước khi lưu/đăng nhập
assert.ok(js.includes("'oauth-anthropic', 'OAuth Anthropic (Claude Pro/Max)'") && js.includes("'oauth-openai', 'OAuth OpenAI (ChatGPT Plus/Pro)'"), 'kind OAuth có label');
assert.ok(/id="prRisk" class="risk"/.test(js) && js.includes('KHOÁ TÀI KHOẢN') && js.includes('giả danh client'), 'warning box');
assert.ok(/id="prRiskOk" \/> Tôi hiểu rủi ro/.test(js) && /!\$\('#prRiskOk'\)\.checked/.test(js), 'checkbox Tôi hiểu rủi ro chặn lưu');
assert.ok(js.includes("'oauth:start'") && js.includes("'oauth:finish'") && js.includes('OAuth ⚠'), 'nút Đăng nhập + badge');
assert.ok(!/\.(access|refresh)\b/.test(js), 'renderer không đụng token');
console.log('✓ OAuth: warning + checkbox bắt buộc + login, không token');
console.log('RENDERER TEST PASS ✓');

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
assert.ok(!js.includes('providers:import') && !js.includes('prImport'), 'đã bỏ Import từ claude/codex config');
for (const l of ['＋ Anthropic API', '＋ OpenAI API', '＋ Anthropic Compatible', '＋ OpenAI Compatible', 'Claude Code (Claude Pro/Max)', 'OpenAI Codex (ChatGPT Plus/Pro)', 'đã kết nối']) {
  assert.ok(js.includes(l), `quick-add: ${l}`);
}
console.log('✓ Providers tab: password key, quick-add, không còn import/vault/brain:config');

// UI feedback: sessions thay Tasks gần đây; nav gọn; Dashboard ngay trên Cài đặt; Matrix vào Settings
assert.ok(html.includes('id="sideSessionList"') && js.includes("'chat:sessions'") && js.includes("'chat:open'"), 'sidebar có Sessions');
assert.ok(!html.includes('Tasks gần đây') && !html.includes('sideTaskList') && !js.includes('loadSideTasks'), 'bỏ Tasks gần đây');
assert.ok(html.includes('＋ Chat mới') && !html.includes('Task mới'), 'nút Chat mới');
assert.ok(!js.includes('data-auth') && !/>Auth</.test(js), 'bỏ nút Auth worker');
assert.ok(js.includes('Auth: qua Orchestra router') && js.includes('f.display'), 'worker có tên + dòng auth router');
assert.ok(!html.includes('href="#/terminal"') && !html.includes('href="#/matrix"'), 'Terminal + Policy Matrix không còn trên nav');
assert.ok(js.includes("['matrix', 'Policy Matrix']"), 'Policy Matrix là tab Settings');
const nav = html.slice(html.indexOf('<nav id="nav">'), html.indexOf('</nav>'));
assert.deepEqual([...nav.matchAll(/data-page="(\w+)"/g)].map((m) => m[1]), ['chat'], 'top nav: chỉ Chat');
assert.ok(!html.includes('href="#/transcript"'), 'không còn link Transcript');
const foot = html.slice(html.indexOf('id="sideFooter"'));
assert.ok(foot.indexOf('href="#/dashboard"') > 0 && foot.indexOf('href="#/dashboard"') < foot.indexOf('id="btnSettings"'), 'Dashboard ngay trên Cài đặt');
console.log('✓ sidebar: Sessions, Chat mới, nav chỉ Chat, Dashboard trên Cài đặt; Matrix tab; không Auth/Import/Terminal/Transcript');

// Transcript là section trong Dashboard; #/transcript cũ → dashboard; top 20 (main giới hạn qua limit)
const dash = js.slice(js.indexOf('async function renderDashboard'), js.indexOf('// ---------- Transcript'));
assert.ok(dash.includes('id="transcript"') && dash.includes("renderTranscript($('#transcript'), tasks)"), 'Dashboard chứa section Transcript');
assert.ok(/if \(hash === 'transcript'\) \{ openTranscript = true; location\.hash = '#\/dashboard'/.test(js) && !/transcript: renderTranscript/.test(js), '#/transcript → #/dashboard');
assert.ok(/const TOP_N = 20;/.test(js) && dash.includes("api.invoke('tasks:list', { limit: TOP_N })"), 'tasks:list limit 20');
console.log('✓ Transcript trong Dashboard, #/transcript redirect, top 20');

// R3: OAuth — cảnh báo đỏ + checkbox bắt buộc trước khi lưu/đăng nhập
assert.ok(js.includes("'oauth-anthropic', 'OAuth Anthropic (Claude Pro/Max)'") && js.includes("'oauth-openai', 'OAuth OpenAI (ChatGPT Plus/Pro)'"), 'kind OAuth có label');
assert.ok(/id="prRisk" class="risk"/.test(js) && js.includes('KHOÁ TÀI KHOẢN') && js.includes('giả danh client'), 'warning box');
assert.ok(/id="prRiskOk" \/> Tôi hiểu rủi ro/.test(js) && /!\$\('#prRiskOk'\)\.checked/.test(js), 'checkbox Tôi hiểu rủi ro chặn lưu');
assert.ok(js.includes("'oauth:start'") && js.includes("'oauth:finish'") && js.includes('OAuth ⚠'), 'nút Đăng nhập + badge');
assert.ok(!/\.(access|refresh)\b/.test(js), 'renderer không đụng token');
console.log('✓ OAuth: warning + checkbox bắt buộc + login, không token');
console.log('RENDERER TEST PASS ✓');

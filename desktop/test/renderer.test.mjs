// Renderer static check — node thường: CSP (script-src 'self') chặn inline handler, esc() phải attribute-safe
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

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
for (const l of ['＋ Anthropic API', '＋ OpenAI API', '＋ Anthropic Compatible', '＋ OpenAI Compatible', 'Claude Code (Claude Pro/Max)', 'OpenAI Codex (ChatGPT Plus/Pro)', 'desktop.pr.connected']) {
  assert.ok(js.includes(l), `quick-add: ${l}`);
}
console.log('✓ Providers tab: password key, quick-add, không còn import/vault/brain:config');

// UI feedback: sessions thay Tasks gần đây; nav gọn; Dashboard ngay trên Cài đặt; Matrix vào Settings
assert.ok(js.includes("'chat:sessions'") && js.includes("'chat:open'"), 'sidebar có sessions');
assert.ok(!html.includes('Tasks gần đây') && !html.includes('sideTaskList') && !js.includes('loadSideTasks'), 'bỏ Tasks gần đây');
assert.ok(html.includes('data-i18n="desktop.newChat.label"') && !html.includes('Task mới'), 'nút Chat mới');
assert.ok(!js.includes('data-auth') && !/>Auth</.test(js), 'bỏ nút Auth worker');
assert.ok(js.includes('desktop.w.authRouter') && js.includes('f.display'), 'worker có tên + dòng auth router');
assert.ok(!html.includes('href="#/terminal"') && !html.includes('href="#/matrix"'), 'Terminal + Policy Matrix không còn trên nav');
assert.ok(js.includes("['matrix', 'Policy Matrix']"), 'Policy Matrix là tab Settings');
assert.ok(!html.includes('<nav id="nav">'), 'bỏ nav Chat (Chat mới là lối vào)');
assert.ok(!html.includes('href="#/transcript"'), 'không còn link Transcript');
const foot = html.slice(html.indexOf('id="sideFooter"'));
assert.ok(foot.indexOf('href="#/dashboard"') > 0 && foot.indexOf('href="#/dashboard"') < foot.indexOf('id="btnSettings"'), 'Dashboard ngay trên Cài đặt');
console.log('✓ sidebar: Chat mới, Dashboard trên Cài đặt; Matrix tab; không Auth/Import/Terminal/Transcript');

// Projects: thứ tự sidebar Chat mới → PROJECTS → CHATS → footer; không còn chọn repo / tag repo
const order = ['id="newChat"', 'id="sideProjects"', 'id="sideChats"', 'id="sideFooter"'].map((s) => html.indexOf(s));
assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), `thứ tự sidebar: ${order}`);
assert.ok(html.includes('id="newProject"') && js.includes("'project:create'"), 'header PROJECTS có ＋ → project:create');
for (const s of ['repoPick', 'repoSel', 'repoLabel', 'session-repo', 'sRepos', 'sAddRepo', "'repo:add'", "'repo:set-active'", 'sideSessionList']) {
  assert.ok(!html.includes(s) && !js.includes(s), `bỏ ${s}`);
}
assert.ok(js.includes("api.invoke('chat:open', { projectId, id })") && js.includes("api.invoke('chat:new', { projectId: projectId ?? null })") && !js.includes("'chat:reset'"), 'chat:open/chat:new theo project');
assert.ok(js.includes("localStorage.setItem('orchestra.collapsed'") && js.includes('data-new-in=') && js.includes('proj-badge'), 'group project: collapse (localStorage), ＋ chat, badge repo');
assert.ok(js.includes("'#/project/'") && js.includes('function renderProject') && ['project:get', 'project:rename', 'project:addRepo', 'project:removeRepo', 'project:delete'].every((c) => js.includes(`'${c}'`)), 'trang Project');
assert.ok(/if \(!confirm\(t\('desktop\.project\.confirmDelete'/.test(js), 'xoá project phải confirm');
assert.ok(js.includes("renderMemoryEditor($('#globalMemory'), null)") && js.includes("renderMemoryEditor($('#pjMemory'), id)") && js.includes("'memory:set'"), 'memory editor: global (Settings) + project');
assert.ok(html.includes('id="pageRepo"') && js.includes("t('desktop.chat.global')"), 'header: tên project hoặc Chat');
console.log('✓ projects: sidebar PROJECTS/CHATS, collapse, trang Project, memory editor; không repoPick/repo tag');

// Transcript là section trong Dashboard; #/transcript cũ → dashboard; top 20 (main giới hạn qua limit)
const dash = js.slice(js.indexOf('async function renderDashboard'), js.indexOf('// ---------- Transcript'));
assert.ok(dash.includes('id="transcript"') && dash.includes("renderTranscript($('#transcript'), tasks)"), 'Dashboard chứa section Transcript');
assert.ok(/if \(hash === 'transcript'\) \{ openTranscript = true; location\.hash = '#\/dashboard'/.test(js) && !/transcript: renderTranscript/.test(js), '#/transcript → #/dashboard');
assert.ok(/const TOP_N = 20;/.test(js) && dash.includes("api.invoke('tasks:list', { limit: TOP_N })"), 'tasks:list limit 20');
console.log('✓ Transcript trong Dashboard, #/transcript redirect, top 20');

// R3: OAuth — cảnh báo đỏ + checkbox bắt buộc trước khi lưu/đăng nhập
assert.ok(js.includes("'oauth-anthropic', 'OAuth Anthropic (Claude Pro/Max)'") && js.includes("'oauth-openai', 'OAuth OpenAI (ChatGPT Plus/Pro)'"), 'kind OAuth có label');
assert.ok(/id="prRisk" class="risk"/.test(js) && js.includes("t('desktop.pr.risk' + i)"), 'warning box');
assert.ok(js.includes(`id="prRiskOk" /> \${esc(t('desktop.pr.riskOk'))}`) && /!\$\('#prRiskOk'\)\.checked/.test(js), 'checkbox Tôi hiểu rủi ro chặn lưu');
assert.ok(js.includes("'oauth:start'") && js.includes("'oauth:finish'") && js.includes('OAuth ⚠'), 'nút Đăng nhập + badge');
assert.ok(!/\.(access|refresh)\b/.test(js), 'renderer không đụng token');
console.log('✓ OAuth: warning + checkbox bắt buộc + login, không token');

// Skills: tab Settings (global) + card Project; skill-sync cũ đã bỏ; xoá phải confirm; renderer không gửi path
for (const c of ['list', 'save', 'remove', 'previewGithub', 'previewLocal', 'install', 'checkUpdate', 'update', 'cancelPreview']) assert.ok(js.includes(`'skills:${c}'`), `renderer gọi skills:${c}`);
assert.ok(!js.includes("'skills:sync'") && !js.includes('sSync') && !js.includes('skillSync'), 'bỏ skill-sync cũ');
assert.ok(js.includes("renderSkills($('#skillsBox'), null)") && js.includes("renderSkills($('#pjSkills'), id)"), 'Skills: Settings global + Project card');
assert.ok(/if \(!confirm\(t\('desktop\.skills\.confirmRemove'/.test(js), 'xoá skill phải confirm');
const sk = js.slice(js.indexOf('async function renderSkills'), js.indexOf('// ---------- Memory editor'));
assert.ok(!/\bpath\s*:/.test(sk) && !/dir\s*:/.test(sk), 'renderer Skills không gửi filesystem path');
assert.ok(sk.includes("t('desktop.skills.warn.' + w.code") && sk.includes("t('desktop.skills.err.' + it.error)"), 'preview hiện warning/error');
const { en: enDict } = await import('../out/prototype/src/i18n/en.js');
for (const k of ['script', 'large', 'suspicious']) assert.ok(`desktop.skills.warn.${k}` in enDict, `key warn.${k}`);
for (const k of ['symlink', 'tooBig', 'invalid', 'duplicate']) assert.ok(`desktop.skills.err.${k}` in enDict, `key err.${k}`);
console.log('✓ Skills: 9 channel, Settings + Project, confirm remove, warning/error có key, không gửi path');

// i18n: chuỗi UI chỉ nằm trong dictionary — không còn ký tự tiếng Việt ngoài comment
const VI = /[ăâđêôơưàáạảãầấậẩẫằắặẳẵèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;
// ponytail: strip comment bằng regex — không hiểu '//' trong string (vd 'https://…'); chuỗi đó chỉ làm scan bỏ sót phần sau, không báo sai
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const viHits = (name, s) => s.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => VI.test(l)).map(([n, l]) => `${name}:${n}: ${l.trim()}`);
const mainDir = new URL('../src/main/', import.meta.url);
const hits = [
  ...viHits('app.js', stripJs(js)),
  ...viHits('index.html', html.replace(/<!--[\s\S]*?-->/g, '')),
  ...readdirSync(mainDir).filter((f) => f.endsWith('.ts')).flatMap((f) => viHits(f, stripJs(readFileSync(new URL(f, mainDir), 'utf8')))),
];
assert.deepEqual(hits, [], 'chuỗi tiếng Việt hardcode — chuyển vào prototype/src/i18n');
assert.ok(js.includes("api.invoke('i18n:get')") && /await loadI18n\(\);[^\n]*\r?\n\s*await loadSettings\(\);/.test(js), 'i18n load trước render đầu');
assert.ok(js.includes("id=\"sLang\"") && js.includes('language: e.target.value'), 'Settings › Chung có chọn ngôn ngữ');
const keys = [...js.matchAll(/\bt\('(desktop\.[\w.]+)'[,)]/g), ...html.matchAll(/data-i18n(?:-\w+)?="(desktop\.[\w.]+)"/g)].map((m) => m[1]);
const { en } = await import('../out/prototype/src/i18n/en.js');
assert.deepEqual(keys.filter((k) => !(k in en)), [], 'key renderer không có trong en.ts');
console.log(`✓ i18n: không còn chuỗi tiếng Việt hardcode (app.js, index.html, main/*.ts); ${new Set(keys).size} key tĩnh đều có trong dict`);
// i18n: hàm dịch global `t` không được bị shadow (biến/param tên t) — từng làm send() chat crash ngầm
{
  const lines = readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8').split('\n').map((l) => l.replace(/\/\/.*$/, ''));
  const bad = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /\b(?:const|let|var)\s+t\s*=|\(\s*t\s*[,)]|(?:^|[^\w.])t\s*=>/.test(l) && !/^\s*const t = \(key/.test(l)).map(([n]) => n);
  assert.deepEqual(bad, [], `app.js shadow hàm t() ở dòng: ${bad}`);
  console.log('✓ không shadow t()');
}

// approval inline (không modal), permission mode, màn chat trống
{
  const ipc = readFileSync(new URL('ipc.ts', mainDir), 'utf8');
  assert.ok(!ipc.includes('showMessageBox'), 'ipc.ts không còn dialog.showMessageBox cho approval');
  assert.ok(js.includes("api.invoke('approval:respond'") && js.includes("api.invoke('approval:pending')") && js.includes("on('approval:request'") && js.includes("on('approval:focus'"), 'approval card + pending redraw + focus');
  assert.ok(/e\.key === 'Enter'[^\n]*answerApproval\(r\.id, true\)/.test(js) && /e\.key === 'Escape'\) answerApproval\(r\.id, false\)/.test(js), 'Enter/Esc trên card');
  assert.ok(html.includes('id="approvalBadge"') && html.includes('id="cbMode"') && html.includes('id="modeMenu"') && html.includes('id="stMode"'), 'badge + mode selector + statusbar mode');
  assert.ok(['emptyHero', 'emptyCtx', 'emptyChips'].every((x) => html.includes(`id="${x}"`)) && html.includes('assets/icon.png" alt="" />') && js.includes("classList.toggle('chat-empty'"), 'empty state');
  assert.equal((html.match(/id="chatInput"/g) || []).length, 1, 'chỉ 1 #chatInput (không copy)');
  for (const m of ['plan', 'ask', 'auto', 'full']) for (const k of [`desktop.mode.${m}`, `desktop.mode.${m}Desc`]) assert.ok(k in en, `key ${k}`);
  for (const k of ['merge', 'policy', 'repo', 'plan', 'risk']) assert.ok(`desktop.approval.kind.${k}` in en, `key kind.${k}`);
  console.log('✓ approval card inline (không showMessageBox), mode selector, empty state, i18n key đủ');
}

// fleet: Settings/Dashboard vẽ ngay, không await fleet probe; fleet:changed vá; nút Refresh → fleet:refresh
{
  const fn = (name) => js.slice(js.indexOf(`async function ${name}`), js.indexOf('\n}\n', js.indexOf(`async function ${name}`)));
  for (const name of ['renderSettings', 'renderDashboard']) assert.ok(!/await[^;\n]*loadFleet\(\)/.test(fn(name)), `${name} không await loadFleet`);
  assert.ok(js.includes("on('fleet:changed'") && js.includes("'fleet:changed'") && js.includes("api.invoke('fleet:refresh')") && js.includes('id="wRefresh"'), 'fleet:changed + Refresh');
  console.log('✓ fleet: vẽ không chờ probe, fleet:changed, nút Refresh');
}

// spacing nút: nút không tự có margin, .row (gap + --space-3) quyết định; không còn inline margin
{
  const css = readFileSync(new URL('styles.css', dir), 'utf8');
  const btn = css.match(/\nbutton \{([^}]*)\}/)[1];
  assert.ok(/margin: 0;/.test(btn) && !/margin-top/.test(btn), 'button base: margin 0, không margin-top');
  assert.ok(/border: 1px solid transparent/.test(btn), 'primary có border trong suốt = cao bằng .secondary');
  assert.ok(/\.row \{[^}]*gap: var\(--space-2\)/.test(css) && /\* \+ \.row \{ margin-top: var\(--space-3\); \}/.test(css), '.row dùng gap + margin-top chung');
  assert.ok(!/margin-top: 10px/.test(css.slice(css.indexOf('/* ---------- forms'), css.indexOf('/* ---------- chat'))),'không còn margin-top: 10px lẻ cho nút');
  assert.ok(!/style="[^"]*margin/.test(js) && !js.includes('chatbar'), 'app.js không còn inline style margin');
  console.log('✓ spacing nút: margin 0, .row gap/margin-top theo thang --space, không inline margin');
}

console.log('RENDERER TEST PASS ✓');

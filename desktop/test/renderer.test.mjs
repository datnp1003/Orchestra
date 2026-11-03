// Renderer static check — plain node: CSP (script-src 'self') blocks inline handlers, esc() must be attribute-safe
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../src/renderer/', import.meta.url);
const js = readFileSync(new URL('app.js', dir), 'utf8');
const html = readFileSync(new URL('index.html', dir), 'utf8');

for (const [name, src] of [['app.js', js], ['index.html', html]]) {
  const hit = src.match(/\son[a-z]+\s*=\s*["']/i);
  assert.equal(hit, null, `${name}: inline handler blocked by CSP: ${hit?.[0]}`);
}
console.log('✓ no inline on*= handlers');

const line = js.split(/\r?\n/).find((l) => l.startsWith('const esc ='));
assert.ok(line, 'const esc not found');
const esc = new Function(`${line}; return esc;`)();
const out = esc(`a"b'<c>&`);
assert.equal(out, 'a&quot;b&#39;&lt;c&gt;&amp;');
assert.ok(!/["'<>]/.test(out), 'esc left dangerous characters');
assert.equal(esc(null), '');
console.log('✓ esc attribute-safe:', out);

assert.ok(!js.includes("addEventListener('message'"), 'message listener (leak) must be removed');
console.log('✓ no window message listener');

// M1: chat has no worker picker; Orchestra model only
assert.ok(!html.includes('cbWorker') && !js.includes('cbWorker'), 'composer no longer picks a worker');
assert.ok(html.includes('id="cbModel"') && js.includes("'brain:models'"), 'composer has Orchestra model from brain:models');
assert.ok(!js.includes('orchestratorWorker'), 'renderer does not use old CLI brain');
console.log('✓ composer: Orchestra model picker only');
assert.ok(html.includes('id="chatStop"') && js.includes("'chat:cancel'"), 'composer has Stop button → chat:cancel');
console.log('✓ composer: Stop button');

// R2a: Providers tab replaces Vault; key input is password, no vault/brain:config channels
assert.ok(js.includes("['providers', 'Providers']") && !js.includes("'vault'"), 'Providers tab replaces Vault');
for (const c of ["'brain:config'", "'vault:set'", "'vault:delete'"]) assert.ok(!js.includes(c), `renderer does not call ${c}`);
assert.ok(/id="prKey" type="password"/.test(js), 'key input type=password');
assert.ok(!js.includes('providers:import') && !js.includes('prImport'), 'Import from claude/codex config removed');
for (const l of ['＋ Anthropic API', '＋ OpenAI API', '＋ Anthropic Compatible', '＋ OpenAI Compatible', 'Claude Code (Claude Pro/Max)', 'OpenAI Codex (ChatGPT Plus/Pro)', 'desktop.pr.connected']) {
  assert.ok(js.includes(l), `quick-add: ${l}`);
}
console.log('✓ Providers tab: password key, quick-add, no import/vault/brain:config');

// UI feedback: sessions replace recent Tasks; compact nav; Dashboard right above Settings; Matrix in Settings
assert.ok(js.includes("'chat:sessions'") && js.includes("'chat:open'"), 'sidebar has sessions');
assert.ok(!html.includes('Tasks gần đây') && !html.includes('sideTaskList') && !js.includes('loadSideTasks'), 'recent Tasks removed');
assert.ok(html.includes('data-i18n="desktop.newChat.label"') && !html.includes('Task mới'), 'New chat button');
assert.ok(!js.includes('data-auth') && !/>Auth</.test(js), 'worker Auth button removed');
assert.ok(js.includes('desktop.w.authRouter') && js.includes('f.display'), 'worker has name + router auth line');
assert.ok(!html.includes('href="#/terminal"') && !html.includes('href="#/matrix"'), 'Terminal + Policy Matrix no longer in nav');
assert.ok(js.includes("['matrix', 'Policy Matrix']"), 'Policy Matrix is a Settings tab');
assert.ok(!html.includes('<nav id="nav">'), 'Chat nav removed (New chat is the entry point)');
assert.ok(!html.includes('href="#/transcript"'), 'no Transcript link');
const foot = html.slice(html.indexOf('id="sideFooter"'));
assert.ok(foot.indexOf('href="#/dashboard"') > 0 && foot.indexOf('href="#/dashboard"') < foot.indexOf('id="btnSettings"'), 'Dashboard right above Settings');
console.log('✓ sidebar: New chat, Dashboard above Settings; Matrix tab; no Auth/Import/Terminal/Transcript');

// Projects: sidebar order New chat → PROJECTS → CHATS → footer; no repo picker / repo tag
const order = ['id="newChat"', 'id="sideProjects"', 'id="sideChats"', 'id="sideFooter"'].map((s) => html.indexOf(s));
assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), `sidebar order: ${order}`);
assert.ok(html.includes('id="newProject"') && js.includes("'project:create'"), 'PROJECTS header has ＋ → project:create');
for (const s of ['repoPick', 'repoSel', 'repoLabel', 'session-repo', 'sRepos', 'sAddRepo', "'repo:add'", "'repo:set-active'", 'sideSessionList']) {
  assert.ok(!html.includes(s) && !js.includes(s), `${s} removed`);
}
assert.ok(js.includes("api.invoke('chat:open', { projectId, id })") && js.includes("api.invoke('chat:new', { projectId: projectId ?? null })") && !js.includes("'chat:reset'"), 'chat:open/chat:new per project');
assert.ok(js.includes("localStorage.setItem('orchestra.collapsed'") && js.includes('data-new-in=') && js.includes('proj-badge'), 'group project: collapse (localStorage), ＋ chat, badge repo');
assert.ok(js.includes("'#/project/'") && js.includes('function renderProject') && ['project:get', 'project:rename', 'project:addRepo', 'project:removeRepo', 'project:delete'].every((c) => js.includes(`'${c}'`)), 'Project page');
assert.ok(/if \(!confirm\(t\('desktop\.project\.confirmDelete'/.test(js), 'deleting a project requires confirm');
assert.ok(js.includes("renderMemoryEditor($('#globalMemory'), null)") && js.includes("renderMemoryEditor($('#pjMemory'), id)") && js.includes("'memory:set'"), 'memory editor: global (Settings) + project');
assert.ok(html.includes('id="pageRepo"') && js.includes("t('desktop.chat.global')"), 'header: project name or Chat');
console.log('✓ projects: sidebar PROJECTS/CHATS, collapse, Project page, memory editor; no repoPick/repo tag');

// Transcript is a Dashboard section; old #/transcript → dashboard; top 20 (main limits via limit)
const dash = js.slice(js.indexOf('async function renderDashboard'), js.indexOf('// ---------- Transcript'));
assert.ok(dash.includes('id="transcript"') && dash.includes("renderTranscript($('#transcript'), tasks)"), 'Dashboard contains Transcript section');
assert.ok(/if \(hash === 'transcript'\) \{ openTranscript = true; location\.hash = '#\/dashboard'/.test(js) && !/transcript: renderTranscript/.test(js), '#/transcript → #/dashboard');
assert.ok(/const TOP_N = 20;/.test(js) && dash.includes("api.invoke('tasks:list', { limit: TOP_N })"), 'tasks:list limit 20');
console.log('✓ Transcript in Dashboard, #/transcript redirect, top 20');

// R3: OAuth — red warning + required checkbox before save/login
assert.ok(js.includes("'oauth-anthropic', 'OAuth Anthropic (Claude Pro/Max)'") && js.includes("'oauth-openai', 'OAuth OpenAI (ChatGPT Plus/Pro)'"), 'OAuth kinds have labels');
assert.ok(/id="prRisk" class="risk"/.test(js) && js.includes("t('desktop.pr.risk' + i)"), 'warning box');
assert.ok(js.includes(`id="prRiskOk" /> \${esc(t('desktop.pr.riskOk'))}`) && /!\$\('#prRiskOk'\)\.checked/.test(js), '"I understand the risk" checkbox blocks saving');
assert.ok(js.includes("'oauth:start'") && js.includes("'oauth:finish'") && js.includes('OAuth ⚠'), 'Login button + badge');
assert.ok(!/\.(access|refresh)\b/.test(js), 'renderer never touches tokens');
console.log('✓ OAuth: warning + required checkbox + login, no tokens');

// Skills: Settings tab (global) + Project card; old skill-sync removed; remove requires confirm; renderer sends no path
for (const c of ['list', 'save', 'remove', 'previewGithub', 'previewLocal', 'install', 'checkUpdate', 'update', 'cancelPreview']) assert.ok(js.includes(`'skills:${c}'`), `renderer calls skills:${c}`);
assert.ok(!js.includes("'skills:sync'") && !js.includes('sSync') && !js.includes('skillSync'), 'old skill-sync removed');
assert.ok(js.includes("renderSkills($('#skillsBox'), null)") && js.includes("renderSkills($('#pjSkills'), id)"), 'Skills: Settings global + Project card');
assert.ok(/if \(!confirm\(t\('desktop\.skills\.confirmRemove'/.test(js), 'removing a skill requires confirm');
const sk = js.slice(js.indexOf('async function renderSkills'), js.indexOf('// ---------- Memory editor'));
assert.ok(!/\bpath\s*:/.test(sk) && !/dir\s*:/.test(sk), 'Skills renderer sends no filesystem path');
assert.ok(sk.includes("t('desktop.skills.warn.' + w.code") && sk.includes("t('desktop.skills.err.' + it.error)"), 'preview shows warning/error');
const { en: enDict } = await import('../out/prototype/src/i18n/en.js');
for (const k of ['script', 'large', 'suspicious']) assert.ok(`desktop.skills.warn.${k}` in enDict, `key warn.${k}`);
for (const k of ['symlink', 'tooBig', 'invalid', 'duplicate']) assert.ok(`desktop.skills.err.${k}` in enDict, `key err.${k}`);
console.log('✓ Skills: 9 channels, Settings + Project, confirm remove, warning/error keys exist, no path sent');

// i18n: UI strings live only in the dictionary — no Vietnamese characters outside comments
const VI = /[ăâđêôơưàáạảãầấậẩẫằắặẳẵèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;
// ponytail: regex comment stripping — doesn't understand '//' inside strings (e.g. 'https://…'); such strings only make the scan miss the rest, never false-positive
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const viHits = (name, s) => s.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => VI.test(l)).map(([n, l]) => `${name}:${n}: ${l.trim()}`);
const mainDir = new URL('../src/main/', import.meta.url);
const hits = [
  ...viHits('app.js', stripJs(js)),
  ...viHits('index.html', html.replace(/<!--[\s\S]*?-->/g, '')),
  ...readdirSync(mainDir).filter((f) => f.endsWith('.ts')).flatMap((f) => viHits(f, stripJs(readFileSync(new URL(f, mainDir), 'utf8')))),
];
assert.deepEqual(hits, [], 'hardcoded Vietnamese strings — move them to prototype/src/i18n');
assert.ok(js.includes("api.invoke('i18n:get')") && /await loadI18n\(\);[^\n]*\r?\n\s*await loadSettings\(\);/.test(js), 'i18n loaded before first render');
assert.ok(js.includes("id=\"sLang\"") && js.includes('language: e.target.value'), 'Settings › General has language picker');
const keys = [...js.matchAll(/\bt\('(desktop\.[\w.]+)'[,)]/g), ...html.matchAll(/data-i18n(?:-\w+)?="(desktop\.[\w.]+)"/g)].map((m) => m[1]);
const { en } = await import('../out/prototype/src/i18n/en.js');
assert.deepEqual(keys.filter((k) => !(k in en)), [], 'renderer keys missing from en.ts');
console.log(`✓ i18n: no hardcoded Vietnamese strings (app.js, index.html, main/*.ts); all ${new Set(keys).size} static keys are in the dict`);
// i18n: the global translate fn `t` must not be shadowed (var/param named t) — once silently crashed chat send()
{
  const lines = readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8').split('\n').map((l) => l.replace(/\/\/.*$/, ''));
  const bad = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /\b(?:const|let|var)\s+t\s*=|\(\s*t\s*[,)]|(?:^|[^\w.])t\s*=>/.test(l) && !/^\s*const t = \(key/.test(l)).map(([n]) => n);
  assert.deepEqual(bad, [], `app.js shadows t() at lines: ${bad}`);
  console.log('✓ t() not shadowed');
}

// inline approval (no modal), permission mode, empty chat screen
{
  const ipc = readFileSync(new URL('ipc.ts', mainDir), 'utf8');
  assert.ok(!ipc.includes('showMessageBox'), 'ipc.ts no longer uses dialog.showMessageBox for approval');
  assert.ok(js.includes("api.invoke('approval:respond'") && js.includes("api.invoke('approval:pending')") && js.includes("on('approval:request'") && js.includes("on('approval:focus'"), 'approval card + pending redraw + focus');
  assert.ok(/e\.key === 'Enter'[^\n]*answerApproval\(r\.id, true\)/.test(js) && /e\.key === 'Escape'\) answerApproval\(r\.id, false\)/.test(js), 'Enter/Esc on card');
  assert.ok(html.includes('id="approvalBadge"') && html.includes('id="cbMode"') && html.includes('id="modeMenu"') && html.includes('id="stMode"'), 'badge + mode selector + statusbar mode');
  assert.ok(['emptyHero', 'emptyCtx', 'emptyChips'].every((x) => html.includes(`id="${x}"`)) && html.includes('assets/icon.png" alt="" />') && js.includes("classList.toggle('chat-empty'"), 'empty state');
  assert.equal((html.match(/id="chatInput"/g) || []).length, 1, 'only 1 #chatInput (no copy)');
  for (const m of ['plan', 'ask', 'auto', 'full']) for (const k of [`desktop.mode.${m}`, `desktop.mode.${m}Desc`]) assert.ok(k in en, `key ${k}`);
  for (const k of ['merge', 'policy', 'repo', 'plan', 'risk']) assert.ok(`desktop.approval.kind.${k}` in en, `key kind.${k}`);
  console.log('✓ inline approval card (no showMessageBox), mode selector, empty state, i18n keys complete');
}

// fleet: Settings/Dashboard render immediately, no await on fleet probe; fleet:changed patches; Refresh button → fleet:refresh
{
  const fn = (name) => js.slice(js.indexOf(`async function ${name}`), js.indexOf('\n}\n', js.indexOf(`async function ${name}`)));
  for (const name of ['renderSettings', 'renderDashboard']) assert.ok(!/await[^;\n]*loadFleet\(\)/.test(fn(name)), `${name} does not await loadFleet`);
  assert.ok(js.includes("on('fleet:changed'") && js.includes("'fleet:changed'") && js.includes("api.invoke('fleet:refresh')") && js.includes('id="wRefresh"'), 'fleet:changed + Refresh');
  console.log('✓ fleet: renders without waiting for probe, fleet:changed, Refresh button');
}

// button spacing: buttons have no own margin, .row (gap + --space-3) decides; no inline margin
{
  const css = readFileSync(new URL('styles.css', dir), 'utf8');
  const btn = css.match(/\nbutton \{([^}]*)\}/)[1];
  assert.ok(/margin: 0;/.test(btn) && !/margin-top/.test(btn), 'button base: margin 0, no margin-top');
  assert.ok(/border: 1px solid transparent/.test(btn), 'primary has transparent border = same height as .secondary');
  assert.ok(/\.row \{[^}]*gap: var\(--space-2\)/.test(css) && /\* \+ \.row \{ margin-top: var\(--space-3\); \}/.test(css), '.row uses gap + shared margin-top');
  assert.ok(!/margin-top: 10px/.test(css.slice(css.indexOf('/* ---------- forms'), css.indexOf('/* ---------- chat'))),'no stray margin-top: 10px on buttons');
  assert.ok(!/style="[^"]*margin/.test(js) && !js.includes('chatbar'), 'app.js has no inline style margin');
  console.log('✓ button spacing: margin 0, .row gap/margin-top on the --space scale, no inline margin');
}

console.log('RENDERER TEST PASS ✓');

// Orchestra Desktop — renderer (vanilla, không framework)
// Bố cục agent-first: Chat là màn hình chính (composer ở đáy), Dashboard/Fleet là panel phụ.
const api = window.orchestra ?? devStub(); // stub chỉ dùng khi chạy renderer ngoài Electron (dev/preview)
const page = document.getElementById('page');
const composerWrap = document.getElementById('composerWrap');
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const split = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------- i18n: dict desktop.* từ main (i18n:get); cùng ngữ nghĩa t() của prototype/src/i18n ----------
let I18N = { locale: 'en', dict: {} };
const t = (key, params) => {
  const s = I18N.dict[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s;
};
async function loadI18n() {
  I18N = await api.invoke('i18n:get');
  document.documentElement.lang = I18N.locale;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}

let SETTINGS = null;
let FLEET = [];
let MODELS = { models: [], byWorker: {} };
let BRAIN_MODELS = []; // model của Orchestra brain (router /v1/models)

// ---------- event bus: đăng ký listener đúng 1 lần, route mới chỉ gắn handler ----------
const handlers = {};
for (const ch of ['dispatch:event', 'pipeline:log', 'install:log', 'chat:message', 'chat:step', 'terminal:data', 'terminal:exit', 'update:status', 'nav']) {
  api.on(ch, (d) => handlers[ch]?.(d));
}
const on = (ch, fn) => { handlers[ch] = fn; };

// ---------- dữ liệu chung ----------
async function loadSettings() {
  SETTINGS = await api.invoke('settings:get');
  renderChrome();
  return SETTINGS;
}
async function loadFleet() {
  FLEET = await api.invoke('fleet:list');
  renderChrome();
  return FLEET;
}
async function loadModels() {
  MODELS = await api.invoke('models:list');
  renderChrome();
  return MODELS;
}
async function loadBrainModels() {
  BRAIN_MODELS = (await api.invoke('brain:models')).models || [];
  renderChrome();
}
// <option> model: '' = mặc định; worker rỗng (auto) = toàn bộ model router; model worker không chạy được → disabled + lý do
function modelOptions(worker, cur, defLabel) {
  const list = worker ? MODELS.byWorker[worker] || [] : MODELS.models.map((id) => ({ id, ok: true, reason: '' }));
  return `<option value="">${esc(defLabel)}</option>` + list.map((m) =>
    `<option value="${esc(m.id)}" title="${esc(m.reason)}" ${m.id === cur ? 'selected' : ''} ${m.ok ? '' : 'disabled'}>${esc(m.id)}</option>`).join('');
}
// session đang mở: projectId null = chat ngoài project (chỉ global memory)
let CHAT = { projectId: null, projectName: '' };
const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const fleetInstalled = () => FLEET.filter((f) => f.installed).length;
// 1 nguồn màu cho mọi chỗ hiện fleet: có worker = xanh, không có = xám
const fleetDot = (n) => (n ? 'ok' : '');

// project/repo của session: statusbar luôn hiện; header chỉ khi đang ở Chat
function renderRepo() {
  const r = CHAT.projectId ? SETTINGS?.activeRepo || '' : '';
  $('#stRepo').textContent = CHAT.projectId ? `${CHAT.projectName} · repo: ${baseName(r) || '—'}` : t('desktop.chat.global');
  $('#stRepo').title = r;
  const onChat = !location.hash || location.hash.startsWith('#/chat');
  $('#pageRepo').textContent = onChat ? CHAT.projectName || t('desktop.chat.global') : '';
  $('#pageRepo').title = onChat ? r : '';
}

function renderChrome() {
  renderRepo();
  // fleet pill
  const pill = $('#fleetPill');
  if (pill && FLEET.length) {
    const n = fleetInstalled();
    pill.innerHTML = `<span class="dot ${fleetDot(n)}"></span>${n}/${FLEET.length} workers`;
  }
  // statusbar
  $('#stWorker').textContent = `Orchestra · model: ${SETTINGS?.brainModel || '—'}`;
  // composer: chỉ chọn model Orchestra — worker do Orchestra điều phối, user không chọn ở chat
  if (SETTINGS) {
    const cur = SETTINGS.brainModel;
    $('#cbModel').innerHTML = `<option value="">${esc(t('desktop.composer.pickModel'))}</option>` + [...new Set([cur, ...BRAIN_MODELS].filter(Boolean))]
      .map((id) => `<option value="${esc(id)}" ${id === cur ? 'selected' : ''}>${esc(id)}</option>`).join('');
  }
}

// ---------- Sessions (hội thoại đã lưu — click để resume) ----------
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? t('desktop.time.now') : s < 3600 ? t('desktop.time.minutes', { n: Math.floor(s / 60) })
    : s < 86400 ? t('desktop.time.hours', { n: Math.floor(s / 3600) }) : t('desktop.time.days', { n: Math.floor(s / 86400) });
};
// collapsed project groups — chỉ là trạng thái UI, lưu localStorage
const COLLAPSED = new Set(JSON.parse(localStorage.getItem('orchestra.collapsed') || '[]'));
const sessionItem = (x, projectId) => `
    <div class="session-item ${x.active ? 'active' : ''}" data-session="${esc(x.id)}" data-project="${esc(projectId ?? '')}" title="${esc(t('desktop.sessions.tooltip', { title: x.title, n: x.turns }))}">
      <span class="session-title">${esc(x.title)}</span>
      <span class="session-time">${esc(ago(x.updatedAt))}</span>
    </div>`;
const emptyLine = (key) => `<div class="side-empty">${esc(t(key))}</div>`;
async function loadSessions() {
  const v = await api.invoke('chat:sessions');
  const curProject = location.hash.startsWith('#/project/') ? decodeURIComponent(location.hash.slice('#/project/'.length)) : '';
  $('#sideProjects').innerHTML = v.projects.map((p) => `
    <div class="proj" data-proj="${esc(p.id)}">
      <div class="proj-head">
        <button class="proj-toggle" data-toggle="${esc(p.id)}">${COLLAPSED.has(p.id) ? '▶' : '▼'}</button>
        <span class="proj-name ${p.id === curProject ? 'active' : ''}" data-open-project="${esc(p.id)}" title="${esc(p.name)}">${esc(p.name)}</span>
        <span class="proj-badge" title="${esc(p.repos.join('\n'))}">${esc(t('desktop.projects.repoCount', { n: p.repos.length }))}</span>
        <button class="side-plus" data-new-in="${esc(p.id)}" title="${esc(t('desktop.projects.newChatIn', { name: p.name }))}">＋</button>
      </div>
      <div class="proj-sessions" ${COLLAPSED.has(p.id) ? 'hidden' : ''}>${p.sessions.map((x) => sessionItem(x, p.id)).join('') || emptyLine('desktop.sessions.empty')}</div>
    </div>`).join('') || emptyLine('desktop.projects.empty');
  $('#sideChats').innerHTML = v.chats.map((x) => sessionItem(x, null)).join('') || emptyLine('desktop.sessions.empty');
  document.querySelectorAll('#sideLists [data-session]').forEach((el) => { el.onclick = () => openSession(el.dataset.project || null, el.dataset.session); });
  document.querySelectorAll('#sideLists [data-new-in]').forEach((el) => { el.onclick = () => startChat(el.dataset.newIn); });
  document.querySelectorAll('#sideLists [data-open-project]').forEach((el) => { el.onclick = () => { location.hash = '#/project/' + encodeURIComponent(el.dataset.openProject); }; });
  document.querySelectorAll('#sideLists [data-toggle]').forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.toggle;
      if (!COLLAPSED.delete(id)) COLLAPSED.add(id);
      localStorage.setItem('orchestra.collapsed', JSON.stringify([...COLLAPSED]));
      loadSessions();
    };
  });
}
let openedMsgs = null; // tin nhắn của session vừa mở — renderChat vẽ 1 lần
const showChat = () => {
  if (location.hash.startsWith('#/chat') || !location.hash) route();
  else location.hash = '#/chat';
  loadSessions();
};
async function openSession(projectId, id) {
  const r = await api.invoke('chat:open', { projectId, id });
  if (!r.ok) return alert('✗ ' + r.error);
  openedMsgs = r.messages;
  CHAT = { projectId: r.projectId, projectName: r.projectName || '' };
  await loadSettings(); // activeRepo theo project của session
  showChat();
}
async function startChat(projectId) {
  const r = await api.invoke('chat:new', { projectId: projectId ?? null });
  if (!r.ok) return alert('✗ ' + r.error);
  openedMsgs = null;
  CHAT = { projectId: r.projectId, projectName: r.projectName || '' };
  await loadSettings();
  showChat();
}
// tạo project: ô nhập ngay dưới header (Electron không có prompt())
$('#newProject').onclick = () => {
  const box = $('#newProjectName');
  box.hidden = !box.hidden;
  if (!box.hidden) box.focus();
};
$('#newProjectName').addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') { e.target.hidden = true; return; }
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  const r = await api.invoke('project:create', { name: e.target.value });
  if (!r.ok) return alert('✗ ' + r.error);
  e.target.value = '';
  e.target.hidden = true;
  await loadSettings();
  location.hash = '#/project/' + encodeURIComponent(r.project.id);
  loadSessions();
});

// ---------- chrome clicks ----------
document.getElementById('newChat').onclick = () => startChat(null);
document.getElementById('newChatPlus').onclick = () => startChat(null);
document.getElementById('btnSettings').onclick = () => {
  settingsTab = 'chung';
  if (!location.hash.includes('#/settings')) location.hash = '#/settings';
};
$('#fleetPill').onclick = () => { location.hash = '#/dashboard'; route(); };
// đổi model Orchestra → lưu ngay (main reset hội thoại)
$('#cbModel').addEventListener('change', async (e) => {
  SETTINGS = await api.invoke('settings:set', { ...SETTINGS, brainModel: e.target.value });
  renderChrome();
  if (location.hash.startsWith('#/chat') || !location.hash) renderChat();
  loadSessions();
});
$('#cbNew').addEventListener('click', () => startChat(CHAT.projectId)); // chat mới cùng project

function logLine(s) {
  const el = $('#log');
  if (!el) return;
  el.textContent += s + '\n';
  el.scrollTop = el.scrollHeight;
}

// ---------- Chat (màn hình chính) ----------
async function renderChat() {
  composerWrap.hidden = false;
  page.classList.add('fill');
  page.innerHTML = `<div id="chatMsgs" class="chat-scroll"></div>`;
  const add = (cls, text) => {
    const d = document.createElement('div');
    d.className = 'm ' + cls;
    d.textContent = text;
    $('#chatMsgs').appendChild(d);
    $('#chatMsgs').scrollTop = $('#chatMsgs').scrollHeight;
    return d;
  };
  add('greet', t('desktop.chat.greet'));
  for (const m of openedMsgs ?? []) add(m.role, m.text);
  openedMsgs = null;
  const input = $('#chatInput');
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    add('user', text);
    add('orch pending', t('desktop.chat.pending'));
    const stop = $('#chatStop');
    stop.hidden = false;
    try {
      await api.invoke('chat:exchange', { text });
    } finally {
      stop.hidden = true;
      loadSessions();
    }
  };
  $('#chatSend').onclick = send;
  $('#chatStop').onclick = () => api.invoke('chat:cancel');
  // gán property (không addEventListener): #chatInput sống qua các lần render → tránh gửi trùng
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  };
  // chèn trước bubble pending để '…đang xử lý' luôn ở cuối
  const addStep = (cls, text) => {
    const d = add(cls, text);
    d.title = text; // dòng step bị ellipsis — hover xem đủ
    const pending = $('#chatMsgs .pending');
    if (pending) $('#chatMsgs').appendChild(pending);
    return d;
  };
  let progressBox = null; // tiến độ worker của tool call hiện tại — giữ 5 dòng cuối
  on('chat:step', (s) => {
    if (!$('#chatMsgs')) return; // memory step nền có thể tới khi đã rời Chat
    if (s.kind === 'progress') {
      progressBox ??= addStep('progress', '');
      const line = document.createElement('div');
      line.textContent = s.text;
      line.title = s.text;
      progressBox.appendChild(line);
      while (progressBox.childElementCount > 5) progressBox.firstElementChild.remove();
      $('#chatMsgs').scrollTop = $('#chatMsgs').scrollHeight;
      return;
    }
    progressBox = null;
    if (s.kind === 'tool_call') addStep('step', `⚙ ${s.name} ${JSON.stringify(s.input ?? {}).slice(0, 160)}`);
    else if (s.kind === 'tool_result') addStep(s.ok ? 'step' : 'step err', `${s.ok ? '✓' : '✗'} ${s.name}: ${s.preview}`);
    else if (s.kind === 'text') addStep('orch', s.text);
    else if (s.kind === 'memory') addStep('step', s.text);
    else addStep('step err', `✗ ${s.text}`);
  });
  on('chat:message', (m) => {
    const pending = $('#chatMsgs .pending');
    if (pending) pending.remove(); // kể cả 'result' lỗi (vd. chưa chọn repo)
    add(m.kind, m.text);
  });
  input.focus();
}

// ---------- Dashboard ----------
async function renderDashboard() {
  composerWrap.hidden = true;
  page.classList.remove('fill');
  const [, tasks] = await Promise.all([loadFleet(), api.invoke('tasks:list', { limit: TOP_N }), loadSettings()]);
  page.innerHTML = `
    <h2>Dashboard</h2>
    <div class="card"><h3>Fleet</h3>
      <table><thead><tr><th></th><th>worker</th><th>version</th><th>auth</th><th>conformance</th></tr></thead>
      <tbody>${FLEET.map((f) => `<tr><td><span class="dot ${f.installed ? 'ok' : 'err'}"></span></td><td>${esc(f.id)}</td><td class="mono">${esc(f.version ?? '-')}</td><td>${esc(f.auth)}</td><td>${esc(f.conformance ?? '-')}</td></tr>`).join('')}</tbody>
      </table>
      <button class="secondary" id="btnToWizard">${esc(t('desktop.dash.toWizard'))}</button>
    </div>
    <div class="grid2">
      <div class="card"><h3>Dispatch task</h3>
        <label>Goal</label><textarea id="dGoal" rows="2" placeholder="${esc(t('desktop.dash.goalPlaceholder'))}"></textarea>
        <label>${esc(t('desktop.dash.scopeGlob'))}</label><input id="dScope" value="src/payment/**" />
        <label>Worker</label><select id="dWorker"><option value="">auto (Role Policy)</option>${FLEET.filter((f) => f.installed).map((f) => `<option>${esc(f.id)}</option>`).join('')}</select>
        <label>Model</label><select id="dModel">${modelOptions('', '', t('desktop.dash.byPolicy'))}</select>
        <button id="dGo">Dispatch</button>
      </div>
      <div class="card"><h3>Run pipeline</h3>
        <label>Template</label><select id="pTpl"><option>feature-dev</option><option>hotfix</option></select>
        <label>Goal</label><textarea id="pGoal" rows="2"></textarea>
        <label>Scope</label><input id="pScope" value="src/payment/**" />
        <label>Model (implement + fixer)</label><select id="pModel">${modelOptions('', '', t('desktop.dash.byPolicy'))}</select>
        <button id="pGo">${esc(t('desktop.dash.runPipeline'))}</button>
      </div>
    </div>
    <div class="card"><h3>${esc(t('desktop.dash.tasksTitle', { n: TOP_N }))}</h3>
      <table><thead><tr><th>id</th><th>node</th><th>worker</th><th>exit</th><th>scope</th><th>files</th></tr></thead>
      <tbody>${tasks.map((k, i) => `<tr class="click-row" data-i="${i}"><td class="mono">${esc(k.id)}</td><td>${esc(k.node)}</td><td>${esc(k.worker)}</td><td>${k.exit ?? '-'}</td><td>${k.scopeOk ? '<span class="ok">OK</span>' : '<span class="err">VIOLATION</span>'}</td><td>${k.files}</td></tr>`).join('') || `<tr><td colspan="6" class="dim">${esc(t('desktop.common.none'))}</td></tr>`}</tbody>
      </table>
    </div>
    <div class="card" id="transcript"></div>`;
  renderTranscript($('#transcript'), tasks);
  if (openTranscript) { openTranscript = false; $('#transcript').scrollIntoView(); }
  $('#dWorker').onchange = () => { $('#dModel').innerHTML = modelOptions($('#dWorker').value, '', t('desktop.dash.byPolicy')); };
  $('#btnToWizard').onclick = () => { settingsTab = 'workers'; location.hash = '#/settings'; };
  $('#dGo').onclick = async () => {
    const goal = $('#dGoal').value.trim();
    if (!goal) return alert(t('desktop.dash.needGoal'));
    logLine('▶ dispatch: ' + goal);
    const r = await api.invoke('dispatch', { goal, scope: split($('#dScope').value), worker: $('#dWorker').value, model: $('#dModel').value });
    if (r.error) return logLine('✗ ' + r.error);
    logLine(`${r.result.ok ? '✓ OK' : '✗ FAILED'} ${r.result.taskId}${r.override && r.override.startsWith('override') ? ' — ' + r.override : ''}`);
  };
  $('#pGo').onclick = async () => {
    const goal = $('#pGoal').value.trim();
    if (!goal) return alert(t('desktop.dash.needGoal'));
    logLine('▶ pipeline: ' + goal);
    const r = await api.invoke('pipeline:run', { template: $('#pTpl').value, goal, scope: split($('#pScope').value), model: $('#pModel').value });
    if (r.error) return logLine('✗ ' + r.error);
    logLine(`${r.ok ? '✓ OK' : '✗ FAILED'} ${r.runId} merged=${r.merged}`);
  };
}

// ---------- Transcript (section trong Dashboard; #/transcript cũ → #/dashboard) ----------
const TOP_N = 20;
let openTranscript = false;
// tasks: top-N mới nhất (main đã giới hạn); click row ở bảng Task records → chọn task cho transcript
function renderTranscript(box, tasks) {
  box.innerHTML = `<h3>Transcript</h3><div id="trSel" class="dim">${esc(t('desktop.tr.hint'))}</div>
    <h3>${esc(t('desktop.tr.live'))}</h3><div id="log"></div>`;
  page.querySelectorAll('.click-row[data-i]').forEach((el) => {
    el.onclick = () => {
      const k = tasks[el.dataset.i];
      page.querySelectorAll('.click-row.sel').forEach((r) => r.classList.remove('sel'));
      el.classList.add('sel');
      $('#trSel').textContent = `${k.id} — ${k.node}/${k.worker} exit=${k.exit ?? '-'} scope=${k.scopeOk ? 'OK' : 'VIOLATION'} files=${k.files}`;
      box.scrollIntoView({ block: 'nearest' });
    };
  });
  on('dispatch:event', (d) => logLine(`[${d.t}] ${JSON.stringify(d.payload).slice(0, 160)}`));
  on('pipeline:log', (line) => logLine(line));
  on('install:log', (line) => logLine('[install] ' + line));
}

// ---------- Policy Matrix (tab trong Cài đặt) ----------
async function renderMatrix(box) {
  const d = await api.invoke('matrix:data');
  if (!d) {
    box.innerHTML = `<div class="card dim">${esc(t('desktop.mx.noRepo'))}</div>`;
    return;
  }
  const stat = (c) => (c.ema !== null ? `ema ${c.ema.toFixed(2)} · n=${c.n}` : c.n ? `n=${c.n} (< ${d.minSample})` : t('desktop.mx.noData'));
  const cell = (c, role) => (c
    ? `<td><button class="mx-cell" data-role="${esc(role)}" data-cli="${esc(c.cli)}" title="${esc(t(c.rank === 1 ? 'desktop.mx.isTop' : 'desktop.mx.promoteHint'))}" ${c.rank === 1 ? 'disabled' : ''}>
        <span class="mx-rank"><span class="dot ${c.rank === 1 ? 'ok' : ''}"></span>#${c.rank}${c.model ? ` <span class="mono dim">${esc(c.model)}</span>` : ''}</span><span class="mx-stat">${esc(stat(c))}</span></button></td>`
    : `<td><span class="mx-none">${esc(t('desktop.mx.unbound'))}</span></td>`);
  box.innerHTML = `
    <div class="card">
      <h3>Role × Worker</h3>
      <div class="dim mx-src">policy: <span class="mono">${esc(d.source)}</span> ${d.errors.length ? `<span class="err">⚠ ${esc(d.errors.join('; '))}</span>` : `<span class="ok">${esc(t('desktop.mx.valid'))}</span>`}</div>
      <table class="mx"><thead><tr><th>role</th>${d.workers.map((w) => `<th>${esc(w.display)}<div class="mx-id">${esc(w.id)}</div></th>`).join('')}</tr></thead>
      <tbody>${d.rows.map((r) => `<tr><td><b>${esc(r.role)}</b></td>${r.cells.map((c) => cell(c, r.role)).join('')}</tr>`).join('')}</tbody></table>
      <div class="dim mx-hint">${t('desktop.mx.hint', { file: '<span class="mono">.orchestra/policy.yml</span>' })}</div>
    </div>
    <div class="card">
      <h3>Project KB (${d.kb.length})</h3>
      ${d.kb.length ? `<table><thead><tr><th>id</th><th>title</th><th>scope</th><th>source</th><th></th></tr></thead><tbody>${d.kb.map((e) => `<tr><td class="mono">${esc(e.id)}</td><td>${esc(e.title)}</td><td class="mono">${esc(e.scope.join(', '))}</td><td>${esc(e.source)}</td><td>${e.pinned ? '📌' : ''}</td></tr>`).join('')}</tbody></table>` : `<div class="dim">${esc(t('desktop.mx.noKb'))}</div>`}
    </div>`;
  box.querySelectorAll('.mx-cell:not([disabled])').forEach((b) => b.addEventListener('click', async () => {
    const r = await api.invoke('matrix:promote', { role: b.dataset.role, cli: b.dataset.cli });
    if (!r.ok) alert(r.detail);
    renderMatrix(box);
  }));
}

// ---------- Cài đặt (1 nút duy nhất — gộp Settings + Setup Wizard, kiểu tab như ZCode) ----------
let settingsTab = 'chung';
async function renderSettings() {
  composerWrap.hidden = true;
  page.classList.remove('fill');
  const [s] = await Promise.all([loadSettings(), loadFleet()]);
  const TABS = [['chung', t('desktop.tab.general')], ['workers', 'Workers'], ['providers', 'Providers'], /* conformance: tạm ẩn theo yêu cầu (pane + IPC giữ nguyên, badge vẫn ở Dashboard) */ ['skills', 'Skills'], ['matrix', 'Policy Matrix']];
  const KINDS = [['anthropic', 'anthropic'], ['openai', 'openai'], ['anthropic-compatible', 'anthropic-compatible'], ['openai-compatible', 'openai-compatible'],
    ['oauth-anthropic', 'OAuth Anthropic (Claude Pro/Max)'], ['oauth-openai', 'OAuth OpenAI (ChatGPT Plus/Pro)']];
  const isOAuth = (k) => k.startsWith('oauth-');
  const FORMATS = ['messages', 'chat', 'responses'];
  const pane = (id, html) => `<div class="tabpane" id="tab-${id}" ${settingsTab === id ? '' : 'hidden'}>${html}</div>`;
  page.innerHTML = `
    <h2>${esc(t('desktop.page.settings'))}</h2>
    <div class="tabs">${TABS.map(([id, label]) => `<button class="tab ${settingsTab === id ? 'active' : ''}" data-tab="${id}">${esc(label)}</button>`).join('')}</div>
    ${pane('chung', `
      <div class="card">
        <label>${esc(t('desktop.set.language'))}</label>
        <select id="sLang">${['en', 'vi'].map((l) => `<option value="${l}" ${s.language === l ? 'selected' : ''}>${esc(t('desktop.lang.' + l))}</option>`).join('')}</select>
        <label>${esc(t('desktop.set.templatesDir'))}</label><input id="sTpl" value="${esc(s.templatesDir)}" />
        <label><input type="checkbox" id="sAuto" ${s.autoApprovePlan ? 'checked' : ''}/> ${esc(t('desktop.set.autoApprove'))}</label>
        <label><input type="checkbox" id="sHooks" ${s.hooksEnabled ? 'checked' : ''}/> Guard hook pre-execution</label>
        <label><input type="checkbox" id="sSync" ${s.skillSync ? 'checked' : ''}/> ${esc(t('desktop.set.skillSync'))}</label>
        <div class="row">
          <button id="sSave">${esc(t('desktop.common.save'))}</button>
          <button class="secondary" id="sUpdate">${esc(t('desktop.set.checkUpdate'))}</button>
          <span id="sUpdateOut" class="dim"></span>
        </div>
      </div>
      <div class="card" id="globalMemory"></div>`)}
    ${pane('workers', `
      <div class="card">
        <h3>Worker CLI (npm)</h3>
        ${FLEET.map((f) => `<div class="wizard-step">
          <span class="dot ${f.installed ? 'ok' : 'err'}"></span>
          <div><b>${esc(f.display || f.id)}</b> <span class="mono dim">${esc(f.id)}</span> <span class="dim">· ${esc(f.installed ? f.version ?? t('desktop.w.installed') : t('desktop.w.notInstalled'))}</span>
            <div class="dim">${esc(t(f.router ? 'desktop.w.authRouter' : 'desktop.w.noRouter'))}</div></div>
          <button class="secondary" data-install="${esc(f.id)}">${esc(t(f.installed ? 'desktop.w.reinstall' : 'desktop.w.install'))}</button>
        </div>`).join('')}
        <div id="log" style="margin-top:10px"></div>
      </div>`)}
    ${pane('providers', `
      <div class="card">
        <h3>Orchestra Router — providers</h3>
        <div class="dim">Router: <span id="rStatus">…</span></div>
        <table><thead><tr><th>id</th><th>kind</th><th>baseUrl</th><th>formats</th><th>${esc(t('desktop.pr.colEnabled'))}</th><th>key</th><th></th></tr></thead>
        <tbody id="prRows"></tbody></table>
        <div class="row"><span id="prOut" class="dim"></span></div>
        <div class="row" id="prCodeRow" hidden>
          <input id="prCode" placeholder="${esc(t('desktop.pr.codePlaceholder'))}" autocomplete="off" />
          <button id="prCodeOk">${esc(t('desktop.pr.confirm'))}</button>
        </div>
        <label>${esc(t('desktop.pr.defaultModel'))}</label>
        <select id="rDefault"></select>
      </div>
      <div class="card">
        <h3>${esc(t('desktop.pr.addEdit'))}</h3>
        <div class="quick-add" id="prQuickKey"></div>
        <div class="side-title">OAuth</div>
        <div class="quick-add" id="prQuickOAuth"></div>
        <label>id</label><input id="prId" placeholder="my-gw" autocomplete="off" />
        <label>kind</label><select id="prKind">${KINDS.map(([k, label]) => `<option value="${k}">${label}</option>`).join('')}</select>
        <div id="prRisk" class="risk" hidden>
          <b>${esc(t('desktop.pr.riskTitle'))}</b>
          <ul>${[1, 2, 3, 4, 5].map((i) => `<li>${esc(t('desktop.pr.risk' + i))}</li>`).join('')}</ul>
          <label><input type="checkbox" id="prRiskOk" /> ${esc(t('desktop.pr.riskOk'))}</label>
          <label>${esc(t('desktop.pr.models'))}</label><input id="prModels" autocomplete="off" />
        </div>
        <div id="prKeyed">
          <label>Base URL</label><input id="prUrl" placeholder="https://gw.company.com" />
          <label>${esc(t('desktop.pr.formats'))}</label>
          <div class="row">${FORMATS.map((f) => `<label><input type="checkbox" data-fmt="${f}" /> ${f}</label>`).join('')}</div>
          <label>${esc(t('desktop.pr.apiKey'))}</label><input id="prKey" type="password" autocomplete="off" />
        </div>
        <label><input type="checkbox" id="prOn" checked /> ${esc(t('desktop.pr.enabled'))}</label>
        <button id="prSave">${esc(t('desktop.common.save'))}</button>
      </div>`)}
    ${pane('conformance', `
      <div class="card">
        <h3>Conformance (Worker Protocol §10)</h3>
        <label>Worker</label><select id="cWorker">${FLEET.map((f) => `<option>${esc(f.id)}</option>`).join('')}</select>
        <button id="cRun">${esc(t('desktop.cf.run'))}</button>
        <div id="cOut" class="dim" style="margin-top:8px"></div>
      </div>`)}
    ${pane('skills', `
      <div class="card">
        <h3>Skills</h3>
        <button id="skSync">Sync KB → AGENTS.md + CLAUDE.md</button>
        <span id="skOut" class="dim" style="margin-left:8px"></span>
      </div>`)}
    ${pane('matrix', '<div id="matrixBox"></div>')}`;
  renderMatrix($('#matrixBox'));
  renderMemoryEditor($('#globalMemory'), null);
  // chuyển tab
  page.querySelectorAll('.tab').forEach((tb) => {
    tb.onclick = () => {
      settingsTab = tb.dataset.tab;
      page.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === tb));
      TABS.forEach(([id]) => { const el = document.getElementById('tab-' + id); if (el) el.hidden = id !== settingsTab; });
    };
  });
  // tab chung
  $('#sSave').onclick = async () => {
    const next = {
      ...s,
      templatesDir: $('#sTpl').value.trim(),
      autoApprovePlan: $('#sAuto').checked,
      hooksEnabled: $('#sHooks').checked,
      skillSync: $('#sSync').checked,
    };
    await api.invoke('settings:set', next);
    await loadSettings();
    alert(t('desktop.common.saved'));
    route();
  };
  // đổi ngôn ngữ → lưu ngay (main setLocale) + vẽ lại, không restart
  $('#sLang').onchange = async (e) => {
    SETTINGS = await api.invoke('settings:set', { ...SETTINGS, language: e.target.value });
    await loadI18n();
    renderChrome();
    loadSessions();
    route();
  };
  $('#sUpdate').onclick = async () => {
    $('#sUpdateOut').textContent = t('desktop.set.checking');
    on('update:status', (d) => {
      $('#sUpdateOut').textContent = d.status === 'downloaded' ? t('desktop.set.updateReady', { version: d.version }) : d.status;
    });
    await api.invoke('update:check');
    setTimeout(() => { if ($('#sUpdateOut')) $('#sUpdateOut').textContent += t('desktop.set.updateNote'); }, 4000);
  };
  // tab workers
  page.querySelectorAll('[data-install]').forEach((b) => {
    b.onclick = async () => {
      logLine('▶ install ' + b.dataset.install);
      const r = await api.invoke('install:worker', b.dataset.install);
      logLine((r.ok ? '✓ ' : '✗ ') + r.detail);
      await loadFleet();
      route();
    };
  });
  // tab providers — key không bao giờ về renderer (chỉ hasKey)
  let PROVS = [];
  let oauthWaiting = ''; // provider anthropic đang chờ dán code#state
  const syncKind = () => {
    const o = isOAuth($('#prKind').value);
    $('#prRisk').hidden = !o;
    $('#prKeyed').hidden = o;
  };
  $('#prKind').onchange = syncKind;
  // quick-add kiểu 9router: [kind, nhãn (tên riêng — không dịch), id gợi ý, baseUrl mặc định, formats mặc định (= DEFAULT_FORMATS của router)]
  const QUICK = [
    ['anthropic', '＋ Anthropic API', 'anthropic', 'https://api.anthropic.com', ['messages']],
    ['openai', '＋ OpenAI API', 'openai', 'https://api.openai.com', ['chat', 'responses']],
    ['anthropic-compatible', '＋ Anthropic Compatible', 'anthropic-compat', '', ['messages']],
    ['openai-compatible', '＋ OpenAI Compatible', 'openai-compat', '', ['chat']],
    ['oauth-anthropic', 'Claude Code (Claude Pro/Max)', 'claude-code', '', ['messages']],
    ['oauth-openai', 'OpenAI Codex (ChatGPT Plus/Pro)', 'codex', '', ['responses']],
  ];
  const renderQuick = () => {
    const btn = ([kind, label]) => `<button class="secondary" data-quick="${kind}">${esc(label)}<span class="dim">${esc(t('desktop.pr.connected', { n: PROVS.filter((p) => p.kind === kind).length }))}</span></button>`;
    $('#prQuickKey').innerHTML = QUICK.filter(([k]) => !isOAuth(k)).map(btn).join('');
    $('#prQuickOAuth').innerHTML = QUICK.filter(([k]) => isOAuth(k)).map(btn).join('');
    page.querySelectorAll('[data-quick]').forEach((b) => {
      b.onclick = () => {
        const [kind, , slug, url, fmts] = QUICK.find(([k]) => k === b.dataset.quick);
        let n = 1;
        while (PROVS.some((p) => p.id === `${slug}-${n}`)) n++;
        $('#prId').value = `${slug}-${n}`;
        $('#prKind').value = kind;
        $('#prUrl').value = url;
        $('#prUrl').placeholder = url || 'https://gw.company.com';
        page.querySelectorAll('[data-fmt]').forEach((c) => { c.checked = fmts.includes(c.dataset.fmt); });
        $('#prKey').value = '';
        $('#prOn').checked = true;
        $('#prRiskOk').checked = false;
        $('#prModels').value = '';
        syncKind();
        $('#prId').focus();
        $('#prId').select();
      };
    });
  };
  const OAUTH_ST = ['none', 'ok', 'expired', 'needsLogin'];
  const refreshModels = async () => {
    await Promise.all([loadModels(), loadBrainModels()]);
    const cur = SETTINGS.routerDefaultModel;
    $('#rDefault').innerHTML = `<option value="">${esc(t('desktop.pr.defaultFollowBrain', { model: SETTINGS.brainModel || t('desktop.common.notSelected') }))}</option>` +
      MODELS.models.map((id) => `<option value="${esc(id)}" ${id === cur ? 'selected' : ''}>${esc(id)}</option>`).join('');
  };
  const renderProviders = async () => {
    const [list, st] = await Promise.all([api.invoke('providers:list'), api.invoke('router:status')]);
    PROVS = list;
    renderQuick();
    $('#rStatus').textContent = st.running ? `✓ 127.0.0.1:${st.port} · ${st.providers} provider` : t('desktop.pr.notRunning');
    $('#prRows').innerHTML = list.map((p) => `<tr>
      <td class="mono">${esc(p.id)}</td><td>${esc(p.kind)}${isOAuth(p.kind) ? ' <span class="badge-risk">OAuth ⚠</span>' : ''}</td><td class="mono">${esc(p.baseUrl)}</td><td>${esc(p.formats.join(', '))}</td>
      <td>${p.enabled ? '✓' : '—'}</td><td>${isOAuth(p.kind) ? `<span class="${p.oauthStatus === 'ok' ? 'ok' : 'warn'}">${esc(OAUTH_ST.includes(p.oauthStatus) ? t('desktop.oauth.' + p.oauthStatus) : p.oauthStatus)}</span>` : p.hasKey ? '✓' : '—'}</td>
      <td>${isOAuth(p.kind) ? `<button class="secondary" data-plogin="${esc(p.id)}">${esc(t('desktop.pr.login'))}</button> ` : ''}<button class="secondary" data-pedit="${esc(p.id)}">${esc(t('desktop.pr.edit'))}</button> <button class="secondary" data-ptest="${esc(p.id)}">Test</button> <button class="secondary" data-pdel="${esc(p.id)}">${esc(t('desktop.pr.delete'))}</button></td>
    </tr>`).join('') || `<tr><td colspan="7" class="dim">${esc(t('desktop.pr.empty'))}</td></tr>`;
    page.querySelectorAll('[data-pedit]').forEach((b) => {
      b.onclick = () => {
        const p = PROVS.find((x) => x.id === b.dataset.pedit);
        $('#prId').value = p.id;
        $('#prKind').value = p.kind;
        $('#prUrl').value = p.baseUrl;
        page.querySelectorAll('[data-fmt]').forEach((c) => { c.checked = p.formats.includes(c.dataset.fmt); });
        $('#prOn').checked = p.enabled;
        $('#prKey').value = '';
        $('#prRiskOk').checked = !!p.riskAcknowledged;
        $('#prModels').value = (p.models ?? []).join(', ');
        syncKind();
      };
    });
    page.querySelectorAll('[data-plogin]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.plogin;
        const p = PROVS.find((x) => x.id === id);
        $('#prOut').textContent = t(p.kind === 'oauth-openai' ? 'desktop.pr.waitOpenai' : 'desktop.pr.openClaude', { id });
        const r = await api.invoke('oauth:start', { id });
        if (!r.ok) { $('#prOut').textContent = `✗ ${r.error}`; return; }
        if (p.kind === 'oauth-anthropic') {
          oauthWaiting = id;
          $('#prCodeRow').hidden = false;
          $('#prCode').focus();
          $('#prOut').textContent = t('desktop.pr.pasteCode', { id });
        } else {
          $('#prOut').textContent = t('desktop.pr.loggedIn', { id });
          await renderProviders();
        }
      };
    });
    page.querySelectorAll('[data-ptest]').forEach((b) => {
      b.onclick = async () => {
        $('#prOut').textContent = t('desktop.pr.testing', { id: b.dataset.ptest });
        const r = await api.invoke('providers:test', b.dataset.ptest);
        $('#prOut').textContent = r.ok ? `✓ ${b.dataset.ptest}: ${r.count} model` : `✗ ${b.dataset.ptest}: ${r.error}`;
      };
    });
    page.querySelectorAll('[data-pdel]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm(t('desktop.pr.confirmDelete', { id: b.dataset.pdel }))) return;
        await api.invoke('providers:delete', b.dataset.pdel);
        await renderProviders();
      };
    });
    await refreshModels();
  };
  renderProviders();
  $('#prCodeOk').onclick = async () => {
    const r = await api.invoke('oauth:finish', { id: oauthWaiting, code: $('#prCode').value.trim() });
    $('#prCode').value = '';
    $('#prOut').textContent = r.ok ? t('desktop.pr.loggedIn', { id: oauthWaiting }) : `✗ ${r.error}`;
    if (r.ok) { $('#prCodeRow').hidden = true; await renderProviders(); }
  };
  $('#prSave').onclick = async () => {
    const kind = $('#prKind').value;
    if (isOAuth(kind) && !$('#prRiskOk').checked) { $('#prOut').textContent = t('desktop.pr.needRisk'); return; }
    const cfg = isOAuth(kind)
      ? { id: $('#prId').value.trim(), kind, enabled: $('#prOn').checked, riskAcknowledged: true,
          models: $('#prModels').value.split(',').map((x) => x.trim()).filter(Boolean) }
      : {
          id: $('#prId').value.trim(),
          kind,
          baseUrl: $('#prUrl').value.trim(),
          formats: [...page.querySelectorAll('[data-fmt]')].filter((c) => c.checked).map((c) => c.dataset.fmt),
          enabled: $('#prOn').checked,
        };
    const key = isOAuth(kind) ? '' : $('#prKey').value;
    const r = await api.invoke('providers:save', { cfg, key: key || undefined });
    $('#prKey').value = '';
    $('#prOut').textContent = r.ok ? t('desktop.pr.saved', { id: r.id }) : `✗ ${r.error}`;
    if (r.ok) await renderProviders();
  };
  $('#rDefault').onchange = async (e) => {
    SETTINGS = await api.invoke('settings:set', { ...SETTINGS, routerDefaultModel: e.target.value });
  };
  // tab conformance
  $('#cRun').onclick = async () => {
    $('#cOut').textContent = t('desktop.cf.running');
    const r = await api.invoke('conformance:run', $('#cWorker').value);
    $('#cOut').innerHTML = (r.cases || []).map((c) => `<span class="${c.status === 'ok' ? 'ok' : 'err'}">[${c.status}]</span> ${esc(c.case)} — ${esc(c.detail)}`).join('<br>') + (r.detail ? `<br>${esc(r.detail)}` : '') + `<br><b>badge: ${esc(r.badge ?? '?')}</b>`;
    loadFleet();
  };
  // tab skills
  $('#skSync').onclick = async () => {
    const r = await api.invoke('skills:sync');
    $('#skOut').textContent = r.error ? '✗ ' + r.error : `✓ ${r.entries} KB → ${r.files.join(' + ')}`;
  };
  on('install:log', (line) => logLine(line));
}

// ---------- Memory editor (Project page + Settings › General) ----------
async function renderMemoryEditor(box, projectId) {
  const m = await api.invoke('memory:get', { projectId });
  box.innerHTML = `<h3>${esc(t(projectId ? 'desktop.memory.project' : 'desktop.memory.global'))}</h3>
    <div class="dim">${esc(t('desktop.memory.hint'))}</div>
    <textarea class="memory-box" rows="10"></textarea>
    <div class="row"><button data-mem-save>${esc(t('desktop.common.save'))}</button><span class="dim" data-mem-out></span></div>`;
  const area = box.querySelector('textarea');
  const out = box.querySelector('[data-mem-out]');
  if (!m.ok) { out.textContent = '✗ ' + m.error; return; }
  const used = (n) => { out.textContent = t('desktop.memory.used', { used: n, budget: m.budget }); };
  area.value = m.text;
  used(m.used);
  area.addEventListener('input', () => used(area.value.length));
  box.querySelector('[data-mem-save]').onclick = async () => {
    const r = await api.invoke('memory:set', { projectId, text: area.value });
    if (!r.ok) { out.textContent = '✗ ' + r.error; return; }
    area.value = r.text; // main đã redact secret
    used(r.used);
    out.textContent += ' · ' + t('desktop.common.saved');
  };
}

// ---------- Project (#/project/<id>): tên, repos, memory, KB read-only ----------
async function renderProject(id) {
  composerWrap.hidden = true;
  page.classList.remove('fill');
  const d = await api.invoke('project:get', { id });
  if (!d.ok) { page.innerHTML = `<div class="card err">${esc(d.error)}</div>`; return; }
  const p = d.project;
  $('#pageTitle').textContent = `${t('desktop.project.page')} — ${p.name}`;
  const kbTable = (kb) => (kb.length
    ? `<table><thead><tr><th>id</th><th>title</th><th>scope</th><th>source</th><th></th></tr></thead><tbody>${kb.map((e) => `<tr><td class="mono">${esc(e.id)}</td><td>${esc(e.title)}</td><td class="mono">${esc(e.scope.join(', '))}</td><td>${esc(e.source)}</td><td>${e.pinned ? '📌' : ''}</td></tr>`).join('')}</tbody></table>`
    : `<div class="dim">${esc(t('desktop.mx.noKb'))}</div>`);
  page.innerHTML = `
    <div class="card">
      <label>${esc(t('desktop.project.name'))}</label>
      <div class="row"><input id="pjName" value="${esc(p.name)}" maxlength="80" /><button class="secondary" id="pjRename">${esc(t('desktop.project.rename'))}</button></div>
    </div>
    <div class="card"><h3>${esc(t('desktop.project.repos'))}</h3>
      ${d.repos.length ? `<table class="pj-repos"><tbody>${d.repos.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td class="mono pj-path" title="${esc(r.path)}">${esc(r.path)}${r.exists ? '' : ` <span class="err">${esc(t('desktop.project.missing'))}</span>`}</td>
        <td class="pj-act"><button class="secondary" data-rm-repo="${esc(r.repo)}" title="${esc(t('desktop.project.removeRepoTitle'))}">${esc(t('desktop.project.removeRepo'))}</button></td></tr>`).join('')}</tbody></table>`
        : `<div class="dim">${esc(t('desktop.project.noRepos'))}</div>`}
      <div class="row"><button class="secondary" id="pjAddRepo">${esc(t('desktop.repo.add'))}</button><button class="secondary" id="pjNewChat">${esc(t('desktop.projects.newChatIn', { name: p.name }))}</button></div>
    </div>
    <div class="card" id="pjMemory"></div>
    ${d.repos.filter((r) => r.exists).map((r) => `<div class="card"><h3>${esc(t('desktop.project.kbTitle', { name: r.name }))}</h3>${kbTable(r.kb)}</div>`).join('')}
    <div class="card"><button class="secondary" id="pjDelete">${esc(t('desktop.project.delete'))}</button></div>`;
  renderMemoryEditor($('#pjMemory'), id);
  const after = async (r) => {
    if (!r.ok) return alert('✗ ' + r.error);
    if (r.canceled) return;
    if (CHAT.projectId === id && r.project) CHAT.projectName = r.project.name;
    await loadSettings();
    loadSessions();
    renderProject(id);
  };
  $('#pjRename').onclick = async () => after(await api.invoke('project:rename', { id, name: $('#pjName').value }));
  $('#pjAddRepo').onclick = async () => after(await api.invoke('project:addRepo', { id }));
  page.querySelectorAll('[data-rm-repo]').forEach((b) => { b.onclick = async () => after(await api.invoke('project:removeRepo', { id, repo: b.dataset.rmRepo })); });
  $('#pjNewChat').onclick = () => startChat(id);
  $('#pjDelete').onclick = async () => {
    if (!confirm(t('desktop.project.confirmDelete', { name: p.name }))) return;
    const r = await api.invoke('project:delete', { id });
    if (!r.ok) return alert('✗ ' + r.error);
    if (CHAT.projectId === id) CHAT = { projectId: null, projectName: '' };
    await loadSettings();
    location.hash = '#/chat';
    loadSessions();
  };
}

// ---------- Terminal (node-pty) ----------
let termSession = null;
async function renderTerminal() {
  composerWrap.hidden = true;
  page.classList.remove('fill');
  const s = await loadSettings();
  page.innerHTML = `
    <h2>Terminal — ${esc(baseName(s.activeRepo) || t('desktop.term.activeRepo'))}</h2>
    <div class="card" style="padding:8px">
      <pre id="term"></pre>
      <div class="chatbar" style="margin-top:8px">
        <input id="termIn" placeholder="${esc(t('desktop.term.placeholder'))}" autocomplete="off" />
        <button class="secondary" id="termNew" style="margin-top:0">${esc(t('desktop.term.newSession'))}</button>
      </div>
      <div class="dim" style="font-size:10.5px;margin-top:6px">${esc(t('desktop.term.hint'))}</div>
    </div>`;
  const TERM_ID = 'main';
  const termEl = $('#term');
  const termIn = $('#termIn');
  on('terminal:data', (d) => {
    if (d.id !== TERM_ID) return;
    termEl.textContent += d.data;
    termEl.scrollTop = termEl.scrollHeight;
  });
  on('terminal:exit', (d) => {
    if (d.id === TERM_ID) termEl.textContent += `\r\n[session exited ${d.exitCode}]`;
  });
  const create = () => api.invoke('terminal:create', { id: TERM_ID, cwd: s.activeRepo, cols: 110, rows: 30 });
  $('#termNew').onclick = async () => {
    await api.invoke('terminal:kill', TERM_ID);
    termEl.textContent = '';
    termSession = null;
    await create();
    termSession = TERM_ID;
  };
  termIn.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const cmd = termIn.value;
      termIn.value = '';
      if (termSession !== TERM_ID) { await create(); termSession = TERM_ID; }
      await api.invoke('terminal:input', { id: TERM_ID, data: cmd + '\r' });
    }
  });
  if (termSession === TERM_ID) await api.invoke('terminal:kill', TERM_ID); // vào lại trang → session mới, tránh pty cũ
  await create();
  termSession = TERM_ID;
  termEl.textContent += t('desktop.term.ready') + '\r\n';
  termIn.focus();
}

// ---------- router ----------
// terminal: route giữ nguyên nhưng không có link trên UI — tạm ẩn theo yêu cầu
const TITLES = { chat: () => 'Chat — Orchestrator', dashboard: () => 'Dashboard', terminal: () => 'Terminal', settings: () => t('desktop.page.settings') };
const ROUTES = { chat: renderChat, dashboard: renderDashboard, terminal: renderTerminal, settings: renderSettings };
function route() {
  let hash = (location.hash || '#/chat').replace('#/', '');
  if (hash === 'wizard') hash = 'settings'; // hash cũ còn hoạt động
  if (hash === 'transcript') { openTranscript = true; location.hash = '#/dashboard'; return; } // Transcript giờ là section trong Dashboard
  if (hash === 'matrix') { settingsTab = 'matrix'; location.hash = '#/settings'; return; } // Policy Matrix giờ là tab trong Cài đặt (hashchange → route lại)
  document.querySelectorAll('#sidebar a[data-page]').forEach((a) => a.classList.toggle('active', a.dataset.page === hash));
  document.getElementById('btnSettings').classList.toggle('active', hash === 'settings');
  $('#pageTitle').textContent = TITLES[hash]?.() || 'Orchestra';
  renderRepo();
  if (hash.startsWith('project/')) {
    loadSessions(); // highlight project trong sidebar
    return renderProject(decodeURIComponent(hash.slice('project/'.length)));
  }
  (ROUTES[hash] || renderChat)();
}
on('nav', (p) => { location.hash = '#/' + p; route(); });
window.addEventListener('hashchange', route);

// ---------- init ----------
(async () => {
  await loadI18n(); // trước render đầu tiên
  await loadSettings();
  await Promise.all([loadFleet(), loadSessions(), loadModels(), loadBrainModels()]);
  route();
})();

// Stub API mẫu — chỉ active khi renderer chạy ngoài Electron (preview bằng trình duyệt).
function devStub() {
  const repos = ['C:\\code\\payment-svc'];
  const project = { id: 'payments-a1b2', name: 'Payments', repos };
  const settings = { projects: [project], activeRepo: repos[0], repos, brainModel: '', routerDefaultModel: '', templatesDir: '', autoApprovePlan: false, hooksEnabled: true, skillSync: true, language: 'en' };
  const fleet = [
    { id: 'claude', display: 'Claude Code', version: '2.1.310', auth: 'ok', conformance: 'A', installed: true, router: true },
    { id: 'codex', display: 'Codex CLI', version: '0.164.0', auth: 'ok', conformance: 'A', installed: true, router: true },
    { id: 'antigravity', display: 'Antigravity', version: null, auth: 'unknown', conformance: null, installed: false, router: false },
  ];
  const tasks = [
    { id: 'task-0a1', node: 'implement', worker: 'claude', exit: 0, scopeOk: true, files: 3 },
    { id: 'task-0a2', node: 'review', worker: 'codex', exit: 0, scopeOk: true, files: 2 },
    { id: 'task-0a3', node: 'test', worker: 'claude', exit: 1, scopeOk: false, files: 1 },
  ];
  const listeners = {};
  const bus = { on: (ch, cb) => { (listeners[ch] ||= []).push(cb); } };
  const reply = async (ch, p) => {
    if (ch === 'settings:get') return settings;
    if (ch === 'fleet:list') return fleet;
    if (ch === 'tasks:list') return tasks;
    if (ch === 'i18n:get') return { locale: 'en', dict: {} }; // preview: hiện key
    if (ch === 'models:list') return { models: ['gw/claude-opus'], byWorker: { claude: [{ id: 'gw/claude-opus', ok: true, reason: 'gw speaks messages' }], codex: [{ id: 'gw/claude-opus', ok: true, reason: 'gw messages (router translates Responses→Chat/Messages)' }] } };
    if (ch === 'settings:set') return Object.assign(settings, p);
    if (ch === 'brain:models') return { models: ['gw/claude-opus'] };
    if (ch === 'providers:list') return [{ id: 'gw', kind: 'anthropic-compatible', baseUrl: 'https://gw.example.com', formats: ['messages'], enabled: true, hasKey: true },
      { id: 'cc', kind: 'oauth-anthropic', baseUrl: 'https://api.anthropic.com', formats: ['messages'], enabled: true, hasKey: false, riskAcknowledged: true, models: ['claude-sonnet-5-5'], oauthStatus: 'none', expiresAt: null }];
    if (ch === 'router:status') return { running: false, port: null, providers: 1 };
    if (ch === 'chat:sessions') return { projects: [{ ...project, sessions: [{ id: '2026-11-02T08-00-00-000Z', title: 'Add payment gateway X', updatedAt: new Date().toISOString(), turns: 2, active: false }] }], chats: [] };
    if (ch === 'chat:open') return { ok: true, projectId: p.projectId, projectName: p.projectId ? project.name : null, messages: [{ role: 'user', text: 'Add payment gateway X' }, { role: 'orch', text: '(stub) session opened' }] };
    if (ch === 'chat:new') return { ok: true, projectId: p.projectId, projectName: p.projectId ? project.name : null };
    if (ch === 'project:get') return { ok: true, project, repos: [{ name: 'payment-svc', path: repos[0], repo: repos[0], exists: true, kb: [] }] };
    if (ch === 'memory:get') return { ok: true, text: '- prefers short answers', used: 22, budget: p.projectId ? 5000 : 3000 };
    if (ch === 'matrix:data') return { source: 'preview', errors: [], minSample: 10, workers: [{ id: 'claude', display: 'Claude Code' }], rows: [{ role: 'coder', cells: [{ cli: 'claude', rank: 1, model: null, n: 0, ema: null }] }], kb: [] };
    if (ch === 'chat:exchange') setTimeout(() => listeners['chat:message']?.forEach((f) => f({ kind: 'orch', text: '(stub) received — running preview outside Electron.' })), 400);
    return { ok: true };
  };
  bus.invoke = reply;
  return bus;
}

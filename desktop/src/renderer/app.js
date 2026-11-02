// Orchestra Desktop — renderer (vanilla, không framework)
// Bố cục agent-first: Chat là màn hình chính (composer ở đáy), Dashboard/Fleet là panel phụ.
const api = window.orchestra ?? devStub(); // stub chỉ dùng khi chạy renderer ngoài Electron (dev/preview)
const page = document.getElementById('page');
const composerWrap = document.getElementById('composerWrap');
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
const split = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

let SETTINGS = null;
let FLEET = [];

// ---------- event bus: đăng ký listener đúng 1 lần, route mới chỉ gắn handler ----------
const handlers = {};
for (const ch of ['dispatch:event', 'pipeline:log', 'install:log', 'chat:message', 'terminal:data', 'terminal:exit', 'update:status', 'nav']) {
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
const repo = () => SETTINGS?.activeRepo || '';
const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const fleetInstalled = () => FLEET.filter((f) => f.installed).length;

function renderChrome() {
  // repo label (sidebar) + repo select (topbar)
  document.getElementById('repoLabel').textContent = 'repo: ' + (repo() || '(chưa chọn)');
  const sel = $('#repoSel');
  if (sel && SETTINGS) {
    const cur = repo();
    sel.innerHTML = (SETTINGS.repos || []).map((r) => `<option ${r === cur ? 'selected' : ''}>${esc(r)}</option>`).join('')
      || '<option>(chưa có — thêm ở Settings)</option>';
  }
  // fleet pill
  const pill = $('#fleetPill');
  if (pill && FLEET.length) {
    const n = fleetInstalled();
    pill.innerHTML = `<span class="dot ${n === FLEET.length ? 'ok' : 'err'}"></span>${n}/${FLEET.length} workers`;
  }
  // statusbar
  $('#stWorker').textContent = `worker: ${SETTINGS?.orchestratorWorker ?? '—'} (auto policy)`;
  $('#stRepo').textContent = 'repo: ' + (baseName(repo()) || '(chưa chọn)');
  const stFleet = $('#stFleet');
  if (FLEET.length) {
    const n = fleetInstalled();
    stFleet.innerHTML = `<span class="dot ${n ? 'ok' : 'err'}"></span> ${n}/${FLEET.length} workers`;
  }
  const brain = $('#composerBrain');
  if (brain) brain.textContent = `orchestrator: ${SETTINGS?.orchestratorWorker ?? '—'}`;
}

async function loadSideTasks() {
  const box = $('#sideTaskList');
  if (!box) return;
  const tasks = await api.invoke('tasks:list');
  const recent = tasks.slice(-6).reverse();
  box.innerHTML = recent.map((t) => `
    <div class="task-item" data-hash="#/transcript" title="${esc(t.node)}/${esc(t.worker)} exit=${t.exit ?? '-'}">
      <span class="dot ${t.exit === 0 ? 'ok' : t.exit == null ? '' : 'err'}"></span>
      <span class="task-id">${esc(t.id)}</span>
      <span class="task-worker">${esc(t.worker)}</span>
    </div>`).join('') || '<div class="side-empty">Chưa có task</div>';
  box.querySelectorAll('.task-item').forEach((el) => { el.onclick = () => (location.hash = el.dataset.hash); });
}

// ---------- chrome clicks ----------
document.getElementById('newTask').onclick = () => {
  location.hash = '#/chat';
  route();
  setTimeout(() => $('#chatInput')?.focus(), 60);
};
document.getElementById('btnSettings').onclick = () => {
  settingsTab = 'chung';
  if (!location.hash.includes('#/settings')) location.hash = '#/settings';
};
$('#fleetPill').onclick = () => { location.hash = '#/dashboard'; route(); };
$('#repoSel').addEventListener('change', async (e) => {
  const r = e.target.value;
  if (!r || r.startsWith('(')) return;
  await api.invoke('repo:set-active', r);
  await loadSettings();
  route(); // nạp lại trang hiện tại với repo mới
});

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
  add('greet', '◆ Orchestrator sẵn sàng. Mô tả task hoặc hỏi về pipeline — dispatch chi tiết vẫn ở Dashboard.');
  const input = $('#chatInput');
  const send = async () => {
    const t = input.value.trim();
    if (!t) return;
    input.value = '';
    input.style.height = 'auto';
    add('user', t);
    add('orch pending', '…đang xử lý');
    await api.invoke('chat:exchange', { text: t });
  };
  $('#chatSend').onclick = send;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });
  on('chat:message', (m) => {
    const pending = $('#chatMsgs .pending');
    if (m.kind === 'orch' && pending) pending.remove();
    add(m.kind, m.text);
  });
  input.focus();
}

// ---------- Dashboard ----------
async function renderDashboard() {
  composerWrap.hidden = true;
  page.classList.remove('fill');
  const [, tasks] = await Promise.all([loadFleet(), api.invoke('tasks:list'), loadSettings()]);
  page.innerHTML = `
    <h2>Dashboard</h2>
    <div class="card"><h3>Fleet</h3>
      <table><thead><tr><th></th><th>worker</th><th>version</th><th>auth</th><th>conformance</th></tr></thead>
      <tbody>${FLEET.map((f) => `<tr><td><span class="dot ${f.installed ? 'ok' : 'err'}"></span></td><td>${esc(f.id)}</td><td class="mono">${esc(f.version ?? '-')}</td><td>${esc(f.auth)}</td><td>${esc(f.conformance ?? '-')}</td></tr>`).join('')}</tbody>
      </table>
      <button class="secondary" id="btnToWizard">Cài / cấu hình worker → Cài đặt</button>
    </div>
    <div class="grid2">
      <div class="card"><h3>Dispatch task</h3>
        <label>Goal</label><textarea id="dGoal" rows="2" placeholder="Thêm cổng thanh toán X theo pattern Y"></textarea>
        <label>Scope (glob, phẩy cách)</label><input id="dScope" value="src/payment/**" />
        <label>Worker</label><select id="dWorker"><option value="">auto (Role Policy)</option>${FLEET.filter((f) => f.installed).map((f) => `<option>${esc(f.id)}</option>`).join('')}</select>
        <label>Model (để trống = theo policy)</label><input id="dModel" placeholder="worker-codex…" />
        <button id="dGo">Dispatch</button>
      </div>
      <div class="card"><h3>Run pipeline</h3>
        <label>Template</label><select id="pTpl"><option>feature-dev</option><option>hotfix</option></select>
        <label>Goal</label><textarea id="pGoal" rows="2"></textarea>
        <label>Scope</label><input id="pScope" value="src/payment/**" />
        <button id="pGo">Chạy pipeline</button>
      </div>
    </div>
    <div class="card"><h3>Task records</h3>
      <table><thead><tr><th>id</th><th>node</th><th>worker</th><th>exit</th><th>scope</th><th>files</th></tr></thead>
      <tbody>${tasks.map((t) => `<tr class="click-row" onclick="location.hash='#/transcript'"><td class="mono">${esc(t.id)}</td><td>${esc(t.node)}</td><td>${esc(t.worker)}</td><td>${t.exit ?? '-'}</td><td>${t.scopeOk ? '<span class="ok">OK</span>' : '<span class="err">VIOLATION</span>'}</td><td>${t.files}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">chưa có</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card"><h3>Live stream</h3><div id="log"></div></div>`;
  $('#btnToWizard').onclick = () => { settingsTab = 'workers'; location.hash = '#/settings'; };
  $('#dGo').onclick = async () => {
    const goal = $('#dGoal').value.trim();
    if (!goal) return alert('Nhập goal');
    logLine('▶ dispatch: ' + goal);
    const r = await api.invoke('dispatch', { goal, scope: split($('#dScope').value), worker: $('#dWorker').value, model: $('#dModel').value.trim() });
    logLine(`${r.result.ok ? '✓ OK' : '✗ FAILED'} ${r.result.taskId}${r.override && r.override.startsWith('override') ? ' — ' + r.override : ''}`);
    loadSideTasks();
  };
  $('#pGo').onclick = async () => {
    const goal = $('#pGoal').value.trim();
    if (!goal) return alert('Nhập goal');
    logLine('▶ pipeline: ' + goal);
    const r = await api.invoke('pipeline:run', { template: $('#pTpl').value, goal, scope: split($('#pScope').value) });
    logLine(`${r.ok ? '✓ OK' : '✗ FAILED'} ${r.runId} merged=${r.merged}`);
    loadSideTasks();
  };
  on('dispatch:event', (d) => logLine(`[${d.t}] ${JSON.stringify(d.payload).slice(0, 160)}`));
  on('pipeline:log', (line) => logLine(line));
}

// ---------- Transcript ----------
async function renderTranscript() {
  composerWrap.hidden = true;
  page.classList.remove('fill');
  const tasks = await api.invoke('tasks:list');
  page.innerHTML = `
    <h2>Transcript</h2>
    <div class="card"><h3>Task records — click để xem JSON</h3>
      <table><tbody>${tasks.map((t) => `<tr class="click-row" onclick="alert('${esc(t.id)} — ${esc(t.node)}/${esc(t.worker)} exit=${t.exit}')"><td class="mono">${esc(t.id)}</td><td>${esc(t.node)}</td><td>${esc(t.worker)}</td><td>${t.exit ?? '-'}</td><td>${t.files} file</td></tr>`).join('') || '<tr><td class="dim">chưa có record</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card"><h3>Live stream (mọi run)</h3><div id="log"></div></div>`;
  on('dispatch:event', (d) => logLine(`[${d.t}] ${JSON.stringify(d.payload).slice(0, 160)}`));
  on('pipeline:log', (line) => logLine(line));
  on('install:log', (line) => logLine('[install] ' + line));
}

// ---------- Policy Matrix ----------
async function renderMatrix() {
  composerWrap.hidden = true;
  page.classList.remove('fill');
  const html = await api.invoke('matrix:html');
  page.innerHTML = `<h2>Policy Matrix</h2><div class="card" id="iframeWrap"><iframe srcdoc="${esc(html)}"></iframe></div>`;
  // promote từ iframe: policyMatrixHtml tương thích host — postMessage lên parent
  window.addEventListener('message', async (e) => {
    const d = e.data || {};
    if (d.kind === 'promote') {
      const r = await api.invoke('matrix:promote', d);
      if (!r.ok) alert(r.detail);
      route();
    }
  });
}

// ---------- Cài đặt (1 nút duy nhất — gộp Settings + Setup Wizard, kiểu tab như ZCode) ----------
let settingsTab = 'chung';
async function renderSettings() {
  composerWrap.hidden = true;
  page.classList.remove('fill');
  const [s] = await Promise.all([loadSettings(), loadFleet()]);
  const TABS = [['chung', 'Chung'], ['workers', 'Workers'], ['vault', 'Vault / API key'], ['conformance', 'Conformance'], ['skills', 'Skills']];
  const pane = (id, html) => `<div class="tabpane" id="tab-${id}" ${settingsTab === id ? '' : 'hidden'}>${html}</div>`;
  page.innerHTML = `
    <h2>Cài đặt</h2>
    <div class="tabs">${TABS.map(([id, label]) => `<button class="tab ${settingsTab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}</div>
    ${pane('chung', `
      <div class="card">
        <label>Repos (mỗi dòng 1 đường dẫn)</label>
        <textarea id="sRepos" rows="4" class="mono">${esc(s.repos.join('\n'))}</textarea>
        <label>Orchestrator worker (chat brain)</label>
        <select id="sWorker"><option ${s.orchestratorWorker === 'claude' ? 'selected' : ''}>claude</option><option ${s.orchestratorWorker === 'codex' ? 'selected' : ''}>codex</option></select>
        <label>Templates dir (để trống = mặc định)</label><input id="sTpl" value="${esc(s.templatesDir)}" />
        <label><input type="checkbox" id="sAuto" ${s.autoApprovePlan ? 'checked' : ''}/> Tự duyệt plan (pipeline không dừng hỏi)</label>
        <label><input type="checkbox" id="sHooks" ${s.hooksEnabled ? 'checked' : ''}/> Guard hook pre-execution</label>
        <label><input type="checkbox" id="sSync" ${s.skillSync ? 'checked' : ''}/> Skill-sync trước dispatch</label>
        <div class="row">
          <button id="sSave">Lưu</button>
          <button class="secondary" id="sUpdate">Kiểm tra bản cập nhật</button>
          <span id="sUpdateOut" class="dim"></span>
        </div>
      </div>`)}
    ${pane('workers', `
      <div class="card">
        <h3>Worker CLI (npm)</h3>
        ${FLEET.map((f) => `<div class="wizard-step">
          <span class="dot ${f.installed ? 'ok' : 'err'}"></span>
          <b>${esc(f.display)}</b><span class="dim">${esc(f.version ?? 'chưa cài')}</span>
          <button class="secondary" data-install="${esc(f.id)}">${f.installed ? 'Cài lại' : 'Cài'}</button>
          ${f.installed ? `<button class="secondary" data-auth="${esc(f.id)}">Auth</button>` : ''}
        </div>`).join('')}
        <div id="log" style="margin-top:10px"></div>
      </div>`)}
    ${pane('vault', `
      <div class="card">
        <h3>Vault — API key / Custom provider (DPAPI)</h3>
        <label>Provider</label><select id="vProvider"><option>anthropic</option><option>openai</option></select>
        <label>Base URL (custom provider — để trống nếu dùng key gốc)</label><input id="vUrl" placeholder="https://gw.company.com/v1" />
        <label>API key</label><input id="vKey" type="password" />
        <div class="row">
          <button id="vSave">Lưu vào vault</button>
          <button class="secondary" id="vDel">Xoá provider</button>
        </div>
      </div>`)}
    ${pane('conformance', `
      <div class="card">
        <h3>Conformance (Worker Protocol §10)</h3>
        <label>Worker</label><select id="cWorker">${FLEET.map((f) => `<option>${esc(f.id)}</option>`).join('')}</select>
        <button id="cRun">Chạy conformance (smoke thật)</button>
        <div id="cOut" class="dim" style="margin-top:8px"></div>
      </div>`)}
    ${pane('skills', `
      <div class="card">
        <h3>Skills</h3>
        <button id="skSync">Sync KB → AGENTS.md + CLAUDE.md</button>
        <span id="skOut" class="dim" style="margin-left:8px"></span>
      </div>`)}`;
  // chuyển tab
  page.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      settingsTab = t.dataset.tab;
      page.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      TABS.forEach(([id]) => { const el = document.getElementById('tab-' + id); if (el) el.hidden = id !== settingsTab; });
    };
  });
  // tab chung
  $('#sSave').onclick = async () => {
    const next = {
      ...s,
      repos: $('#sRepos').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
      orchestratorWorker: $('#sWorker').value,
      templatesDir: $('#sTpl').value.trim(),
      autoApprovePlan: $('#sAuto').checked,
      hooksEnabled: $('#sHooks').checked,
      skillSync: $('#sSync').checked,
    };
    await api.invoke('settings:set', next);
    if (!next.activeRepo && next.repos[0]) await api.invoke('repo:set-active', next.repos[0]);
    await loadSettings();
    alert('✓ đã lưu');
    route();
  };
  $('#sUpdate').onclick = async () => {
    $('#sUpdateOut').textContent = 'đang kiểm tra… (cần app đóng gói + GitHub Releases)';
    on('update:status', (d) => {
      $('#sUpdateOut').textContent = d.status === 'downloaded' ? `✓ v${d.version} đã tải — restart để cập nhật` : d.status;
    });
    await api.invoke('update:check');
    setTimeout(() => { if ($('#sUpdateOut')) $('#sUpdateOut').textContent += ' — nếu chưa publish Release thì đây là bình thường.'; }, 4000);
  };
  // tab workers
  page.querySelectorAll('[data-install]').forEach((b) => {
    b.onclick = async () => {
      logLine('▶ install ' + b.dataset.install);
      const r = await api.invoke('install:worker', b.dataset.install);
      logLine((r.ok ? '✓ ' : '✗ ') + r.detail);
      await loadFleet();
      loadSideTasks();
      route();
    };
  });
  page.querySelectorAll('[data-auth]').forEach((b) => {
    b.onclick = () => alert(`Login: mở terminal chạy CLI này (OAuth ${b.dataset.auth === 'claude' ? 'anthropic' : 'openai'}) — hoặc cấu hình key/provider ở tab Vault.`);
  });
  // tab vault
  $('#vSave').onclick = async () => {
    const provider = $('#vProvider').value;
    const key = $('#vKey').value.trim();
    if (!key) return alert('Nhập key');
    const url = $('#vUrl').value.trim() || undefined;
    const r = await api.invoke('vault:set', { provider, secret: key, baseUrl: url });
    alert(r.ok ? `✓ ${provider} lưu (base_url: ${url ?? 'mặc định'})` : '✗ thất bại');
  };
  $('#vDel').onclick = async () => {
    await api.invoke('vault:delete', $('#vProvider').value);
    alert('đã xoá');
  };
  // tab conformance
  $('#cRun').onclick = async () => {
    $('#cOut').textContent = 'đang chạy (smoke thật, ~30-60s)…';
    const r = await api.invoke('conformance:run', $('#cWorker').value);
    $('#cOut').innerHTML = (r.cases || []).map((c) => `<span class="${c.status === 'ok' ? 'ok' : 'err'}">[${c.status}]</span> ${esc(c.case)} — ${esc(c.detail)}`).join('<br>') + `<br><b>badge: ${r.badge ?? '?'}</b>`;
    loadFleet();
  };
  // tab skills
  $('#skSync').onclick = async () => {
    const r = await api.invoke('skills:sync');
    $('#skOut').textContent = `✓ ${r.entries} KB → ${r.files.join(' + ')}`;
  };
  on('install:log', (line) => logLine(line));
}

// ---------- Terminal (node-pty) ----------
let termSession = null;
async function renderTerminal() {
  composerWrap.hidden = true;
  page.classList.remove('fill');
  const s = await loadSettings();
  page.innerHTML = `
    <h2>Terminal — ${esc(baseName(s.activeRepo) || 'repo active')}</h2>
    <div class="card" style="padding:8px">
      <pre id="term"></pre>
      <div class="chatbar" style="margin-top:8px">
        <input id="termIn" placeholder="Gõ lệnh… (Enter)" autocomplete="off" />
        <button class="secondary" id="termNew" style="margin-top:0">Session mới</button>
      </div>
      <div class="dim" style="font-size:10.5px;margin-top:6px">Terminal nhúng chạy trong repo active — worker CLI có thể chạy trực tiếp tại đây.</div>
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
  termEl.textContent += 'Terminal sẵn sàng (powershell trong repo active).\r\n';
  termIn.focus();
}

// ---------- router ----------
const TITLES = { chat: 'Chat — Orchestrator', dashboard: 'Dashboard', terminal: 'Terminal', transcript: 'Transcript', matrix: 'Policy Matrix', settings: 'Cài đặt' };
const ROUTES = { chat: renderChat, dashboard: renderDashboard, terminal: renderTerminal, transcript: renderTranscript, matrix: renderMatrix, settings: renderSettings };
function route() {
  let hash = (location.hash || '#/chat').replace('#/', '');
  if (hash === 'wizard') hash = 'settings'; // hash cũ còn hoạt động
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === hash));
  document.getElementById('btnSettings').classList.toggle('active', hash === 'settings');
  $('#pageTitle').textContent = TITLES[hash] || 'Orchestra';
  (ROUTES[hash] || renderChat)();
}
on('nav', (p) => { location.hash = '#/' + p; route(); });
window.addEventListener('hashchange', route);

// ---------- init ----------
(async () => {
  await loadSettings();
  await Promise.all([loadFleet(), loadSideTasks()]);
  route();
})();

// Stub API mẫu — chỉ active khi renderer chạy ngoài Electron (preview bằng trình duyệt).
function devStub() {
  const repos = ['C:\\code\\payment-svc'];
  const settings = { activeRepo: repos[0], repos, orchestratorWorker: 'claude', templatesDir: '', autoApprovePlan: false, hooksEnabled: true, skillSync: true };
  const fleet = [
    { id: 'claude', display: 'Claude Code', version: '2.1.310', auth: 'ok', conformance: 'A', installed: true },
    { id: 'codex', display: 'Codex CLI', version: '0.164.0', auth: 'ok', conformance: 'A', installed: true },
    { id: 'antigravity', display: 'Antigravity', version: null, auth: 'unknown', conformance: null, installed: false },
  ];
  const tasks = [
    { id: 'task-0a1', node: 'implement', worker: 'claude', exit: 0, scopeOk: true, files: 3 },
    { id: 'task-0a2', node: 'review', worker: 'codex', exit: 0, scopeOk: true, files: 2 },
    { id: 'task-0a3', node: 'test', worker: 'claude', exit: 1, scopeOk: false, files: 1 },
  ];
  const listeners = {};
  const bus = { on: (ch, cb) => { (listeners[ch] ||= []).push(cb); } };
  const reply = async (ch) => {
    if (ch === 'settings:get') return settings;
    if (ch === 'fleet:list') return fleet;
    if (ch === 'tasks:list') return tasks;
    if (ch === 'matrix:html') return '<h3 style="font-family:monospace">Policy Matrix (preview)</h3>';
    if (ch === 'chat:exchange') setTimeout(() => listeners['chat:message']?.forEach((f) => f({ kind: 'orch', text: '(stub) đã nhận — chạy preview ngoài Electron.' })), 400);
    return { ok: true };
  };
  bus.invoke = reply;
  return bus;
}

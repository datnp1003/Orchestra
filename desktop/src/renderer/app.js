// Orchestra Desktop — renderer (vanilla, không framework)
const api = window.orchestra;
const page = document.getElementById('page');
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

let SETTINGS = null;

async function loadSettings() {
  SETTINGS = await api.invoke('settings:get');
  document.getElementById('repoLabel').textContent = 'repo: ' + (SETTINGS.activeRepo || '(chưa chọn)');
  return SETTINGS;
}
const repo = () => SETTINGS?.activeRepo || '';

// ---------- Dashboard ----------
async function renderDashboard() {
  const [fleet, tasks, settings] = await Promise.all([api.invoke('fleet:list'), api.invoke('tasks:list'), loadSettings()]);
  page.innerHTML = `
    <h2>Dashboard</h2>
    <div class="card"><label>Repo active</label>
      <div style="display:flex;gap:6px">
        <select id="repoSel">${settings.repos.map((r) => `<option ${r === settings.activeRepo ? 'selected' : ''}>${esc(r)}</option>`).join('') || '<option>(chưa có — thêm ở Settings)</option>'}</select>
        <button id="repoSet">Set active</button>
      </div>
    </div>
    <div class="card"><h3 style="margin-top:0">Fleet</h3>
      <table><tr><th></th><th>worker</th><th>version</th><th>auth</th><th>conformance</th></tr>
      ${fleet.map((f) => `<tr><td>${f.installed ? '<span class="ok">✓</span>' : '<span class="err">✗</span>'}</td><td>${esc(f.id)}</td><td>${esc(f.version ?? '-')}</td><td>${esc(f.auth)}</td><td>${esc(f.conformance ?? '-')}</td></tr>`).join('')}
      </table>
      <button class="secondary" onclick="location.hash='#/wizard'">Cài / cấu hình worker → Wizard</button>
    </div>
    <div class="grid2">
      <div class="card"><h3 style="margin-top:0">Dispatch task</h3>
        <label>Goal</label><textarea id="dGoal" rows="2" placeholder="Thêm cổng thanh toán X theo pattern Y"></textarea>
        <label>Scope (glob, phẩy cách)</label><input id="dScope" value="src/payment/**" />
        <label>Worker</label><select id="dWorker"><option value="">auto (Role Policy)</option>${fleet.filter((f) => f.installed).map((f) => `<option>${esc(f.id)}</option>`).join('')}</select>
        <label>Model (để trống = theo policy)</label><input id="dModel" placeholder="worker-codex…" />
        <button id="dGo">Dispatch</button>
      </div>
      <div class="card"><h3 style="margin-top:0">Run pipeline</h3>
        <label>Template</label><select id="pTpl"><option>feature-dev</option><option>hotfix</option></select>
        <label>Goal</label><textarea id="pGoal" rows="2"></textarea>
        <label>Scope</label><input id="pScope" value="src/payment/**" />
        <button id="pGo">Chạy pipeline</button>
      </div>
    </div>
    <div class="card"><h3 style="margin-top:0">Task records</h3>
      <table><tr><th>id</th><th>node</th><th>worker</th><th>exit</th><th>scope</th><th>files</th></tr>
      ${tasks.map((t) => `<tr><td>${esc(t.id)}</td><td>${esc(t.node)}</td><td>${esc(t.worker)}</td><td>${t.exit ?? '-'}</td><td>${t.scopeOk ? '<span class="ok">OK</span>' : '<span class="err">VIOLATION</span>'}</td><td>${t.files}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">chưa có</td></tr>'}
      </table>
    </div>
    <div class="card"><h3 style="margin-top:0">Live stream</h3><div id="log"></div></div>`;
  $('#repoSet').onclick = async () => {
    const r = $('#repoSel').value;
    if (r && r !== '(chưa có — thêm ở Settings)') { await api.invoke('repo:set-active', r); await loadSettings(); route(); }
  };
  $('#dGo').onclick = async () => {
    const goal = $('#dGoal').value.trim();
    if (!goal) return alert('Nhập goal');
    logLine('▶ dispatch: ' + goal);
    const r = await api.invoke('dispatch', { goal, scope: split($('#dScope').value), worker: $('#dWorker').value, model: $('#dModel').value.trim() });
    logLine(`${r.result.ok ? '✓ OK' : '✗ FAILED'} ${r.result.taskId}${r.override && r.override.startsWith('override') ? ' — ' + r.override : ''}`);
  };
  $('#pGo').onclick = async () => {
    const goal = $('#pGoal').value.trim();
    if (!goal) return alert('Nhập goal');
    logLine('▶ pipeline: ' + goal);
    const r = await api.invoke('pipeline:run', { template: $('#pTpl').value, goal, scope: split($('#pScope').value) });
    logLine(`${r.ok ? '✓ OK' : '✗ FAILED'} ${r.runId} merged=${r.merged}`);
  };
  api.on('dispatch:event', (d) => logLine(`[${d.t}] ${JSON.stringify(d.payload).slice(0, 160)}`));
  api.on('pipeline:log', (line) => logLine(line));
}
function logLine(s) {
  const el = $('#log');
  if (!el) return;
  el.textContent += s + '\n';
  el.scrollTop = el.scrollHeight;
}
const split = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------- Chat ----------
async function renderChat() {
  page.innerHTML = `
    <h2>Chat — Orchestrator</h2>
    <div class="card" style="height:calc(100vh - 220px);display:flex;flex-direction:column">
      <div id="chatMsgs" style="flex:1;overflow-y:auto"></div>
      <div class="chatbar" style="margin-top:8px">
        <textarea id="chatInput" rows="2" placeholder="Nhắn cho orchestrator… (Enter gửi)"></textarea>
        <button id="chatSend">Gửi</button>
      </div>
    </div>`;
  const add = (cls, text) => {
    const d = document.createElement('div');
    d.className = 'm ' + cls;
    d.textContent = text;
    $('#chatMsgs').appendChild(d);
    $('#chatMsgs').scrollTop = $('#chatMsgs').scrollHeight;
  };
  $('#chatSend').onclick = async () => {
    const t = $('#chatInput').value.trim();
    if (!t) return;
    $('#chatInput').value = '';
    add('user', t);
    add('orch', '…đang xử lý');
    await api.invoke('chat:exchange', { text: t });
  };
  api.on('chat:message', (m) => {
    if (m.kind === 'orch' && $('#chatMsgs').lastChild?.textContent === '…đang xử lý') $('#chatMsgs').lastChild.remove();
    add(m.kind, m.text);
  });
}

// ---------- Transcript ----------
async function renderTranscript() {
  const tasks = await api.invoke('tasks:list');
  page.innerHTML = `
    <h2>Transcript</h2>
    <div class="card"><h3 style="margin-top:0">Task records — click để xem JSON</h3>
      <table>${tasks.map((t) => `<tr style="cursor:pointer" onclick="alert('${esc(t.id)} — ${esc(t.node)}/${esc(t.worker)} exit=${t.exit}')"><td>${esc(t.id)}</td><td>${esc(t.node)}</td><td>${esc(t.worker)}</td><td>${t.exit ?? '-'}</td><td>${t.files} file</td></tr>`).join('') || '<tr><td class="dim">chưa có record</td></tr>'}
      </table>
    </div>
    <div class="card"><h3 style="margin-top:0">Live stream (mọi run)</h3><div id="log"></div></div>`;
  api.on('dispatch:event', (d) => logLine(`[${d.t}] ${JSON.stringify(d.payload).slice(0, 160)}`));
  api.on('pipeline:log', (line) => logLine(line));
  api.on('install:log', (line) => logLine('[install] ' + line));
}

// ---------- Matrix ----------
async function renderMatrix() {
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

// ---------- Wizard ----------
async function renderWizard() {
  const [fleet] = await Promise.all([api.invoke('fleet:list'), loadSettings()]);
  page.innerHTML = `
    <h2>Setup Wizard</h2>
    <div class="card"><h3 style="margin-top:0">1. Worker CLI (npm)</h3>
      ${fleet.map((f) => `<div style="display:flex;gap:8px;align-items:center;margin:6px 0">
        <span>${f.installed ? '<span class="ok">✓</span>' : '<span class="err">✗</span>'}</span>
        <b>${esc(f.display)}</b><span class="dim">${esc(f.version ?? 'chưa cài')}</span>
        <button class="secondary" data-install="${esc(f.id)}">${f.installed ? 'Cài lại' : 'Cài'}</button>
        ${f.installed ? `<button class="secondary" data-auth="${esc(f.id)}">Auth</button>` : ''}
      </div>`).join('')}
      <div id="log"></div>
    </div>
    <div class="card"><h3 style="margin-top:0">2. Vault — API key / Custom provider</h3>
      <label>Provider</label><select id="vProvider"><option>anthropic</option><option>openai</option></select>
      <label>Base URL (custom provider — để trống nếu dùng key gốc)</label><input id="vUrl" placeholder="https://gw.company.com/v1" />
      <label>API key</label><input id="vKey" type="password" />
      <button id="vSave">Lưu vào vault (DPAPI)</button>
      <button class="secondary" id="vDel">Xoá provider</button>
    </div>
    <div class="card"><h3 style="margin-top:0">3. Conformance (Worker Protocol §10)</h3>
      <label>Worker</label><select id="cWorker">${fleet.map((f) => `<option>${esc(f.id)}</option>`).join('')}</select>
      <button id="cRun">Chạy conformance (smoke thật)</button>
      <div id="cOut" class="dim" style="margin-top:8px"></div>
    </div>
    <div class="card"><h3 style="margin-top:0">4. Skills</h3>
      <button id="skSync">Sync KB → AGENTS.md + CLAUDE.md</button>
      <span id="skOut" class="dim"></span>
    </div>`;
  page.querySelectorAll('[data-install]').forEach((b) => {
    b.onclick = async () => {
      logLine('▶ install ' + b.dataset.install);
      const r = await api.invoke('install:worker', b.dataset.install);
      logLine((r.ok ? '✓ ' : '✗ ') + r.detail);
      route();
    };
  });
  page.querySelectorAll('[data-auth]').forEach((b) => {
    b.onclick = () => alert(`Login: mở terminal chạy CLI này (OAuth ${b.dataset.auth === 'claude' ? 'anthropic' : 'openai'}) — hoặc cấu hình key/provider ở mục 2 bên dưới.`);
  });
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
  $('#cRun').onclick = async () => {
    $('#cOut').textContent = 'đang chạy (smoke thật, ~30-60s)…';
    const r = await api.invoke('conformance:run', $('#cWorker').value);
    $('#cOut').innerHTML = (r.cases || []).map((c) => `[${c.status}] ${esc(c.case)} — ${esc(c.detail)}`).join('<br>') + `<br><b>badge: ${r.badge ?? '?'}</b>`;
  };
  $('#skSync').onclick = async () => {
    const r = await api.invoke('skills:sync');
    $('#skOut').textContent = `✓ ${r.entries} KB → ${r.files.join(' + ')}`;
  };
  api.on('install:log', (line) => logLine(line));
}

// ---------- Settings ----------
async function renderSettings() {
  const s = await loadSettings();
  page.innerHTML = `
    <h2>Settings</h2>
    <div class="card">
      <label>Repos (mỗi dòng 1 đường dẫn)</label>
      <textarea id="sRepos" rows="4">${esc(s.repos.join('\n'))}</textarea>
      <label>Orchestrator worker (chat brain)</label>
      <select id="sWorker"><option ${s.orchestratorWorker === 'claude' ? 'selected' : ''}>claude</option><option ${s.orchestratorWorker === 'codex' ? 'selected' : ''}>codex</option></select>
      <label>Templates dir (để trống = mặc định)</label><input id="sTpl" value="${esc(s.templatesDir)}" />
      <label><input type="checkbox" id="sAuto" ${s.autoApprovePlan ? 'checked' : ''}/> Tự duyệt plan (pipeline không dừng hỏi)</label>
      <label><input type="checkbox" id="sHooks" ${s.hooksEnabled ? 'checked' : ''}/> Guard hook pre-execution</label>
      <label><input type="checkbox" id="sSync" ${s.skillSync ? 'checked' : ''}/> Skill-sync trước dispatch</label>
      <button id="sSave">Lưu</button>
      <button class="secondary" id="sUpdate">Kiểm tra bản cập nhật</button>
      <span id="sUpdateOut" class="dim"></span>
    </div>`;
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
    api.on('update:status', (d) => {
      $('#sUpdateOut').textContent = d.status === 'downloaded' ? `✓ v${d.version} đã tải — restart để cập nhật` : d.status;
    });
    await api.invoke('update:check');
    setTimeout(() => { if ($('#sUpdateOut')) $('#sUpdateOut').textContent += ' — nếu chưa publish Release thì đây là bình thường.'; }, 4000);
  };
}

// ---------- Terminal (P-D3: node-pty prebuilt) ----------
async function renderTerminal() {
  const s = await loadSettings();
  page.innerHTML = `
    <h2>Terminal — ${esc(s.activeRepo || 'repo active')}</h2>
    <div class="card" style="padding:6px">
      <pre id="term" style="background:#0c0c0c;color:#d4d4d4;height:calc(100vh - 240px);overflow-y:auto;margin:0;padding:8px;font-size:12px;white-space:pre-wrap;word-break:break-all"></pre>
      <div class="chatbar" style="margin-top:6px">
        <input id="termIn" placeholder="Gõ lệnh… (Enter)" autocomplete="off" />
        <button id="termNew">Session mới</button>
      </div>
      <div class="dim" style="font-size:10px;margin-top:4px">Terminal nhúng chạy trong repo active — worker CLI có thể chạy trực tiếp tại đây.</div>
    </div>`;
  const TERM_ID = 'main';
  let created = false;
  const termEl = $('#term');
  api.on('terminal:data', (d) => {
    if (d.id !== TERM_ID) return;
    termEl.textContent += d.data;
    termEl.scrollTop = termEl.scrollHeight;
  });
  api.on('terminal:exit', (d) => {
    if (d.id === TERM_ID) termEl.textContent += `\r\n[session exited ${d.exitCode}]`;
  });
  const create = () => api.invoke('terminal:create', { id: TERM_ID, cwd: s.activeRepo, cols: 110, rows: 30 });
  $('#termNew').onclick = async () => {
    await api.invoke('terminal:kill', TERM_ID);
    termEl.textContent = '';
    created = false;
    await create();
  };
  $('#termIn').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const cmd = $('#termIn').value;
      $('#termIn').value = '';
      if (!created) { await create(); created = true; }
      await api.invoke('terminal:input', { id: TERM_ID, data: cmd + '\r' });
    }
  });
  await create();
  created = true;
  termEl.textContent += 'Terminal sẵn sàng (powershell trong repo active).\r\n';
  $('#termIn').focus();
}

// ---------- router ----------
const ROUTES = { dashboard: renderDashboard, chat: renderChat, terminal: renderTerminal, transcript: renderTranscript, matrix: renderMatrix, wizard: renderWizard, settings: renderSettings };
function route() {
  const hash = (location.hash || '#/dashboard').replace('#/', '');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === hash));
  (ROUTES[hash] || renderDashboard)();
}
window.addEventListener('hashchange', route);
loadSettings().then(route);

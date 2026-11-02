// Orchestra Desktop — renderer (vanilla, không framework)
// Bố cục agent-first: Chat là màn hình chính (composer ở đáy), Dashboard/Fleet là panel phụ.
const api = window.orchestra ?? devStub(); // stub chỉ dùng khi chạy renderer ngoài Electron (dev/preview)
const page = document.getElementById('page');
const composerWrap = document.getElementById('composerWrap');
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const split = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

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
  $('#stWorker').textContent = `Orchestra · model: ${SETTINGS?.brainModel || '—'}`;
  $('#stRepo').textContent = 'repo: ' + (baseName(repo()) || '(chưa chọn)');
  const stFleet = $('#stFleet');
  if (FLEET.length) {
    const n = fleetInstalled();
    stFleet.innerHTML = `<span class="dot ${n ? 'ok' : 'err'}"></span> ${n}/${FLEET.length} workers`;
  }
  // composer: chỉ chọn model Orchestra — worker do Orchestra điều phối, user không chọn ở chat
  if (SETTINGS) {
    const cur = SETTINGS.brainModel;
    $('#cbModel').innerHTML = '<option value="">(chọn model)</option>' + [...new Set([cur, ...BRAIN_MODELS].filter(Boolean))]
      .map((id) => `<option value="${esc(id)}" ${id === cur ? 'selected' : ''}>${esc(id)}</option>`).join('');
  }
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

// đổi model Orchestra → lưu ngay (main reset hội thoại)
$('#cbModel').addEventListener('change', async (e) => {
  SETTINGS = await api.invoke('settings:set', { ...SETTINGS, brainModel: e.target.value });
  renderChrome();
  if (location.hash.startsWith('#/chat') || !location.hash) renderChat();
});
$('#cbNew').addEventListener('click', async () => {
  await api.invoke('chat:reset');
  renderChat();
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
  add('greet', '◆ Orchestra sẵn sàng. Mô tả task — Orchestra tự khảo sát repo và giao việc cho worker.');
  const input = $('#chatInput');
  const send = async () => {
    const t = input.value.trim();
    if (!t) return;
    input.value = '';
    input.style.height = 'auto';
    add('user', t);
    add('orch pending', '…đang xử lý');
    const stop = $('#chatStop');
    stop.hidden = false;
    try {
      await api.invoke('chat:exchange', { text: t });
    } finally {
      stop.hidden = true;
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
        <label>Model</label><select id="dModel">${modelOptions('', '', '(theo policy)')}</select>
        <button id="dGo">Dispatch</button>
      </div>
      <div class="card"><h3>Run pipeline</h3>
        <label>Template</label><select id="pTpl"><option>feature-dev</option><option>hotfix</option></select>
        <label>Goal</label><textarea id="pGoal" rows="2"></textarea>
        <label>Scope</label><input id="pScope" value="src/payment/**" />
        <label>Model (implement + fixer)</label><select id="pModel">${modelOptions('', '', '(theo policy)')}</select>
        <button id="pGo">Chạy pipeline</button>
      </div>
    </div>
    <div class="card"><h3>Task records</h3>
      <table><thead><tr><th>id</th><th>node</th><th>worker</th><th>exit</th><th>scope</th><th>files</th></tr></thead>
      <tbody>${tasks.map((t) => `<tr class="click-row"><td class="mono">${esc(t.id)}</td><td>${esc(t.node)}</td><td>${esc(t.worker)}</td><td>${t.exit ?? '-'}</td><td>${t.scopeOk ? '<span class="ok">OK</span>' : '<span class="err">VIOLATION</span>'}</td><td>${t.files}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">chưa có</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card"><h3>Live stream</h3><div id="log"></div></div>`;
  page.querySelectorAll('.click-row').forEach((el) => { el.onclick = () => (location.hash = '#/transcript'); });
  $('#dWorker').onchange = () => { $('#dModel').innerHTML = modelOptions($('#dWorker').value, '', '(theo policy)'); };
  $('#btnToWizard').onclick = () => { settingsTab = 'workers'; location.hash = '#/settings'; };
  $('#dGo').onclick = async () => {
    const goal = $('#dGoal').value.trim();
    if (!goal) return alert('Nhập goal');
    logLine('▶ dispatch: ' + goal);
    const r = await api.invoke('dispatch', { goal, scope: split($('#dScope').value), worker: $('#dWorker').value, model: $('#dModel').value });
    if (r.error) return logLine('✗ ' + r.error);
    logLine(`${r.result.ok ? '✓ OK' : '✗ FAILED'} ${r.result.taskId}${r.override && r.override.startsWith('override') ? ' — ' + r.override : ''}`);
    loadSideTasks();
  };
  $('#pGo').onclick = async () => {
    const goal = $('#pGoal').value.trim();
    if (!goal) return alert('Nhập goal');
    logLine('▶ pipeline: ' + goal);
    const r = await api.invoke('pipeline:run', { template: $('#pTpl').value, goal, scope: split($('#pScope').value), model: $('#pModel').value });
    if (r.error) return logLine('✗ ' + r.error);
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
      <table><tbody>${tasks.map((t) => `<tr class="click-row" data-info="${esc(`${t.id} — ${t.node}/${t.worker} exit=${t.exit}`)}"><td class="mono">${esc(t.id)}</td><td>${esc(t.node)}</td><td>${esc(t.worker)}</td><td>${t.exit ?? '-'}</td><td>${t.files} file</td></tr>`).join('') || '<tr><td class="dim">chưa có record</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card"><h3>Live stream (mọi run)</h3><div id="log"></div></div>`;
  page.querySelectorAll('[data-info]').forEach((el) => { el.onclick = () => alert(el.dataset.info); });
  on('dispatch:event', (d) => logLine(`[${d.t}] ${JSON.stringify(d.payload).slice(0, 160)}`));
  on('pipeline:log', (line) => logLine(line));
  on('install:log', (line) => logLine('[install] ' + line));
}

// ---------- Policy Matrix ----------
async function renderMatrix() {
  composerWrap.hidden = true;
  page.classList.remove('fill');
  const html = await api.invoke('matrix:html');
  if (!html) {
    page.innerHTML = `<h2>Policy Matrix</h2><div class="card dim">Chưa chọn repo (hoặc repo không tồn tại) — thêm repo ở Cài đặt.</div>`;
    return;
  }
  // <script> inline của policyMatrixHtml bị CSP chặn → bỏ; parent gắn click qua contentDocument (srcdoc cùng origin)
  page.innerHTML = `<h2>Policy Matrix</h2><div class="card" id="iframeWrap"><iframe srcdoc="${esc(html.replace(/<script[\s\S]*?<\/script>/gi, ''))}"></iframe></div>`;
  const frame = page.querySelector('iframe');
  frame.addEventListener('load', () => {
    frame.contentDocument.addEventListener('click', async (e) => {
      const td = e.target.closest?.('td[data-role]');
      if (!td) return;
      const r = await api.invoke('matrix:promote', { role: td.dataset.role, cli: td.dataset.cli });
      if (!r.ok) alert(r.detail);
      renderMatrix();
    });
  });
}

// ---------- Cài đặt (1 nút duy nhất — gộp Settings + Setup Wizard, kiểu tab như ZCode) ----------
let settingsTab = 'chung';
async function renderSettings() {
  composerWrap.hidden = true;
  page.classList.remove('fill');
  const [s] = await Promise.all([loadSettings(), loadFleet()]);
  const TABS = [['chung', 'Chung'], ['workers', 'Workers'], ['providers', 'Providers'], ['conformance', 'Conformance'], ['skills', 'Skills']];
  const KINDS = ['anthropic', 'openai', 'anthropic-compatible', 'openai-compatible'];
  const FORMATS = ['messages', 'chat', 'responses'];
  const pane = (id, html) => `<div class="tabpane" id="tab-${id}" ${settingsTab === id ? '' : 'hidden'}>${html}</div>`;
  page.innerHTML = `
    <h2>Cài đặt</h2>
    <div class="tabs">${TABS.map(([id, label]) => `<button class="tab ${settingsTab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}</div>
    ${pane('chung', `
      <div class="card">
        <label>Repos (mỗi dòng 1 đường dẫn)</label>
        <textarea id="sRepos" rows="4" class="mono">${esc(s.repos.join('\n'))}</textarea>
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
    ${pane('providers', `
      <div class="card">
        <h3>Orchestra Router — providers</h3>
        <div class="dim">Router: <span id="rStatus">…</span></div>
        <table><thead><tr><th>id</th><th>kind</th><th>baseUrl</th><th>formats</th><th>bật</th><th>key</th><th></th></tr></thead>
        <tbody id="prRows"></tbody></table>
        <div class="row">
          <button class="secondary" id="prImport">Import từ claude/codex config</button>
          <span id="prOut" class="dim"></span>
        </div>
        <label>Model mặc định của router (CLI gửi model không prefix)</label>
        <select id="rDefault"></select>
      </div>
      <div class="card">
        <h3>Thêm / sửa provider</h3>
        <label>id</label><input id="prId" placeholder="my-gw" autocomplete="off" />
        <label>kind</label><select id="prKind">${KINDS.map((k) => `<option>${k}</option>`).join('')}</select>
        <label>Base URL</label><input id="prUrl" placeholder="https://gw.company.com" />
        <label>Formats upstream nói native</label>
        <div class="row">${FORMATS.map((f) => `<label><input type="checkbox" data-fmt="${f}" /> ${f}</label>`).join('')}</div>
        <label>API key (để trống = giữ key cũ)</label><input id="prKey" type="password" autocomplete="off" />
        <label><input type="checkbox" id="prOn" checked /> Bật</label>
        <button id="prSave">Lưu</button>
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
    b.onclick = () => alert(`Login: mở terminal chạy CLI này (OAuth ${b.dataset.auth === 'claude' ? 'anthropic' : 'openai'}) — key/gateway khác cấu hình ở tab Providers.`);
  });
  // tab providers — key không bao giờ về renderer (chỉ hasKey)
  let PROVS = [];
  const refreshModels = async () => {
    await Promise.all([loadModels(), loadBrainModels()]);
    const cur = SETTINGS.routerDefaultModel;
    $('#rDefault').innerHTML = `<option value="">(theo model Orchestra: ${esc(SETTINGS.brainModel || 'chưa chọn')})</option>` +
      MODELS.models.map((id) => `<option value="${esc(id)}" ${id === cur ? 'selected' : ''}>${esc(id)}</option>`).join('');
  };
  const renderProviders = async () => {
    const [list, st] = await Promise.all([api.invoke('providers:list'), api.invoke('router:status')]);
    PROVS = list;
    $('#rStatus').textContent = st.running ? `✓ 127.0.0.1:${st.port} · ${st.providers} provider` : '✗ không chạy';
    $('#prRows').innerHTML = list.map((p) => `<tr>
      <td class="mono">${esc(p.id)}</td><td>${esc(p.kind)}</td><td class="mono">${esc(p.baseUrl)}</td><td>${esc(p.formats.join(', '))}</td>
      <td>${p.enabled ? '✓' : '—'}</td><td>${p.hasKey ? '✓' : '—'}</td>
      <td><button class="secondary" data-pedit="${esc(p.id)}">Sửa</button> <button class="secondary" data-ptest="${esc(p.id)}">Test</button> <button class="secondary" data-pdel="${esc(p.id)}">Xoá</button></td>
    </tr>`).join('') || '<tr><td colspan="7" class="dim">chưa có provider — CLI dùng auth riêng</td></tr>';
    page.querySelectorAll('[data-pedit]').forEach((b) => {
      b.onclick = () => {
        const p = PROVS.find((x) => x.id === b.dataset.pedit);
        $('#prId').value = p.id;
        $('#prKind').value = p.kind;
        $('#prUrl').value = p.baseUrl;
        page.querySelectorAll('[data-fmt]').forEach((c) => { c.checked = p.formats.includes(c.dataset.fmt); });
        $('#prOn').checked = p.enabled;
        $('#prKey').value = '';
      };
    });
    page.querySelectorAll('[data-ptest]').forEach((b) => {
      b.onclick = async () => {
        $('#prOut').textContent = `đang test ${b.dataset.ptest}…`;
        const r = await api.invoke('providers:test', b.dataset.ptest);
        $('#prOut').textContent = r.ok ? `✓ ${b.dataset.ptest}: ${r.count} model` : `✗ ${b.dataset.ptest}: ${r.error}`;
      };
    });
    page.querySelectorAll('[data-pdel]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`Xoá provider '${b.dataset.pdel}' (cả key trong vault)?`)) return;
        await api.invoke('providers:delete', b.dataset.pdel);
        await renderProviders();
      };
    });
    await refreshModels();
  };
  renderProviders();
  $('#prSave').onclick = async () => {
    const cfg = {
      id: $('#prId').value.trim(),
      kind: $('#prKind').value,
      baseUrl: $('#prUrl').value.trim(),
      formats: [...page.querySelectorAll('[data-fmt]')].filter((c) => c.checked).map((c) => c.dataset.fmt),
      enabled: $('#prOn').checked,
    };
    const key = $('#prKey').value;
    const r = await api.invoke('providers:save', { cfg, key: key || undefined });
    $('#prKey').value = '';
    $('#prOut').textContent = r.ok ? `✓ đã lưu ${r.id}` : `✗ ${r.error}`;
    if (r.ok) await renderProviders();
  };
  $('#prImport').onclick = async () => {
    if (!confirm('Đọc ~/.claude/settings.json và ~/.codex/config.toml, lưu gateway + key (vault DPAPI) thành provider claude-gw / codex-gw?')) return;
    const r = await api.invoke('providers:import');
    $('#prOut').textContent = `import: ${r.imported.join(', ') || '(không có)'}${r.skipped.length ? ' · bỏ qua: ' + r.skipped.join('; ') : ''}`;
    await renderProviders();
  };
  $('#rDefault').onchange = async (e) => {
    SETTINGS = await api.invoke('settings:set', { ...SETTINGS, routerDefaultModel: e.target.value });
  };
  // tab conformance
  $('#cRun').onclick = async () => {
    $('#cOut').textContent = 'đang chạy (smoke thật, ~30-60s)…';
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
  await Promise.all([loadFleet(), loadSideTasks(), loadModels(), loadBrainModels()]);
  route();
})();

// Stub API mẫu — chỉ active khi renderer chạy ngoài Electron (preview bằng trình duyệt).
function devStub() {
  const repos = ['C:\\code\\payment-svc'];
  const settings = { activeRepo: repos[0], repos, brainModel: '', routerDefaultModel: '', templatesDir: '', autoApprovePlan: false, hooksEnabled: true, skillSync: true };
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
  const reply = async (ch, p) => {
    if (ch === 'settings:get') return settings;
    if (ch === 'fleet:list') return fleet;
    if (ch === 'tasks:list') return tasks;
    if (ch === 'models:list') return { models: ['gw/claude-opus'], byWorker: { claude: [{ id: 'gw/claude-opus', ok: true, reason: 'gw nói messages' }], codex: [{ id: 'gw/claude-opus', ok: true, reason: 'gw messages (router dịch Responses→Chat/Messages)' }] } };
    if (ch === 'settings:set') return Object.assign(settings, p);
    if (ch === 'brain:models') return { models: ['gw/claude-opus'] };
    if (ch === 'providers:list') return [{ id: 'gw', kind: 'anthropic-compatible', baseUrl: 'https://gw.example.com', formats: ['messages'], enabled: true, hasKey: true }];
    if (ch === 'router:status') return { running: false, port: null, providers: 1 };
    if (ch === 'providers:import') return { imported: [], skipped: ['(stub)'] };
    if (ch === 'matrix:html') return '<h3 style="font-family:monospace">Policy Matrix (preview)</h3>';
    if (ch === 'chat:exchange') setTimeout(() => listeners['chat:message']?.forEach((f) => f({ kind: 'orch', text: '(stub) đã nhận — chạy preview ngoài Electron.' })), 400);
    return { ok: true };
  };
  bus.invoke = reply;
  return bus;
}

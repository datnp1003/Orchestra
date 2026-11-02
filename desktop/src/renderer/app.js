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

// ---------- Sessions (hội thoại đã lưu — click để resume) ----------
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? 'vừa xong' : s < 3600 ? `${Math.floor(s / 60)} phút` : s < 86400 ? `${Math.floor(s / 3600)} giờ` : `${Math.floor(s / 86400)} ngày`;
};
async function loadSessions() {
  const box = $('#sideSessionList');
  const list = await api.invoke('chat:sessions');
  box.innerHTML = list.map((x) => `
    <div class="session-item ${x.active ? 'active' : ''}" data-session="${esc(x.id)}" title="${esc(`${x.title} — ${x.turns} lượt`)}">
      <span class="session-title">${esc(x.title)}</span>
      <span class="session-time">${esc(ago(x.updatedAt))}</span>
    </div>`).join('') || '<div class="side-empty">Chưa có session</div>';
  box.querySelectorAll('[data-session]').forEach((el) => { el.onclick = () => openSession(el.dataset.session); });
}
let openedMsgs = null; // tin nhắn của session vừa mở — renderChat vẽ 1 lần
async function openSession(id) {
  const r = await api.invoke('chat:open', { id });
  if (!r.ok) return alert('✗ ' + r.error);
  openedMsgs = r.messages;
  if (location.hash.startsWith('#/chat') || !location.hash) renderChat();
  else location.hash = '#/chat';
  loadSessions();
}
async function newChat() {
  await api.invoke('chat:reset');
  openedMsgs = null;
  if (location.hash.startsWith('#/chat') || !location.hash) renderChat();
  else location.hash = '#/chat';
  loadSessions();
}

// ---------- chrome clicks ----------
document.getElementById('newChat').onclick = newChat;
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
  loadSessions();
  route(); // nạp lại trang hiện tại với repo mới
});

// đổi model Orchestra → lưu ngay (main reset hội thoại)
$('#cbModel').addEventListener('change', async (e) => {
  SETTINGS = await api.invoke('settings:set', { ...SETTINGS, brainModel: e.target.value });
  renderChrome();
  if (location.hash.startsWith('#/chat') || !location.hash) renderChat();
  loadSessions();
});
$('#cbNew').addEventListener('click', newChat);

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
  for (const m of openedMsgs ?? []) add(m.role, m.text);
  openedMsgs = null;
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
  const [, tasks] = await Promise.all([loadFleet(), api.invoke('tasks:list', { limit: TOP_N }), loadSettings()]);
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
    <div class="card"><h3>Task records — ${TOP_N} mới nhất, click để xem trong Transcript</h3>
      <table><thead><tr><th>id</th><th>node</th><th>worker</th><th>exit</th><th>scope</th><th>files</th></tr></thead>
      <tbody>${tasks.map((t, i) => `<tr class="click-row" data-i="${i}"><td class="mono">${esc(t.id)}</td><td>${esc(t.node)}</td><td>${esc(t.worker)}</td><td>${t.exit ?? '-'}</td><td>${t.scopeOk ? '<span class="ok">OK</span>' : '<span class="err">VIOLATION</span>'}</td><td>${t.files}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">chưa có</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card" id="transcript"></div>`;
  renderTranscript($('#transcript'), tasks);
  if (openTranscript) { openTranscript = false; $('#transcript').scrollIntoView(); }
  $('#dWorker').onchange = () => { $('#dModel').innerHTML = modelOptions($('#dWorker').value, '', '(theo policy)'); };
  $('#btnToWizard').onclick = () => { settingsTab = 'workers'; location.hash = '#/settings'; };
  $('#dGo').onclick = async () => {
    const goal = $('#dGoal').value.trim();
    if (!goal) return alert('Nhập goal');
    logLine('▶ dispatch: ' + goal);
    const r = await api.invoke('dispatch', { goal, scope: split($('#dScope').value), worker: $('#dWorker').value, model: $('#dModel').value });
    if (r.error) return logLine('✗ ' + r.error);
    logLine(`${r.result.ok ? '✓ OK' : '✗ FAILED'} ${r.result.taskId}${r.override && r.override.startsWith('override') ? ' — ' + r.override : ''}`);
  };
  $('#pGo').onclick = async () => {
    const goal = $('#pGoal').value.trim();
    if (!goal) return alert('Nhập goal');
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
  box.innerHTML = `<h3>Transcript</h3><div id="trSel" class="dim">click 1 task ở Task records để xem</div>
    <h3>Live stream (mọi run)</h3><div id="log"></div>`;
  page.querySelectorAll('.click-row[data-i]').forEach((el) => {
    el.onclick = () => {
      const t = tasks[el.dataset.i];
      page.querySelectorAll('.click-row.sel').forEach((r) => r.classList.remove('sel'));
      el.classList.add('sel');
      $('#trSel').textContent = `${t.id} — ${t.node}/${t.worker} exit=${t.exit ?? '-'} scope=${t.scopeOk ? 'OK' : 'VIOLATION'} files=${t.files}`;
      box.scrollIntoView({ block: 'nearest' });
    };
  });
  on('dispatch:event', (d) => logLine(`[${d.t}] ${JSON.stringify(d.payload).slice(0, 160)}`));
  on('pipeline:log', (line) => logLine(line));
  on('install:log', (line) => logLine('[install] ' + line));
}

// ---------- Policy Matrix (tab trong Cài đặt) ----------
async function renderMatrix(box) {
  const html = await api.invoke('matrix:html');
  if (!html) {
    box.innerHTML = `<div class="card dim">Chưa chọn repo (hoặc repo không tồn tại) — thêm repo ở tab Chung.</div>`;
    return;
  }
  // <script> inline của policyMatrixHtml bị CSP chặn → bỏ; parent gắn click qua contentDocument (srcdoc cùng origin)
  box.innerHTML = `<div class="card" id="iframeWrap"><iframe srcdoc="${esc(html.replace(/<script[\s\S]*?<\/script>/gi, ''))}"></iframe></div>`;
  const frame = box.querySelector('iframe');
  frame.addEventListener('load', () => {
    frame.contentDocument.addEventListener('click', async (e) => {
      const td = e.target.closest?.('td[data-role]');
      if (!td) return;
      const r = await api.invoke('matrix:promote', { role: td.dataset.role, cli: td.dataset.cli });
      if (!r.ok) alert(r.detail);
      renderMatrix(box);
    });
  });
}

// ---------- Cài đặt (1 nút duy nhất — gộp Settings + Setup Wizard, kiểu tab như ZCode) ----------
let settingsTab = 'chung';
async function renderSettings() {
  composerWrap.hidden = true;
  page.classList.remove('fill');
  const [s] = await Promise.all([loadSettings(), loadFleet()]);
  const TABS = [['chung', 'Chung'], ['workers', 'Workers'], ['providers', 'Providers'], ['conformance', 'Conformance'], ['skills', 'Skills'], ['matrix', 'Policy Matrix']];
  const KINDS = [['anthropic', 'anthropic'], ['openai', 'openai'], ['anthropic-compatible', 'anthropic-compatible'], ['openai-compatible', 'openai-compatible'],
    ['oauth-anthropic', 'OAuth Anthropic (Claude Pro/Max)'], ['oauth-openai', 'OAuth OpenAI (ChatGPT Plus/Pro)']];
  const isOAuth = (k) => k.startsWith('oauth-');
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
          <div><b>${esc(f.display || f.id)}</b> <span class="mono dim">${esc(f.id)}</span> <span class="dim">· ${esc(f.installed ? f.version ?? 'đã cài' : 'chưa cài')}</span>
            <div class="dim">${f.router ? 'Auth: qua Orchestra router' : 'chưa hỗ trợ router'}</div></div>
          <button class="secondary" data-install="${esc(f.id)}">${f.installed ? 'Cài lại' : 'Cài'}</button>
        </div>`).join('')}
        <div id="log" style="margin-top:10px"></div>
      </div>`)}
    ${pane('providers', `
      <div class="card">
        <h3>Orchestra Router — providers</h3>
        <div class="dim">Router: <span id="rStatus">…</span></div>
        <table><thead><tr><th>id</th><th>kind</th><th>baseUrl</th><th>formats</th><th>bật</th><th>key</th><th></th></tr></thead>
        <tbody id="prRows"></tbody></table>
        <div class="row"><span id="prOut" class="dim"></span></div>
        <div class="row" id="prCodeRow" hidden>
          <input id="prCode" placeholder="dán code#state từ trang Anthropic" autocomplete="off" />
          <button id="prCodeOk">Xác nhận</button>
        </div>
        <label>Model mặc định của router (CLI gửi model không prefix)</label>
        <select id="rDefault"></select>
      </div>
      <div class="card">
        <h3>Thêm / sửa provider</h3>
        <div class="quick-add" id="prQuickKey"></div>
        <div class="side-title">OAuth</div>
        <div class="quick-add" id="prQuickOAuth"></div>
        <label>id</label><input id="prId" placeholder="my-gw" autocomplete="off" />
        <label>kind</label><select id="prKind">${KINDS.map(([k, label]) => `<option value="${k}">${label}</option>`).join('')}</select>
        <div id="prRisk" class="risk" hidden>
          <b>⚠ OAuth subscription — rủi ro</b>
          <ul>
            <li>Dùng token subscription ngoài client chính chủ có thể vi phạm điều khoản Anthropic/OpenAI → có thể bị chặn hoặc KHOÁ TÀI KHOẢN.</li>
            <li>Router phải tự nhận là Claude Code/Codex CLI (client id + header/system prompt) — đây là giả danh client.</li>
            <li>Refresh token xoay vòng: KHÔNG dùng chung phiên đăng nhập với codex/claude CLI trên máy (đăng nhập riêng cho Orchestra); dùng lại token cũ có thể đăng xuất toàn bộ phiên.</li>
            <li>Token OAuth có quyền cấp tài khoản; lưu trong vault DPAPI (chỉ chống user khác trên máy).</li>
            <li>Hạn mức subscription (5h/tuần) cạn nhanh khi chạy nhiều worker; endpoint không công khai, có thể hỏng khi CLI cập nhật.</li>
          </ul>
          <label><input type="checkbox" id="prRiskOk" /> Tôi hiểu rủi ro</label>
          <label>Models (phân cách bằng dấu phẩy; trống = mặc định)</label><input id="prModels" autocomplete="off" />
        </div>
        <div id="prKeyed">
          <label>Base URL</label><input id="prUrl" placeholder="https://gw.company.com" />
          <label>Formats upstream nói native</label>
          <div class="row">${FORMATS.map((f) => `<label><input type="checkbox" data-fmt="${f}" /> ${f}</label>`).join('')}</div>
          <label>API key (để trống = giữ key cũ)</label><input id="prKey" type="password" autocomplete="off" />
        </div>
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
      </div>`)}
    ${pane('matrix', '<div id="matrixBox"></div>')}`;
  renderMatrix($('#matrixBox'));
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
  // quick-add kiểu 9router: [kind, nhãn, id gợi ý, baseUrl mặc định, formats mặc định (= DEFAULT_FORMATS của router)]
  const QUICK = [
    ['anthropic', '＋ Anthropic API', 'anthropic', 'https://api.anthropic.com', ['messages']],
    ['openai', '＋ OpenAI API', 'openai', 'https://api.openai.com', ['chat', 'responses']],
    ['anthropic-compatible', '＋ Anthropic Compatible', 'anthropic-compat', '', ['messages']],
    ['openai-compatible', '＋ OpenAI Compatible', 'openai-compat', '', ['chat']],
    ['oauth-anthropic', 'Claude Code (Claude Pro/Max)', 'claude-code', '', ['messages']],
    ['oauth-openai', 'OpenAI Codex (ChatGPT Plus/Pro)', 'codex', '', ['responses']],
  ];
  const renderQuick = () => {
    const btn = ([kind, label]) => `<button class="secondary" data-quick="${kind}">${esc(label)}<span class="dim">${PROVS.filter((p) => p.kind === kind).length} đã kết nối</span></button>`;
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
  const OAUTH_ST = { none: 'chưa đăng nhập', ok: 'đã đăng nhập', expired: 'hết hạn (tự refresh)', needsLogin: 'cần đăng nhập lại' };
  const refreshModels = async () => {
    await Promise.all([loadModels(), loadBrainModels()]);
    const cur = SETTINGS.routerDefaultModel;
    $('#rDefault').innerHTML = `<option value="">(theo model Orchestra: ${esc(SETTINGS.brainModel || 'chưa chọn')})</option>` +
      MODELS.models.map((id) => `<option value="${esc(id)}" ${id === cur ? 'selected' : ''}>${esc(id)}</option>`).join('');
  };
  const renderProviders = async () => {
    const [list, st] = await Promise.all([api.invoke('providers:list'), api.invoke('router:status')]);
    PROVS = list;
    renderQuick();
    $('#rStatus').textContent = st.running ? `✓ 127.0.0.1:${st.port} · ${st.providers} provider` : '✗ không chạy';
    $('#prRows').innerHTML = list.map((p) => `<tr>
      <td class="mono">${esc(p.id)}</td><td>${esc(p.kind)}${isOAuth(p.kind) ? ' <span class="badge-risk">OAuth ⚠</span>' : ''}</td><td class="mono">${esc(p.baseUrl)}</td><td>${esc(p.formats.join(', '))}</td>
      <td>${p.enabled ? '✓' : '—'}</td><td>${isOAuth(p.kind) ? `<span class="${p.oauthStatus === 'ok' ? 'ok' : 'warn'}">${esc(OAUTH_ST[p.oauthStatus] ?? p.oauthStatus)}</span>` : p.hasKey ? '✓' : '—'}</td>
      <td>${isOAuth(p.kind) ? `<button class="secondary" data-plogin="${esc(p.id)}">Đăng nhập</button> ` : ''}<button class="secondary" data-pedit="${esc(p.id)}">Sửa</button> <button class="secondary" data-ptest="${esc(p.id)}">Test</button> <button class="secondary" data-pdel="${esc(p.id)}">Xoá</button></td>
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
        $('#prRiskOk').checked = !!p.riskAcknowledged;
        $('#prModels').value = (p.models ?? []).join(', ');
        syncKind();
      };
    });
    page.querySelectorAll('[data-plogin]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.plogin;
        const p = PROVS.find((x) => x.id === id);
        $('#prOut').textContent = p.kind === 'oauth-openai' ? `đang chờ đăng nhập OpenAI trong trình duyệt (${id}, tối đa 5 phút)…` : `mở trình duyệt đăng nhập Claude (${id})…`;
        const r = await api.invoke('oauth:start', { id });
        if (!r.ok) { $('#prOut').textContent = `✗ ${r.error}`; return; }
        if (p.kind === 'oauth-anthropic') {
          oauthWaiting = id;
          $('#prCodeRow').hidden = false;
          $('#prCode').focus();
          $('#prOut').textContent = `dán code#state hiện ở trang Anthropic vào ô bên dưới (${id})`;
        } else {
          $('#prOut').textContent = `✓ ${id} đã đăng nhập`;
          await renderProviders();
        }
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
  $('#prCodeOk').onclick = async () => {
    const r = await api.invoke('oauth:finish', { id: oauthWaiting, code: $('#prCode').value.trim() });
    $('#prCode').value = '';
    $('#prOut').textContent = r.ok ? `✓ ${oauthWaiting} đã đăng nhập` : `✗ ${r.error}`;
    if (r.ok) { $('#prCodeRow').hidden = true; await renderProviders(); }
  };
  $('#prSave').onclick = async () => {
    const kind = $('#prKind').value;
    if (isOAuth(kind) && !$('#prRiskOk').checked) { $('#prOut').textContent = '✗ phải tick "Tôi hiểu rủi ro" trước khi lưu provider OAuth'; return; }
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
    $('#prOut').textContent = r.ok ? `✓ đã lưu ${r.id}` : `✗ ${r.error}`;
    if (r.ok) await renderProviders();
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
// terminal: route giữ nguyên nhưng không có link trên UI — tạm ẩn theo yêu cầu
const TITLES = { chat: 'Chat — Orchestrator', dashboard: 'Dashboard', terminal: 'Terminal', settings: 'Cài đặt' };
const ROUTES = { chat: renderChat, dashboard: renderDashboard, terminal: renderTerminal, settings: renderSettings };
function route() {
  let hash = (location.hash || '#/chat').replace('#/', '');
  if (hash === 'wizard') hash = 'settings'; // hash cũ còn hoạt động
  if (hash === 'transcript') { openTranscript = true; location.hash = '#/dashboard'; return; } // Transcript giờ là section trong Dashboard
  if (hash === 'matrix') { settingsTab = 'matrix'; location.hash = '#/settings'; return; } // Policy Matrix giờ là tab trong Cài đặt (hashchange → route lại)
  document.querySelectorAll('#sidebar a[data-page]').forEach((a) => a.classList.toggle('active', a.dataset.page === hash));
  document.getElementById('btnSettings').classList.toggle('active', hash === 'settings');
  $('#pageTitle').textContent = TITLES[hash] || 'Orchestra';
  (ROUTES[hash] || renderChat)();
}
on('nav', (p) => { location.hash = '#/' + p; route(); });
window.addEventListener('hashchange', route);

// ---------- init ----------
(async () => {
  await loadSettings();
  await Promise.all([loadFleet(), loadSessions(), loadModels(), loadBrainModels()]);
  route();
})();

// Stub API mẫu — chỉ active khi renderer chạy ngoài Electron (preview bằng trình duyệt).
function devStub() {
  const repos = ['C:\\code\\payment-svc'];
  const settings = { activeRepo: repos[0], repos, brainModel: '', routerDefaultModel: '', templatesDir: '', autoApprovePlan: false, hooksEnabled: true, skillSync: true };
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
    if (ch === 'models:list') return { models: ['gw/claude-opus'], byWorker: { claude: [{ id: 'gw/claude-opus', ok: true, reason: 'gw nói messages' }], codex: [{ id: 'gw/claude-opus', ok: true, reason: 'gw messages (router dịch Responses→Chat/Messages)' }] } };
    if (ch === 'settings:set') return Object.assign(settings, p);
    if (ch === 'brain:models') return { models: ['gw/claude-opus'] };
    if (ch === 'providers:list') return [{ id: 'gw', kind: 'anthropic-compatible', baseUrl: 'https://gw.example.com', formats: ['messages'], enabled: true, hasKey: true },
      { id: 'cc', kind: 'oauth-anthropic', baseUrl: 'https://api.anthropic.com', formats: ['messages'], enabled: true, hasKey: false, riskAcknowledged: true, models: ['claude-sonnet-5-5'], oauthStatus: 'none', expiresAt: null }];
    if (ch === 'router:status') return { running: false, port: null, providers: 1 };
    if (ch === 'chat:sessions') return [{ id: '2026-11-02T08-00-00-000Z', title: 'Thêm cổng thanh toán X', updatedAt: new Date().toISOString(), turns: 2, active: false }];
    if (ch === 'chat:open') return { ok: true, messages: [{ role: 'user', text: 'Thêm cổng thanh toán X' }, { role: 'orch', text: '(stub) session đã mở' }] };
    if (ch === 'matrix:html') return '<h3 style="font-family:monospace">Policy Matrix (preview)</h3>';
    if (ch === 'chat:exchange') setTimeout(() => listeners['chat:message']?.forEach((f) => f({ kind: 'orch', text: '(stub) đã nhận — chạy preview ngoài Electron.' })), 400);
    return { ok: true };
  };
  bus.invoke = reply;
  return bus;
}

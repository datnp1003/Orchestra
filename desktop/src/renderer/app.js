// Orchestra Desktop — renderer (vanilla, no framework)
// Agent-first layout: Chat is the main screen (composer at the bottom), Dashboard/Fleet are secondary panels.
const api = window.orchestra ?? devStub(); // stub only used when running the renderer outside Electron (dev/preview)
const page = document.getElementById('page');
const composerWrap = document.getElementById('composerWrap');
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const split = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------- i18n: desktop.* dict from main (i18n:get); same semantics as t() in prototype/src/i18n ----------
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
let BRAIN_MODELS = []; // Orchestra brain models (router /v1/models)

// ---------- event bus: register listeners exactly once, new routes only attach handlers ----------
const handlers = {};
for (const ch of ['dispatch:event', 'pipeline:log', 'install:log', 'chat:message', 'chat:step', 'terminal:data', 'terminal:exit', 'update:status', 'nav', 'approval:request', 'approval:resolved', 'approval:focus', 'fleet:changed']) {
  api.on(ch, (d) => handlers[ch]?.(d));
}
const on = (ch, fn) => { handlers[ch] = fn; };
on('fleet:changed', (list) => setFleet(list)); // main's background probe done → pill + visible fleet table

// ---------- shared data ----------
async function loadSettings() {
  SETTINGS = await api.invoke('settings:get');
  renderChrome();
  return SETTINGS;
}
// main returns cache immediately (CLI probe runs in background) — pages don't await this before drawing
async function loadFleet() {
  setFleet(await api.invoke('fleet:list'));
  return FLEET;
}
function setFleet(list) {
  FLEET = list;
  renderChrome();
  paintFleet();
}
async function loadModels() {
  MODELS = await api.invoke('models:list');
  renderChrome();
  // Dashboard draws before models arrive (cold upstream ~3s) → patch the 2 dropdowns, keep selection
  for (const [id, worker] of [['#dModel', $('#dWorker')?.value || ''], ['#pModel', '']]) {
    const sel = $(id);
    if (sel) sel.innerHTML = modelOptions(worker, sel.value, t('desktop.dash.byPolicy'));
  }
  return MODELS;
}
async function loadBrainModels() {
  BRAIN_MODELS = (await api.invoke('brain:models')).models || [];
  renderChrome();
}
// model <option>: '' = default; empty worker (auto) = all router models; models the worker can't run → disabled + reason
function modelOptions(worker, cur, defLabel) {
  const list = worker ? MODELS.byWorker[worker] || [] : MODELS.models.map((id) => ({ id, ok: true, reason: '' }));
  return `<option value="">${esc(defLabel)}</option>` + list.map((m) =>
    `<option value="${esc(m.id)}" title="${esc(m.reason)}" ${m.id === cur ? 'selected' : ''} ${m.ok ? '' : 'disabled'}>${esc(m.id)}</option>`).join('');
}
// searchable model dropdown (hundreds of router models): the native <select> stays the source of truth, hidden —
// callers keep using .value / innerHTML / 'change'. A button shows the pick; its popover = search box + filtered list.
// ↑/↓ move, Enter picks, Esc closes. Select re-rendered (innerHTML) → observer refreshes the label.
function modelSearch(sel) {
  if (!sel || sel.dataset.search) return;
  sel.dataset.search = '1';
  sel.hidden = true;
  const wrap = document.createElement('span');
  wrap.className = 'msel';
  wrap.innerHTML = '<button type="button" class="secondary msel-btn" aria-haspopup="listbox" aria-expanded="false"></button>' +
    '<div class="msel-pop" hidden><input type="search" class="msel-q" autocomplete="off" /><div class="msel-list" role="listbox"></div></div>';
  sel.after(wrap);
  const btn = wrap.querySelector('.msel-btn');
  const pop = wrap.querySelector('.msel-pop');
  const q = wrap.querySelector('.msel-q');
  const list = wrap.querySelector('.msel-list');
  q.placeholder = t('desktop.model.search');
  q.setAttribute('aria-label', t('desktop.model.search'));
  let items = [];
  let active = 0;
  const label = () => {
    const o = sel.selectedOptions[0];
    btn.innerHTML = `<span class="msel-txt">${esc(o ? o.text : '')}</span><span aria-hidden="true">▾</span>`;
    btn.title = o?.value ? o.text : sel.title;
  };
  const draw = () => {
    const s = q.value.trim().toLowerCase();
    items = [...sel.options].filter((o) => !s || o.text.toLowerCase().includes(s));
    active = Math.max(0, items.findIndex((o) => o.selected && !o.disabled));
    list.innerHTML = items.map((o, i) =>
      `<div class="msel-item${i === active ? ' active' : ''}" role="option" data-i="${i}" aria-selected="${o.selected}" aria-disabled="${o.disabled}" title="${esc(o.title || o.text)}">${esc(o.text)}</div>`).join('') ||
      `<div class="msel-empty">${esc(t('desktop.model.matches', { n: 0 }))}</div>`;
    q.title = s ? t('desktop.model.matches', { n: items.length }) : '';
  };
  const move = (d) => {
    if (!items.length) return;
    active = (active + d + items.length) % items.length;
    list.querySelectorAll('.msel-item').forEach((el, i) => el.classList.toggle('active', i === active));
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const open = () => {
    q.value = '';
    draw();
    // open toward the larger side (composer sits at the bottom once chat has messages); list never overflows the window
    const r = btn.getBoundingClientRect();
    const below = innerHeight - r.bottom;
    const up = below < 320 && r.top > below;
    wrap.classList.toggle('up', up);
    list.style.maxHeight = Math.max(120, Math.min(280, (up ? r.top : below) - 64)) + 'px';
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    q.focus();
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (i) => {
    const o = items[i];
    if (!o || o.disabled) return;
    close();
    btn.focus();
    if (o.selected) return;
    sel.value = o.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    label();
  };
  btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden ? open() : close(); });
  pop.addEventListener('click', (e) => e.stopPropagation());
  list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the search box
  list.addEventListener('click', (e) => { const it = e.target.closest('.msel-item'); if (it) pick(+it.dataset.i); });
  q.addEventListener('input', draw);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); btn.focus(); }
    else if (e.key === 'Tab') close();
  });
  sel.addEventListener('change', label);
  new MutationObserver(label).observe(sel, { childList: true, subtree: true, attributes: true });
  label();
}

// open session: projectId null = chat outside a project (global memory only); started = has messages (no longer the empty screen)
let CHAT = { projectId: null, projectName: '', started: false };
const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const fleetInstalled = () => FLEET.filter((f) => f.installed).length;
// single color source for every fleet display: has worker = green, none = grey
const fleetDot = (n) => (n ? 'ok' : '');

// session's project/repo: always in statusbar; in header only while on Chat
function renderRepo() {
  const r = CHAT.projectId ? SETTINGS?.activeRepo || '' : '';
  $('#stRepo').textContent = CHAT.projectId ? `${CHAT.projectName} · repo: ${baseName(r) || '—'}` : t('desktop.chat.global');
  $('#stRepo').title = r;
  const onChat = onChatPage();
  $('#pageRepo').textContent = onChat ? CHAT.projectName || t('desktop.chat.global') : '';
  $('#pageRepo').title = onChat ? r : '';
}
const onChatPage = () => !location.hash || location.hash.startsWith('#/chat');

// ---------- Permission mode (plan / ask / auto / full) — main enforces at the tool layer; this only selects + displays ----------
const MODES = ['plan', 'ask', 'auto', 'full'];
function renderMode() {
  const m = SETTINGS?.permissionMode || 'ask';
  $('#cbMode').textContent = `${t('desktop.mode.' + m)} ▾`;
  $('#stMode').textContent = t('desktop.mode.status', { mode: t('desktop.mode.' + m) });
  $('#modeMenu').innerHTML = MODES.map((x) => `
    <button class="mode-item" role="menuitemradio" aria-checked="${x === m}" data-mode="${x}">
      <span class="mode-check">${x === m ? '✓' : ''}</span>
      <span><b>${esc(t('desktop.mode.' + x))}</b><span class="dim">${esc(t('desktop.mode.' + x + 'Desc'))}</span></span>
    </button>`).join('');
}
$('#cbMode').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#modeMenu').hidden = !$('#modeMenu').hidden;
  if (!$('#modeMenu').hidden) $('#modeMenu [aria-checked="true"]')?.focus();
});
document.addEventListener('click', () => {
  $('#modeMenu').hidden = true;
  for (const w of document.querySelectorAll('.msel')) { w.querySelector('.msel-pop').hidden = true; w.querySelector('.msel-btn').setAttribute('aria-expanded', 'false'); }
});
$('#modeMenu').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('#modeMenu').hidden = true; $('#cbMode').focus(); }
});
$('#modeMenu').addEventListener('click', async (e) => {
  e.stopPropagation();
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  $('#modeMenu').hidden = true;
  const prev = SETTINGS.permissionMode;
  SETTINGS = await api.invoke('settings:set', { ...SETTINGS, permissionMode: b.dataset.mode });
  renderChrome();
  if (SETTINGS.permissionMode !== 'full' || prev === 'full') return;
  // 1-line warning when switching to full; empty screen → shown in the context line
  if (document.getElementById('main').classList.contains('chat-empty')) {
    $('#emptyCtx').textContent = t('desktop.mode.fullWarn');
    $('#emptyCtx').classList.add('warn');
  } else if ($('#chatMsgs')) {
    const d = document.createElement('div');
    d.className = 'm step warn';
    d.textContent = t('desktop.mode.fullWarn');
    $('#chatMsgs').insertBefore(d, $('#chatMsgs .pending'));
    $('#chatMsgs').scrollTop = $('#chatMsgs').scrollHeight;
  }
});

// ---------- Approval card in chat (replaces native modal): main sends approval:request, user answers via approval:respond ----------
const APPROVALS = new Map(); // id → pending request
let focusApprovalId = null; // click notification / badge → focus this card after Chat finishes drawing
const approvalEl = (id) => $('#chatMsgs')?.querySelector(`[data-approval="${CSS.escape(id)}"]`);
function renderApprovalBadge() {
  const b = $('#approvalBadge');
  b.hidden = !APPROVALS.size || onChatPage();
  b.textContent = t('desktop.approval.badge', { n: APPROVALS.size });
}
$('#approvalBadge').onclick = () => {
  focusApprovalId = [...APPROVALS.keys()][0] ?? null;
  location.hash = '#/chat';
};
const answerApproval = (id, approve) => api.invoke('approval:respond', { id, approve });
function approvalCard(r) {
  const box = $('#chatMsgs');
  if (!box || approvalEl(r.id)) return;
  document.getElementById('main').classList.remove('chat-empty');
  const d = document.createElement('div');
  d.className = 'm approval';
  d.dataset.approval = r.id;
  d.tabIndex = 0;
  const head = document.createElement('div');
  head.className = 'ap-head';
  const kind = document.createElement('span');
  kind.className = 'ap-kind ap-' + r.kind;
  kind.textContent = t('desktop.approval.kind.' + r.kind);
  const title = document.createElement('span');
  title.textContent = t('desktop.approval.title');
  const hint = document.createElement('span');
  hint.className = 'ap-hint';
  hint.textContent = t('desktop.approval.keys');
  head.append(kind, title, hint);
  const q = document.createElement('div');
  q.className = 'ap-q';
  q.textContent = r.question;
  const row = document.createElement('div');
  row.className = 'row';
  const yes = document.createElement('button');
  yes.textContent = r.approveLabel;
  yes.onclick = () => answerApproval(r.id, true);
  const no = document.createElement('button');
  no.className = 'secondary';
  no.textContent = r.rejectLabel;
  no.onclick = () => answerApproval(r.id, false);
  row.append(yes, no);
  d.append(head, q, row);
  // Enter/Esc when the card itself is focused (on a button, Enter = click that button)
  d.onkeydown = (e) => {
    if (e.target !== d) return;
    if (e.key === 'Enter') { e.preventDefault(); answerApproval(r.id, true); }
    else if (e.key === 'Escape') answerApproval(r.id, false);
  };
  box.insertBefore(d, box.querySelector('.pending')); // above the '…processing' bubble
  box.scrollTop = box.scrollHeight;
}
function focusApprovalCard() {
  const d = focusApprovalId && approvalEl(focusApprovalId);
  if (!d) return;
  focusApprovalId = null;
  d.scrollIntoView({ block: 'center' });
  d.focus();
}
on('approval:request', (r) => {
  APPROVALS.set(r.id, r);
  renderApprovalBadge();
  approvalCard(r);
});
on('approval:resolved', ({ id, approve }) => {
  APPROVALS.delete(id);
  renderApprovalBadge();
  const d = approvalEl(id);
  if (!d) return;
  const q = d.querySelector('.ap-q')?.textContent.split('\n')[0] ?? '';
  d.className = 'm step ' + (approve ? 'ok' : 'err');
  d.removeAttribute('tabindex');
  d.onkeydown = null;
  d.title = q;
  d.replaceChildren(t(approve ? 'desktop.approval.approved' : 'desktop.approval.rejected', { q }));
});
on('approval:focus', (id) => {
  focusApprovalId = id;
  if (onChatPage() && $('#chatMsgs')) focusApprovalCard();
  else location.hash = '#/chat';
});

function renderChrome() {
  renderRepo();
  renderMode();
  // fleet pill
  const pill = $('#fleetPill');
  if (pill && FLEET.length) {
    const n = fleetInstalled();
    pill.innerHTML = `<span class="dot ${fleetDot(n)}"></span>${n}/${FLEET.length} workers`;
  }
  // statusbar
  $('#stWorker').textContent = `Orchestra · model: ${SETTINGS?.brainModel || '—'}`;
  // composer: only picks the Orchestra model — workers are coordinated by Orchestra, not picked by the user in chat
  if (SETTINGS) {
    const cur = SETTINGS.brainModel;
    $('#cbModel').innerHTML = `<option value="">${esc(t('desktop.composer.pickModel'))}</option>` + [...new Set([cur, ...BRAIN_MODELS].filter(Boolean))]
      .map((id) => `<option value="${esc(id)}" ${id === cur ? 'selected' : ''}>${esc(id)}</option>`).join('');
  }
}

// ---------- Sessions (saved conversations — click to resume) ----------
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? t('desktop.time.now') : s < 3600 ? t('desktop.time.minutes', { n: Math.floor(s / 60) })
    : s < 86400 ? t('desktop.time.hours', { n: Math.floor(s / 3600) }) : t('desktop.time.days', { n: Math.floor(s / 86400) });
};
// collapsed project groups — UI state only, stored in localStorage
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
let openedMsgs = null; // messages of the just-opened session — renderChat draws them once
const showChat = () => {
  if (location.hash.startsWith('#/chat') || !location.hash) route();
  else location.hash = '#/chat';
  loadSessions();
};
async function openSession(projectId, id) {
  const r = await api.invoke('chat:open', { projectId, id });
  if (!r.ok) return alert('✗ ' + r.error);
  openedMsgs = r.messages;
  CHAT = { projectId: r.projectId, projectName: r.projectName || '', started: !!r.messages?.length };
  await loadSettings(); // activeRepo follows the session's project
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
// create project: input right below the header (Electron has no prompt())
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
// change Orchestra model → save immediately (main resets the conversation)
$('#cbModel').addEventListener('change', async (e) => {
  SETTINGS = await api.invoke('settings:set', { ...SETTINGS, brainModel: e.target.value });
  CHAT.started = false; // main resets the conversation on model change
  renderChrome();
  if (location.hash.startsWith('#/chat') || !location.hash) renderChat();
  loadSessions();
});
$('#cbNew').addEventListener('click', () => startChat(CHAT.projectId)); // new chat in the same project

function logLine(s) {
  const el = $('#log');
  if (!el) return;
  el.textContent += s + '\n';
  el.scrollTop = el.scrollHeight;
}

// ---------- Chat (main screen) ----------
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
  // chat with no messages → compact centered layout (1 class on #main, same composer DOM)
  const main = document.getElementById('main');
  main.classList.toggle('chat-empty', !CHAT.started);
  openedMsgs = null;
  $('#emptyCtx').classList.remove('warn');
  $('#emptyCtx').textContent = CHAT.projectId
    ? t('desktop.empty.ctxProject', { name: CHAT.projectName, n: SETTINGS?.projects?.find((p) => p.id === CHAT.projectId)?.repos.length ?? 0 })
    : t('desktop.empty.ctxGlobal');
  // approvals still pending (page change / redraw) → redraw cards
  for (const r of await api.invoke('approval:pending')) { APPROVALS.set(r.id, r); approvalCard(r); }
  renderApprovalBadge();
  focusApprovalCard();
  const input = $('#chatInput');
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    main.classList.remove('chat-empty');
    CHAT.started = true;
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
  document.querySelectorAll('#emptyChips [data-i18n]').forEach((b) => {
    b.onclick = () => { input.value = t(b.dataset.i18n); input.oninput(); input.focus(); };
  });
  $('#chatSend').onclick = send;
  $('#chatStop').onclick = () => api.invoke('chat:cancel');
  // assign property (not addEventListener): #chatInput survives re-renders → avoids duplicate sends
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  };
  // insert before the pending bubble so '…processing' stays last
  const addStep = (cls, text) => {
    const d = add(cls, text);
    d.title = text; // step line is ellipsized — hover to see all
    const pending = $('#chatMsgs .pending');
    if (pending) $('#chatMsgs').appendChild(pending);
    return d;
  };
  let progressBox = null; // worker progress of the current tool call — keeps the last 5 lines
  // a turn's tool calls grouped in 1 <details> (collapsed by default, shows the running call); each call is a child <details>
  let toolGroup = null;
  let lastCall = null;
  const argSummary = (input) => {
    const o = input && typeof input === 'object' ? input : {};
    const v = o.repo ? `${o.repo} · ` : '';
    const main = o.path ?? o.pattern ?? o.taskId ?? o.goal ?? o.template ?? o.text ?? o.ref ?? '';
    return (v + String(main)).replace(/\s+/g, ' ').slice(0, 90);
  };
  const groupSummary = () => {
    const n = toolGroup.querySelectorAll('.tc').length;
    const e = toolGroup.querySelectorAll('.tc.err').length;
    const sum = toolGroup.querySelector(':scope > summary');
    sum.querySelector('.tg-count').textContent = e ? t('desktop.chat.toolsErr', { n, e }) : t('desktop.chat.tools', { n });
    sum.querySelector('.tg-last').textContent = lastCall ? lastCall.querySelector('summary').textContent : '';
  };
  const addToolCall = (s) => {
    if (!toolGroup) {
      toolGroup = document.createElement('details');
      toolGroup.className = 'm toolgroup';
      const sum = document.createElement('summary');
      const c = document.createElement('span'); c.className = 'tg-count';
      const l = document.createElement('span'); l.className = 'tg-last';
      sum.append(c, l);
      toolGroup.appendChild(sum);
      $('#chatMsgs').appendChild(toolGroup);
      const pending = $('#chatMsgs .pending');
      if (pending) $('#chatMsgs').appendChild(pending);
    }
    const d = document.createElement('details');
    d.className = 'tc run';
    const sum = document.createElement('summary');
    sum.textContent = `⚙ ${s.name}  ${argSummary(s.input)}`;
    const body = document.createElement('pre');
    body.textContent = JSON.stringify(s.input ?? {}, null, 2);
    d.append(sum, body);
    toolGroup.appendChild(d);
    lastCall = d;
    groupSummary();
  };
  const addToolResult = (s) => {
    const d = lastCall && lastCall.classList.contains('run') ? lastCall : null;
    if (!d) return addStep(s.ok ? 'step' : 'step err', `${s.ok ? '✓' : '✗'} ${s.name}: ${s.preview}`);
    d.classList.remove('run');
    if (!s.ok) d.classList.add('err');
    const sum = d.querySelector('summary');
    sum.textContent = sum.textContent.replace(/^⚙/, s.ok ? '✓' : '✗');
    const res = document.createElement('pre');
    res.className = 'tc-res';
    res.textContent = s.preview ?? '';
    d.appendChild(res);
    groupSummary();
  };
  on('chat:step', (s) => {
    if (!$('#chatMsgs')) return; // background memory steps may arrive after leaving Chat
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
    if (s.kind === 'tool_call') addToolCall(s);
    else if (s.kind === 'tool_result') addToolResult(s);
    else if (s.kind === 'text') { toolGroup = null; addStep('orch', s.text); }
    else if (s.kind === 'memory') addStep('step', s.text);
    else addStep('step err', `✗ ${s.text}`);
  });
  on('chat:message', (m) => {
    toolGroup = null;
    lastCall = null;
    const pending = $('#chatMsgs .pending');
    if (pending) pending.remove(); // including an error 'result' (e.g. no repo selected)
    add(m.kind, m.text);
  });
  input.focus();
}

// ---------- Fleet HTML: first draw uses current FLEET, fleet:changed → paintFleet patches the visible part ----------
const fleetRows = () => FLEET.map((f) => `<tr><td><span class="dot ${f.installed ? 'ok' : 'err'}"></span></td><td>${esc(f.id)}</td><td class="mono">${esc(f.version ?? '-')}</td><td>${esc(f.auth)}</td><td>${esc(f.conformance ?? '-')}</td></tr>`).join('');
const dWorkerOptions = () => `<option value="">auto (Role Policy)</option>${FLEET.filter((f) => f.installed).map((f) => `<option>${esc(f.id)}</option>`).join('')}`;
const cWorkerOptions = () => FLEET.map((f) => `<option>${esc(f.id)}</option>`).join('');
const workerCards = () => FLEET.map((f) => `<div class="wizard-step">
          <span class="dot ${f.installed ? 'ok' : 'err'}"></span>
          <div><b>${esc(f.display || f.id)}</b> <span class="mono dim">${esc(f.id)}</span> <span class="dim">· ${esc(f.installed ? f.version ?? t('desktop.w.installed') : t('desktop.w.notInstalled'))}</span>
            <div class="dim">${esc(t(f.router ? 'desktop.w.authRouter' : 'desktop.w.noRouter'))}</div></div>
          <button class="secondary" data-install="${esc(f.id)}">${esc(t(f.installed ? 'desktop.w.reinstall' : 'desktop.w.install'))}</button>
        </div>`).join('');
function paintFleet() {
  const patch = (sel, html, keep) => {
    const el = $(sel);
    if (!el) return;
    const v = el.value;
    el.innerHTML = html;
    if (keep) el.value = [...el.options].some((o) => o.value === v) ? v : '';
  };
  patch('#dashFleet tbody', fleetRows());
  patch('#dWorker', dWorkerOptions(), true);
  patch('#wFleet', workerCards());
  patch('#cWorker', cWorkerOptions(), true);
}

// ---------- Dashboard ----------
async function renderDashboard() {
  composerWrap.hidden = true;
  page.classList.remove('fill');
  // fleet not awaited: draw with current FLEET, loadFleet returns → paintFleet
  const [tasks] = await Promise.all([api.invoke('tasks:list', { limit: TOP_N }), loadSettings()]);
  loadFleet();
  page.innerHTML = `
    <h2>Dashboard</h2>
    <div class="card" id="dashFleet"><h3>Fleet</h3>
      <table><thead><tr><th></th><th>worker</th><th>version</th><th>auth</th><th>conformance</th></tr></thead>
      <tbody>${fleetRows()}</tbody>
      </table>
      <div class="row"><button class="secondary" id="btnToWizard">${esc(t('desktop.dash.toWizard'))}</button></div>
    </div>
    <div class="grid2">
      <div class="card"><h3>Dispatch task</h3>
        <label>Goal</label><textarea id="dGoal" rows="2" placeholder="${esc(t('desktop.dash.goalPlaceholder'))}"></textarea>
        <label>${esc(t('desktop.dash.scopeGlob'))}</label><input id="dScope" value="src/payment/**" />
        <label>Worker</label><select id="dWorker">${dWorkerOptions()}</select>
        <label>Model</label><select id="dModel">${modelOptions('', '', t('desktop.dash.byPolicy'))}</select>
        <div class="row"><button id="dGo">Dispatch</button></div>
      </div>
      <div class="card"><h3>Run pipeline</h3>
        <label>Template</label><select id="pTpl"><option>feature-dev</option><option>hotfix</option></select>
        <label>Goal</label><textarea id="pGoal" rows="2"></textarea>
        <label>Scope</label><input id="pScope" value="src/payment/**" />
        <label>Model (implement + fixer)</label><select id="pModel">${modelOptions('', '', t('desktop.dash.byPolicy'))}</select>
        <div class="row"><button id="pGo">${esc(t('desktop.dash.runPipeline'))}</button></div>
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
  modelSearch($('#dModel'));
  modelSearch($('#pModel'));
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
// tasks: newest top-N (main already limits); click a row in Task records → select task for transcript
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

// ---------- Policy Matrix (tab in Settings) ----------
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

// ---------- Settings (single button — merges Settings + Setup Wizard, ZCode-style tabs) ----------
let settingsTab = 'chung';
async function renderSettings() {
  composerWrap.hidden = true;
  page.classList.remove('fill');
  const s = await loadSettings();
  loadFleet(); // doesn't block drawing — paintFleet on arrival
  const TABS = [['chung', t('desktop.tab.general')], ['workers', 'Workers'], ['providers', 'Providers'], /* conformance: temporarily hidden on request (pane + IPC kept, badge still on Dashboard) */ ['skills', 'Skills'], ['matrix', 'Policy Matrix']];
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
        <div id="wFleet">${workerCards()}</div>
        <div class="row"><button class="secondary" id="wRefresh">${esc(t('desktop.w.recheck'))}</button></div>
        <div id="log" class="mt-3"></div>
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
        <div class="row"><button id="prSave">${esc(t('desktop.common.save'))}</button></div>
      </div>`)}
    ${pane('conformance', `
      <div class="card">
        <h3>Conformance (Worker Protocol §10)</h3>
        <label>Worker</label><select id="cWorker">${cWorkerOptions()}</select>
        <div class="row"><button id="cRun">${esc(t('desktop.cf.run'))}</button></div>
        <div id="cOut" class="dim mt-2"></div>
      </div>`)}
    ${pane('skills', '<div class="card" id="skillsBox"></div>')}
    ${pane('matrix', '<div id="matrixBox"></div>')}`;
  renderMatrix($('#matrixBox'));
  renderSkills($('#skillsBox'), null);
  renderMemoryEditor($('#globalMemory'), null);
  // switch tab
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
    };
    await api.invoke('settings:set', next);
    await loadSettings();
    alert(t('desktop.common.saved'));
    route();
  };
  // change language → save immediately (main setLocale) + redraw, no restart
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
  // workers tab — delegate on #wFleet (paintFleet replaces content, listener stays)
  $('#wFleet').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-install]');
    if (!b) return;
    logLine('▶ install ' + b.dataset.install);
    const r = await api.invoke('install:worker', b.dataset.install);
    logLine((r.ok ? '✓ ' : '✗ ') + r.detail);
    setFleet(await api.invoke('fleet:refresh')); // main already triggered refresh after install — de-duped, waits for that same probe
  });
  $('#wRefresh').onclick = async () => {
    const b = $('#wRefresh');
    b.disabled = true;
    b.textContent = t('desktop.w.rechecking');
    try {
      setFleet(await api.invoke('fleet:refresh'));
    } finally {
      b.disabled = false;
      b.textContent = t('desktop.w.recheck');
    }
  };
  // providers tab — keys never reach the renderer (only hasKey)
  let PROVS = [];
  let oauthWaiting = ''; // anthropic provider waiting for pasted code#state
  const syncKind = () => {
    const o = isOAuth($('#prKind').value);
    $('#prRisk').hidden = !o;
    $('#prKeyed').hidden = o;
  };
  $('#prKind').onchange = syncKind;
  // 9router-style quick-add: [kind, label (proper name — not translated), suggested id, default baseUrl, default formats (= router's DEFAULT_FORMATS)]
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
  modelSearch($('#rDefault'));
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
      <td class="pj-act"><span class="acts">${isOAuth(p.kind) ? `<button class="secondary" data-plogin="${esc(p.id)}">${esc(t('desktop.pr.login'))}</button>` : ''}<button class="secondary" data-pedit="${esc(p.id)}">${esc(t('desktop.pr.edit'))}</button><button class="secondary" data-ptest="${esc(p.id)}">Test</button><button class="secondary" data-pdel="${esc(p.id)}">${esc(t('desktop.pr.delete'))}</button></span></td>
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
  on('install:log', (line) => logLine(line));
}

// ---------- Skills (Settings › Skills = global, Project page = project + inherited global) ----------
// Only send name/scope/projectId/URL — paths always computed by main; skill text always goes through esc()
async function renderSkills(box, projectId) {
  const scope = projectId ? 'project' : 'global';
  const r = await api.invoke('skills:list', { projectId });
  const all = r.skills || [];
  // project overrides same-name global → hide the shadowed global
  const shown = all.filter((s) => s.scope === scope || !all.some((o) => o.name === s.name && o.scope !== s.scope));
  const srcLabel = (s) => (s.source?.type === 'github'
    ? `github ${(s.source.url || '').replace('https://github.com/', '')}@${(s.source.commit || '').slice(0, 7)}`
    : t('desktop.skills.local'));
  const warnHtml = (it) => (it.error ? `<div class="err">${esc(t('desktop.skills.err.' + it.error))}${it.errorDetail ? ` — ${esc(it.errorDetail)}` : ''}</div>` : '')
    + it.warnings.map((w) => `<div class="${w.level === 'red' ? 'err' : 'warn'}">${esc(t('desktop.skills.warn.' + w.code, { file: w.file }))}</div>`).join('');
  box.innerHTML = `<h3>${esc(t('desktop.skills.title'))}</h3>
    <div class="dim">${esc(t(projectId ? 'desktop.skills.hintProject' : 'desktop.skills.hintGlobal'))}</div>
    ${!r.ok ? `<div class="err">✗ ${esc(r.error)}</div>` : shown.length ? `<table><tbody>${shown.map((s, i) => `<tr>
      <td><b class="mono">${esc(s.name)}</b><div class="dim">${esc(s.description)}</div></td>
      <td><span class="badge-risk">${esc(t('desktop.skills.scope.' + s.scope))}</span></td>
      <td class="mono">${esc(srcLabel(s))}</td>
      <td class="mono">${esc(s.workers.join(', '))}</td>
      <td class="pj-act">${s.scope !== scope ? '' : `<span class="acts">${s.source?.type === 'github' ? `<button class="secondary" data-sk-check="${i}">${esc(t('desktop.skills.checkUpdate'))}</button>` : `<button class="secondary" data-sk-edit="${i}">${esc(t('desktop.skills.edit'))}</button>`}
        <button class="secondary" data-sk-rm="${i}">${esc(t('desktop.skills.remove'))}</button></span>`}</td></tr>`).join('')}</tbody></table>`
      : `<div class="dim">${esc(t('desktop.skills.none'))}</div>`}
    <div data-sk-out class="dim"></div>
    <div data-sk-upd></div>
    <h3>${esc(t('desktop.skills.new'))}</h3>
    <label>${esc(t('desktop.skills.name'))}</label><input data-sk-name maxlength="64" autocomplete="off" />
    <label>${esc(t('desktop.skills.description'))}</label><input data-sk-desc maxlength="300" autocomplete="off" />
    <label>${esc(t('desktop.skills.workers'))}</label>
    <div class="row">${['claude', 'codex'].map((w) => `<label><input type="checkbox" data-sk-w="${w}" checked /> ${w}</label>`).join('')}</div>
    <label>${esc(t('desktop.skills.body'))}</label><textarea data-sk-body rows="8"></textarea>
    <div class="row"><button data-sk-save>${esc(t('desktop.common.save'))}</button></div>
    <h3>${esc(t('desktop.skills.fromGithub'))}</h3>
    <div class="row"><input data-sk-url placeholder="https://github.com/owner/repo/tree/main/skills" autocomplete="off" />
      <button data-sk-preview>${esc(t('desktop.skills.preview'))}</button>
      <button class="secondary" data-sk-import>${esc(t('desktop.skills.import'))}</button></div>
    <div data-sk-pv></div>`;
  const q = (sel) => box.querySelector(sel);
  const out = q('[data-sk-out]');
  const fail = (x) => { out.textContent = '✗ ' + x.error; out.className = 'err'; };
  const reload = () => renderSkills(box, projectId);
  const target = (s) => ({ scope, projectId, name: s.name }); // only skills in this scope get buttons
  box.querySelectorAll('[data-sk-edit]').forEach((b) => { b.onclick = () => {
    const s = shown[b.dataset.skEdit];
    q('[data-sk-name]').value = s.name;
    q('[data-sk-desc]').value = s.description;
    q('[data-sk-body]').value = s.body;
    box.querySelectorAll('[data-sk-w]').forEach((c) => { c.checked = s.workers.includes(c.dataset.skW); });
    q('[data-sk-name]').focus();
  }; });
  box.querySelectorAll('[data-sk-rm]').forEach((b) => { b.onclick = async () => {
    const s = shown[b.dataset.skRm];
    if (!confirm(t('desktop.skills.confirmRemove', { name: s.name }))) return;
    const x = await api.invoke('skills:remove', target(s));
    x.ok ? reload() : fail(x);
  }; });
  box.querySelectorAll('[data-sk-check]').forEach((b) => { b.onclick = async () => {
    const s = shown[b.dataset.skCheck];
    const upd = q('[data-sk-upd]');
    out.textContent = t('desktop.skills.loading');
    const x = await api.invoke('skills:checkUpdate', target(s));
    out.textContent = '';
    if (!x.ok) return fail(x);
    if (x.upToDate) { upd.innerHTML = `<div class="ok">${esc(t('desktop.skills.upToDate', { commit: (x.commit || '').slice(0, 7) }))}</div>`; return; }
    upd.innerHTML = `<div class="risk"><b class="mono">${esc(s.name)}</b> ${esc(t('desktop.skills.updateAvail', { commit: x.newCommit.slice(0, 7), files: x.changed.map((c) => `${c.status} ${c.path}`).join(', ') }))}
      ${warnHtml(x.item)}
      <div class="row"><button data-sk-apply ${x.item.error ? 'disabled' : ''}>${esc(t('desktop.skills.apply'))}</button><button class="secondary" data-sk-upd-cancel>${esc(t('desktop.skills.cancel'))}</button></div></div>`;
    q('[data-sk-upd-cancel]').onclick = () => { api.invoke('skills:cancelPreview', { previewId: x.previewId }); upd.innerHTML = ''; };
    q('[data-sk-apply]').onclick = async () => {
      const y = await api.invoke('skills:update', { ...target(s), previewId: x.previewId });
      y.ok ? reload() : fail(y);
    };
  }; });
  q('[data-sk-save]').onclick = async () => {
    const skill = {
      name: q('[data-sk-name]').value.trim(), description: q('[data-sk-desc]').value.trim(), body: q('[data-sk-body]').value,
      workers: [...box.querySelectorAll('[data-sk-w]:checked')].map((c) => c.dataset.skW),
    };
    const x = await api.invoke('skills:save', { scope, projectId, skill });
    x.ok ? reload() : fail(x);
  };
  const preview = async (ch, payload) => {
    const pv = q('[data-sk-pv]');
    pv.textContent = t('desktop.skills.loading');
    const x = await api.invoke(ch, payload);
    if (!x.ok) { pv.textContent = ''; return fail(x); }
    if (!x.skills.length) { api.invoke('skills:cancelPreview', { previewId: x.previewId }); pv.textContent = t('desktop.skills.noneFound'); return; }
    pv.innerHTML = `<table><tbody>${x.skills.map((it, i) => `<tr>
      <td><input type="checkbox" data-sk-pick="${i}" ${it.error ? 'disabled' : it.warnings.some((w) => w.level === 'red') ? '' : 'checked'} /></td>
      <td><b class="mono">${esc(it.name)}</b><div class="dim">${esc(it.description)}</div><div class="dim mono">${esc(it.origin)}</div></td>
      <td class="dim">${esc(t('desktop.skills.size', { n: it.files.length, kb: Math.ceil(it.bytes / 1024) }))}</td>
      <td>${warnHtml(it)}</td></tr>`).join('')}</tbody></table>
      <div class="row"><button data-sk-install>${esc(t('desktop.skills.install'))}</button><button class="secondary" data-sk-pv-cancel>${esc(t('desktop.skills.cancel'))}</button></div>`;
    q('[data-sk-pv-cancel]').onclick = () => { api.invoke('skills:cancelPreview', { previewId: x.previewId }); pv.innerHTML = ''; };
    q('[data-sk-install]').onclick = async () => {
      const names = [...pv.querySelectorAll('[data-sk-pick]:checked')].map((c) => x.skills[c.dataset.skPick].name);
      if (!names.length) return;
      const y = await api.invoke('skills:install', { previewId: x.previewId, names, scope, projectId });
      if (!y.ok) return fail(y);
      await reload();
      box.querySelector('[data-sk-out]').textContent = t('desktop.skills.installed', { names: y.installed.join(', ') });
    };
  };
  q('[data-sk-preview]').onclick = () => preview('skills:previewGithub', { url: q('[data-sk-url]').value.trim() });
  q('[data-sk-import]').onclick = () => preview('skills:previewLocal');
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
    area.value = r.text; // main already redacted secrets
    used(r.used);
    out.textContent += ' · ' + t('desktop.common.saved');
  };
}

// ---------- Project (#/project/<id>): name, repos, memory, read-only KB ----------
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
    <div class="card" id="pjSkills"></div>
    ${d.repos.filter((r) => r.exists).map((r) => `<div class="card"><h3>${esc(t('desktop.project.kbTitle', { name: r.name }))}</h3>${kbTable(r.kb)}</div>`).join('')}
    <div class="card"><div class="row"><button class="secondary" id="pjDelete">${esc(t('desktop.project.delete'))}</button></div></div>`;
  renderMemoryEditor($('#pjMemory'), id);
  renderSkills($('#pjSkills'), id);
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
      <div class="row">
        <input id="termIn" placeholder="${esc(t('desktop.term.placeholder'))}" autocomplete="off" />
        <button class="secondary" id="termNew">${esc(t('desktop.term.newSession'))}</button>
      </div>
      <div class="dim mt-2" style="font-size:10.5px">${esc(t('desktop.term.hint'))}</div>
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
  if (termSession === TERM_ID) await api.invoke('terminal:kill', TERM_ID); // re-entering the page → new session, avoids stale pty
  await create();
  termSession = TERM_ID;
  termEl.textContent += t('desktop.term.ready') + '\r\n';
  termIn.focus();
}

// ---------- router ----------
// terminal: route kept but no link in the UI — temporarily hidden on request
const TITLES = { chat: () => 'Chat — Orchestrator', dashboard: () => 'Dashboard', terminal: () => 'Terminal', settings: () => t('desktop.page.settings') };
const ROUTES = { chat: renderChat, dashboard: renderDashboard, terminal: renderTerminal, settings: renderSettings };
function route() {
  let hash = (location.hash || '#/chat').replace('#/', '');
  if (hash === 'wizard') hash = 'settings'; // old hash still works
  if (hash === 'transcript') { openTranscript = true; location.hash = '#/dashboard'; return; } // Transcript is now a section in Dashboard
  if (hash === 'matrix') { settingsTab = 'matrix'; location.hash = '#/settings'; return; } // Policy Matrix is now a tab in Settings (hashchange → re-route)
  document.querySelectorAll('#sidebar a[data-page]').forEach((a) => a.classList.toggle('active', a.dataset.page === hash));
  document.getElementById('btnSettings').classList.toggle('active', hash === 'settings');
  $('#pageTitle').textContent = TITLES[hash]?.() || 'Orchestra';
  renderRepo();
  document.getElementById('main').classList.remove('chat-empty'); // renderChat re-adds it if the chat is still empty
  renderApprovalBadge();
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
  await loadI18n(); // before the first render
  await loadSettings();
  // fleet (CLI probe) + models (cold upstream ~3s) don't block first draw — renderChrome/paintFleet patch on arrival
  loadFleet();
  loadSessions();
  loadModels();
  loadBrainModels();
  modelSearch($('#cbModel'));
  route();
})();

// Sample stub API — only active when the renderer runs outside Electron (browser preview).
function devStub() {
  const repos = ['C:\\code\\payment-svc'];
  const project = { id: 'payments-a1b2', name: 'Payments', repos };
  const settings = { projects: [project], activeRepo: repos[0], repos, brainModel: '', routerDefaultModel: '', templatesDir: '', autoApprovePlan: false, hooksEnabled: true, language: 'en', permissionMode: 'ask' };
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
    if (ch === 'approval:pending') return [];
    if (ch === 'fleet:list' || ch === 'fleet:refresh') return fleet;
    if (ch === 'tasks:list') return tasks;
    if (ch === 'i18n:get') return { locale: 'en', dict: {} }; // preview: shows keys
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
    if (ch === 'skills:list') return { ok: true, skills: [{ name: 'lint', description: 'run the linter', workers: ['claude', 'codex'], tags: [], scope: 'global', body: 'x', source: { type: 'github', url: 'https://github.com/acme/skills', commit: 'abc1234def' } }] };
    if (ch === 'skills:previewGithub' || ch === 'skills:previewLocal') return { ok: true, previewId: 'pv-1', source: { type: 'local' }, skills: [
      { name: 'deploy', description: 'deploy steps', origin: 'acme/skills', files: [{ path: 'SKILL.md', size: 900 }], bytes: 900, warnings: [{ level: 'yellow', code: 'script', file: 'scripts/run.sh' }] },
      { name: 'evil', description: 'x', origin: 'acme/skills', files: [], bytes: 0, warnings: [], error: 'symlink', errorDetail: 'a -> /etc' }] };
    if (ch === 'skills:checkUpdate') return { ok: true, upToDate: true, commit: 'abc1234def', newCommit: 'abc1234def', changed: [] };
    if (ch === 'skills:install' || ch === 'skills:update') return { ok: true, installed: p.names ?? [p.name] };
    if (ch === 'chat:exchange') setTimeout(() => listeners['chat:message']?.forEach((f) => f({ kind: 'orch', text: '(stub) received — running preview outside Electron.' })), 400);
    return { ok: true };
  };
  bus.invoke = reply;
  return bus;
}

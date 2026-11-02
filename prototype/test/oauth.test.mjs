// Router R3 — OAuth: fake token server + fake upstream 127.0.0.1, không mạng ngoài, không DPAPI (keyFor/saveKey inject)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRouter } from '../dist/router/server.js';
import { createProviderStore, normalizeProvider, routerModelOk } from '../dist/router/providers.js';
import {
  ANTHROPIC, OPENAI, pkceChallenge, pkce, anthropicAuthUrl, openaiAuthUrl, openaiLogin, exchangeAnthropic,
  getAccessToken, accountIdFromJwt, oauthStatus,
} from '../dist/router/oauth.js';
import { t } from '../dist/i18n/index.js';

const REAL_SSE = readFileSync(new URL('./fixtures/codex-responses-stream.txt', import.meta.url), 'utf8');
const CODEX = JSON.parse(readFileSync(new URL('./fixtures/codex-responses-request.json', import.meta.url), 'utf8'));
const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const ID_TOKEN = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' } });

function fake(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, raw });
      handler(req, res, raw);
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}
const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const memStore = (init = {}) => {
  const vault = new Map(Object.entries(init));
  return { vault, keyFor: (id) => vault.get(id) ?? null, saveKey: (id, v) => (vault.set(id, v), true) };
};

test('PKCE S256: RFC 7636 appendix B', () => {
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const p = pkce();
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(p.challenge, pkceChallenge(p.verifier));
});

test('authorize URL đủ param', () => {
  const a = new URL(anthropicAuthUrl({ challenge: 'CH', state: 'ST' }));
  assert.equal(a.origin + a.pathname, 'https://claude.com/cai/oauth/authorize');
  for (const [k, v] of Object.entries({ code: 'true', client_id: ANTHROPIC.clientId, response_type: 'code', redirect_uri: ANTHROPIC.redirectUri, scope: 'org:create_api_key user:profile user:inference', code_challenge: 'CH', code_challenge_method: 'S256', state: 'ST' })) {
    assert.equal(a.searchParams.get(k), v, k);
  }
  const o = new URL(openaiAuthUrl({ challenge: 'CH', state: 'ST', redirectUri: 'http://localhost:1455/auth/callback' }));
  assert.equal(o.origin + o.pathname, 'https://auth.openai.com/oauth/authorize');
  for (const [k, v] of Object.entries({ client_id: OPENAI.clientId, redirect_uri: 'http://localhost:1455/auth/callback', scope: 'openid profile email offline_access', code_challenge: 'CH', code_challenge_method: 'S256', id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'codex_cli_rs', state: 'ST', response_type: 'code' })) {
    assert.equal(o.searchParams.get(k), v, k);
  }
  assert.equal(accountIdFromJwt(ID_TOKEN), 'acct-42');
  assert.equal(accountIdFromJwt('rác'), undefined);
});

test('exchange anthropic: JSON body, state phải khớp', async () => {
  const tok = await fake((req, res) => json(res, 200, { access_token: 'A1', refresh_token: 'R1', expires_in: 3600 }));
  try {
    await assert.rejects(exchangeAnthropic('CODE#sai', { verifier: 'V', state: 'ST' }, `${tok.url}/t`), { message: t('router.oauth.badCodeState') });
    assert.equal(tok.seen.length, 0);
    const c = await exchangeAnthropic('CODE#ST', { verifier: 'V', state: 'ST' }, `${tok.url}/t`);
    assert.deepEqual([c.access, c.refresh], ['A1', 'R1']);
    assert.ok(c.expiresAt > Date.now());
    const s = tok.seen[0];
    assert.match(s.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(s.raw), { grant_type: 'authorization_code', code: 'CODE', state: 'ST', client_id: ANTHROPIC.clientId, redirect_uri: ANTHROPIC.redirectUri, code_verifier: 'V' });
  } finally {
    tok.srv.close();
  }
});

test('openai login: callback state sai → 400, đúng → form exchange + accountId; cổng bận → lỗi rõ', async () => {
  const tok = await fake((req, res) => json(res, 200, { access_token: 'A', refresh_token: 'R', id_token: ID_TOKEN, expires_in: 3600 }));
  try {
    let authUrl;
    const done = openaiLogin({ port: 0, tokenUrl: `${tok.url}/t`, open: (u) => (authUrl = new URL(u)) });
    await new Promise((r) => setTimeout(r, 50));
    const cb = new URL(authUrl.searchParams.get('redirect_uri'));
    const bad = await fetch(`http://127.0.0.1:${cb.port}/auth/callback?code=C&state=sai`);
    assert.equal(bad.status, 400);
    assert.equal(tok.seen.length, 0, 'state sai không được đổi code');
    const ok = await fetch(`http://127.0.0.1:${cb.port}/auth/callback?code=C&state=${authUrl.searchParams.get('state')}`);
    assert.equal(ok.status, 200);
    const c = await done;
    assert.deepEqual([c.access, c.refresh, c.accountId], ['A', 'R', 'acct-42']);
    assert.match(tok.seen[0].headers['content-type'], /x-www-form-urlencoded/);
    const form = Object.fromEntries(new URLSearchParams(tok.seen[0].raw));
    assert.deepEqual(form, { grant_type: 'authorization_code', code: 'C', redirect_uri: cb.href, client_id: OPENAI.clientId, code_verifier: form.code_verifier });
    assert.equal(pkceChallenge(form.code_verifier), authUrl.searchParams.get('code_challenge'));
    await assert.rejects(fetch(cb.href), 'server callback phải đóng sau khi xong');

    const busy = http.createServer();
    await new Promise((r) => busy.listen(0, '127.0.0.1', r));
    await assert.rejects(openaiLogin({ port: busy.address().port, open: () => {} }), { message: t('router.oauth.portBusy', { port: busy.address().port }) });
    busy.close();
  } finally {
    tok.srv.close();
  }
});

test('refresh: single-flight, refresh token mới lưu vault, encoding đúng; 400 → needsLogin', async () => {
  let n = 0;
  const tok = await fake((req, res) => {
    n++;
    setTimeout(() => json(res, 200, { access_token: `A${n}`, refresh_token: `R${n}`, expires_in: 3600 }), 30);
  });
  try {
    const old = JSON.stringify({ access: 'A0', refresh: 'R0', expiresAt: Date.now() + 60_000 }); // < 10' → refresh
    for (const kind of ['oauth-anthropic', 'oauth-openai']) {
      n = 0;
      tok.seen.length = 0;
      const m = memStore({ p: old });
      const store = createProviderStore({ file: path.join(mkdtempSync(path.join(os.tmpdir(), 'orch-oa-')), 'r.json'), ...m });
      const [a, b] = await Promise.all([getAccessToken(store, { id: 'p', kind }, `${tok.url}/t`), getAccessToken(store, { id: 'p', kind }, `${tok.url}/t`)]);
      assert.equal(tok.seen.length, 1, `${kind}: 2 lời gọi đồng thời → 1 refresh`);
      assert.equal(a.access, 'A1');
      assert.equal(b.access, 'A1');
      assert.equal(JSON.parse(m.vault.get('p')).refresh, 'R1', 'refresh token xoay vòng đã lưu vault');
      const s = tok.seen[0];
      if (kind === 'oauth-anthropic') assert.deepEqual(JSON.parse(s.raw), { grant_type: 'refresh_token', refresh_token: 'R0', client_id: ANTHROPIC.clientId });
      else assert.deepEqual(Object.fromEntries(new URLSearchParams(s.raw)), { grant_type: 'refresh_token', refresh_token: 'R0', client_id: OPENAI.clientId, scope: OPENAI.scope });
      // còn hạn → không refresh
      await getAccessToken(store, { id: 'p', kind }, `${tok.url}/t`);
      assert.equal(tok.seen.length, 1);
    }
  } finally {
    tok.srv.close();
  }
  const dead = await fake((req, res) => json(res, 400, { error: 'invalid_grant' }));
  try {
    const m = memStore({ p: JSON.stringify({ access: 'A0', refresh: 'R0', expiresAt: 0 }) });
    const store = createProviderStore({ file: path.join(mkdtempSync(path.join(os.tmpdir(), 'orch-oa-')), 'r.json'), ...m });
    await assert.rejects(getAccessToken(store, { id: 'p', kind: 'oauth-anthropic' }, `${dead.url}/t`), { message: t('router.oauth.loginExpired') });
    assert.equal(oauthStatus(m.vault.get('p')).oauthStatus, 'needsLogin');
    assert.equal(oauthStatus(null).oauthStatus, 'none');
  } finally {
    dead.srv.close();
  }
});

test('riskAcknowledged: thiếu → không bật, save bị từ chối; key không nhận', () => {
  const p = normalizeProvider({ id: 'cc', kind: 'oauth-anthropic' });
  assert.equal(p.enabled, false);
  assert.equal(p.baseUrl, 'https://api.anthropic.com');
  assert.deepEqual(p.models, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001']);
  assert.deepEqual(normalizeProvider({ id: 'cx', kind: 'oauth-openai', riskAcknowledged: true, formats: ['chat'] }).formats, ['responses']);
  const store = createProviderStore({ file: path.join(mkdtempSync(path.join(os.tmpdir(), 'orch-oa-')), 'r.json'), ...memStore() });
  assert.throws(() => store.saveProvider({ id: 'cc', kind: 'oauth-anthropic' }), { message: t('router.providers.mustAckRisk', { id: 'cc' }) });
  assert.throws(() => store.saveProvider({ id: 'cc', kind: 'oauth-anthropic', riskAcknowledged: true }, 'sk-x'), { message: t('router.providers.oauthNoKey', { id: 'cc' }) });
  assert.equal(store.saveProvider({ id: 'cc', kind: 'oauth-anthropic', riskAcknowledged: true }).enabled, true);
  assert.equal(store.listProviders().length, 1);
});

test('routerModelOk với oauth', () => {
  const ant = normalizeProvider({ id: 'cc', kind: 'oauth-anthropic', riskAcknowledged: true });
  const oai = normalizeProvider({ id: 'cx', kind: 'oauth-openai', riskAcknowledged: true });
  const ps = [ant, oai];
  assert.equal(routerModelOk('claude', 'cc/claude-sonnet-5-5', ps).ok, true);
  assert.equal(routerModelOk('codex', 'cc/claude-sonnet-5-5', ps).ok, true, 'codex → Responses→Chat→Messages');
  assert.equal(routerModelOk('codex', 'cx/gpt-6-sol', ps).ok, true);
  assert.equal(routerModelOk('claude', 'cx/gpt-6-sol', ps).reason, t('router.providers.noM2R', { id: 'cx' }));
  assert.equal(routerModelOk('claude', 'cc/x', [{ ...ant, needsLogin: true }]).reason, t('router.providers.needsLogin', { id: 'cc' }));
  assert.equal(routerModelOk('claude', 'cc/x', [normalizeProvider({ id: 'cc', kind: 'oauth-anthropic' })]).reason, t('router.providers.riskNotAck', { id: 'cc' }));
});

// ───── server: upstream nhận đúng header/body ─────
let up, router, vault, logs;
const TOKEN = 'b'.repeat(64);
const fresh = (extra = {}) => JSON.stringify({ access: 'ACC', refresh: 'REF', expiresAt: Date.now() + 3600_000, ...extra });
const ANT_OK = { id: 'm', type: 'message', model: 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };

before(async () => {
  up = await fake((req, res, raw) => {
    if (req.url.startsWith('/v1/messages')) return json(res, 200, ANT_OK);
    if (req.url === '/codex/responses') return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(REAL_SSE);
    json(res, 404, {});
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-oarouter-'));
  const file = path.join(dir, 'router.json');
  writeFileSync(file, JSON.stringify({ providers: [
    { id: 'cc', kind: 'oauth-anthropic', baseUrl: up.url, riskAcknowledged: true },
    { id: 'cx', kind: 'oauth-openai', baseUrl: `${up.url}/codex`, riskAcknowledged: true },
    { id: 'dead', kind: 'oauth-anthropic', baseUrl: up.url, riskAcknowledged: true },
    { id: 'raw', kind: 'oauth-anthropic', baseUrl: up.url }, // chưa xác nhận rủi ro → tắt
  ] }));
  const m = memStore({ cc: fresh(), cx: fresh({ accountId: 'acct-42' }), dead: JSON.stringify({ needsLogin: true }) });
  vault = m.vault;
  logs = [];
  router = await startRouter({ store: createProviderStore({ file, ...m }), token: TOKEN, onLog: (l) => logs.push(l) });
});
after(async () => {
  await router.close();
  up.srv.close();
});
const call = (p, body) =>
  fetch(`http://127.0.0.1:${router.port}${p}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14' }, body: JSON.stringify(body) });
const lastUp = () => up.seen.at(-1);

test('router: cảnh báo 1 lần cho mỗi provider OAuth bật, không log token', () => {
  const warns = (id) => logs.filter((l) => l === `[router] ${t('router.server.oauthWarn', { id })}`).length;
  assert.deepEqual(['cc', 'cx', 'dead', 'raw'].map(warns), [1, 1, 1, 0]);
  assert.ok(!logs.join('\n').includes('ACC'));
});

test('oauth-anthropic: Bearer + beta gộp + system prefix thêm 1 lần', async () => {
  const r = await call('/v1/messages', { model: 'cc/claude-sonnet-5-5', max_tokens: 10, system: 'Hãy ngắn gọn', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  const s = lastUp();
  assert.equal(s.url, '/v1/messages?beta=true');
  assert.equal(s.headers.authorization, 'Bearer ACC');
  assert.equal(s.headers['x-api-key'], undefined);
  assert.equal(s.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(s.headers['anthropic-beta'].split(','), ['oauth-2025-04-20', 'claude-code-20250219', 'fine-grained-tool-streaming-2025-05-14']);
  const b = JSON.parse(s.raw);
  assert.equal(b.model, 'claude-sonnet-5-5');
  assert.deepEqual(b.system, [{ type: 'text', text: ANTHROPIC.systemPrefix }, { type: 'text', text: 'Hãy ngắn gọn' }]);
  // claude CLI đã gửi prefix → không lặp
  const sys = [{ type: 'text', text: ANTHROPIC.systemPrefix }, { type: 'text', text: 'rest' }];
  await call('/v1/messages', { model: 'cc/claude-sonnet-5-5', max_tokens: 10, system: sys, messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(JSON.parse(lastUp().raw).system, sys);
});

test('codex (responses) → oauth-anthropic qua chain Chat→Messages', async () => {
  const r = await call('/v1/responses', { ...CODEX, model: 'cc/claude-sonnet-5-5', stream: false });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).object, 'response');
  const s = lastUp();
  assert.equal(s.url, '/v1/messages?beta=true');
  assert.equal(s.headers.authorization, 'Bearer ACC');
  const b = JSON.parse(s.raw);
  assert.equal(b.system[0].text, ANTHROPIC.systemPrefix);
  assert.match(b.system[1].text, /You are a coding agent/);
});

test('oauth-openai: originator/account/session, stream+store ép; non-stream → JSON gom', async () => {
  const r = await call('/v1/responses', { ...CODEX, model: 'cx/gpt-6-sol', stream: false, store: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /json/);
  const j = await r.json();
  assert.equal(j.status, 'completed');
  assert.equal(j.model, 'cx/gpt-6-sol');
  const s = lastUp();
  assert.equal(s.url, '/codex/responses');
  assert.equal(s.headers.authorization, 'Bearer ACC');
  assert.equal(s.headers.originator, 'codex_cli_rs');
  assert.equal(s.headers['chatgpt-account-id'], 'acct-42');
  assert.match(s.headers.session_id, /^[0-9a-f-]{36}$/);
  const b = JSON.parse(s.raw);
  assert.deepEqual([b.stream, b.store, b.model], [true, false, 'gpt-6-sol']);
  // client stream → passthrough SSE nguyên vẹn
  const r2 = await call('/v1/responses', { ...CODEX, model: 'cx/gpt-6-sol', stream: true });
  assert.equal(await r2.text(), REAL_SSE);
});

test('needsLogin → 401 rõ ràng, không gọi upstream; provider chưa xác nhận rủi ro không route', async () => {
  const n = up.seen.length;
  const r = await call('/v1/messages', { model: 'dead/claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.message, `dead: ${t('router.oauth.loginExpired')}`);
  assert.equal(up.seen.length, n);
  const r2 = await call('/v1/messages', { model: 'raw/claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r2.status, 400);
  assert.ok(vault.get('cc').includes('ACC'));
});

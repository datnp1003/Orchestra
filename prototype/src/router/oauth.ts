// Router R3 — OAuth subscription (Claude Pro/Max, ChatGPT Plus/Pro).
// ⚠ Client id + endpoint dưới đây là public client id của CLI chính chủ (Claude Code, Codex CLI) — dùng ngoài CLI đó là
// KHÔNG được document/hỗ trợ, có thể vi phạm điều khoản → bị chặn / khoá tài khoản. Chỉ bật khi user đã riskAcknowledged.
// Creds {access, refresh, expiresAt, accountId?} chỉ nằm trong vault `router.<id>` (qua store.getKey/setKey), không log, không về renderer.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { ProviderConfig, ProviderKind } from './providers.js';
import { t } from '../i18n/index.js';

// Endpoint lấy từ claude.exe đang cài (MANUAL_REDIRECT_URL/TOKEN_URL/CLAUDE_AI_AUTHORIZE_URL) — đổi theo bản CLI.
export const ANTHROPIC = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  // manual-code flow: trang này hiện `code#state` cho user copy (Claude Code dùng khi không mở được localhost)
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  scope: 'org:create_api_key user:profile user:inference',
  baseUrl: 'https://api.anthropic.com',
  beta: ['oauth-2025-04-20', 'claude-code-20250219'],
  systemPrefix: "You are Claude Code, Anthropic's official CLI for Claude.",
};
export const OPENAI = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  port: 1455, // redirect_uri cố định đăng ký cho client id của codex
  scope: 'openid profile email offline_access',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  originator: 'codex_cli_rs',
};
export const OAUTH_BASE_URL: Record<string, string> = { 'oauth-anthropic': ANTHROPIC.baseUrl, 'oauth-openai': OPENAI.baseUrl };
const TOKEN_URL: Record<string, string> = { 'oauth-anthropic': ANTHROPIC.tokenUrl, 'oauth-openai': OPENAI.tokenUrl };
const REFRESH_LEAD_MS = 10 * 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface OAuthCreds {
  access: string;
  refresh: string;
  expiresAt: number;
  accountId?: string;
}
/** refresh token chết / chưa login → router trả 401 với message này */
export class OAuthLoginError extends Error {}
const loginMsg = () => t('router.oauth.loginExpired');

// ───────────── PKCE (RFC 7636, S256) ─────────────
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier), state: randomBytes(16).toString('base64url') };
}

export function anthropicAuthUrl(p: { challenge: string; state: string }): string {
  const q = new URLSearchParams({
    code: 'true',
    client_id: ANTHROPIC.clientId,
    response_type: 'code',
    redirect_uri: ANTHROPIC.redirectUri,
    scope: ANTHROPIC.scope,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
  });
  return `${ANTHROPIC.authorizeUrl}?${q}`;
}

export function openaiAuthUrl(p: { challenge: string; state: string; redirectUri: string }): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI.clientId,
    redirect_uri: p.redirectUri,
    scope: OPENAI.scope,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: OPENAI.originator,
    state: p.state,
  });
  return `${OPENAI.authorizeUrl}?${q}`;
}

/** chỉ DECODE payload id_token (không verify chữ ký) — lấy chatgpt_account_id làm header, không dùng để xác thực gì */
export function accountIdFromJwt(jwt: unknown): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1]!, 'base64url').toString('utf8'));
    const id = payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

async function tokenPost(url: string, body: Record<string, string>, form: boolean): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', accept: 'application/json' },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`token endpoint HTTP ${r.status}: ${text.slice(0, 200)}`), { status: r.status });
  const j = JSON.parse(text);
  if (typeof j?.access_token !== 'string') throw new Error(t('router.oauth.noAccessToken'));
  return j;
}
const toCreds = (j: any, prev?: Partial<OAuthCreds>): OAuthCreds => {
  const accountId = accountIdFromJwt(j.id_token) ?? prev?.accountId;
  return {
    access: j.access_token,
    refresh: typeof j.refresh_token === 'string' ? j.refresh_token : prev?.refresh ?? '',
    expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
    ...(accountId ? { accountId } : {}),
  };
};

/** user dán `code#state` từ trang callback của Anthropic */
export async function exchangeAnthropic(pasted: string, p: { verifier: string; state: string }, tokenUrl = ANTHROPIC.tokenUrl): Promise<OAuthCreds> {
  const [code, state] = String(pasted).trim().split('#');
  if (!code || state !== p.state) throw new Error(t('router.oauth.badCodeState'));
  const j = await tokenPost(tokenUrl, { grant_type: 'authorization_code', code, state, client_id: ANTHROPIC.clientId, redirect_uri: ANTHROPIC.redirectUri, code_verifier: p.verifier }, false);
  return toCreds(j);
}

/** callback server 1 lần trên 127.0.0.1:1455 — mở trình duyệt, chờ redirect đúng state, đổi code lấy token */
export function openaiLogin(o: { open: (url: string) => unknown; port?: number; timeoutMs?: number; tokenUrl?: string }): Promise<OAuthCreds> {
  const port = o.port ?? OPENAI.port;
  const { verifier, challenge, state } = pkce();
  return new Promise((resolve, reject) => {
    let redirectUri = '';
    let done = false;
    const finish = (err: unknown, c?: OAuthCreds) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      srv.close();
      if (err) reject(err);
      else resolve(c!);
    };
    const page = (res: http.ServerResponse, status: number, text: string) =>
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(text);
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost');
      if (u.pathname !== '/auth/callback') return void page(res, 404, 'not found');
      if (done || u.searchParams.get('state') !== state) return void page(res, 400, t('router.oauth.badState'));
      const code = u.searchParams.get('code');
      if (!code) {
        page(res, 400, t('router.oauth.loginFailed'));
        return finish(new Error(t('router.oauth.openaiDenied', { error: u.searchParams.get('error') ?? t('router.oauth.noCode') })));
      }
      try {
        const j = await tokenPost(o.tokenUrl ?? OPENAI.tokenUrl, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: OPENAI.clientId, code_verifier: verifier }, true);
        page(res, 200, t('router.oauth.done'));
        finish(null, toCreds(j));
      } catch (err) {
        page(res, 500, t('router.oauth.exchangeFailed'));
        finish(err);
      }
    });
    const timer = setTimeout(() => finish(new Error(t('router.oauth.timeout'))), o.timeoutMs ?? LOGIN_TIMEOUT_MS);
    srv.once('error', (e: NodeJS.ErrnoException) => finish(e.code === 'EADDRINUSE' ? new Error(t('router.oauth.portBusy', { port })) : e));
    srv.listen(port, '127.0.0.1', () => {
      redirectUri = `http://localhost:${(srv.address() as { port: number }).port}/auth/callback`;
      Promise.resolve()
        .then(() => o.open(openaiAuthUrl({ challenge, state, redirectUri })))
        .catch(finish);
    });
  });
}

// ───────────── token cho router: refresh single-flight ─────────────
interface KeyStore {
  getKey(id: string): string | null;
  setKey(id: string, value: string): void;
}
const parseCreds = (raw: string | null): (Partial<OAuthCreds> & { needsLogin?: boolean }) | null => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

export function oauthStatus(raw: string | null): { oauthStatus: 'none' | 'ok' | 'expired' | 'needsLogin'; expiresAt: number | null } {
  const c = parseCreds(raw);
  if (!c) return { oauthStatus: 'none', expiresAt: null };
  if (c.needsLogin || !c.refresh) return { oauthStatus: 'needsLogin', expiresAt: null };
  return { oauthStatus: (c.expiresAt ?? 0) < Date.now() ? 'expired' : 'ok', expiresAt: c.expiresAt ?? null };
}

// refresh token XOAY VÒNG: dùng lại token cũ = revoke cả phiên → mỗi provider chỉ 1 refresh đang bay
const inflight = new Map<string, Promise<OAuthCreds>>();

export function getAccessToken(store: KeyStore, p: Pick<ProviderConfig, 'id' | 'kind'>, tokenUrl?: string): Promise<OAuthCreds> {
  const c = parseCreds(store.getKey(p.id));
  if (!c?.access || !c.refresh || c.needsLogin) return Promise.reject(new OAuthLoginError(loginMsg()));
  if ((c.expiresAt ?? 0) - Date.now() > REFRESH_LEAD_MS) return Promise.resolve(c as OAuthCreds);
  let pr = inflight.get(p.id);
  if (!pr) {
    pr = refresh(store, p.id, p.kind, c, tokenUrl ?? TOKEN_URL[p.kind]!).finally(() => inflight.delete(p.id));
    inflight.set(p.id, pr);
  }
  return pr;
}

async function refresh(store: KeyStore, id: string, kind: ProviderKind, c: Partial<OAuthCreds>, url: string): Promise<OAuthCreds> {
  const openai = kind === 'oauth-openai';
  let j: any;
  try {
    j = openai
      ? await tokenPost(url, { grant_type: 'refresh_token', refresh_token: c.refresh!, client_id: OPENAI.clientId, scope: OPENAI.scope }, true)
      : await tokenPost(url, { grant_type: 'refresh_token', refresh_token: c.refresh!, client_id: ANTHROPIC.clientId }, false);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 400 || status === 401) {
      store.setKey(id, JSON.stringify({ needsLogin: true })); // refresh token đã chết — xoá, bắt login lại
      throw new OAuthLoginError(loginMsg());
    }
    throw err; // mạng/5xx: giữ token, lần sau thử lại
  }
  const next = toCreds(j, c);
  store.setKey(id, JSON.stringify(next)); // lưu refresh token MỚI trước khi dùng access token
  return next;
}

// ───────────── upstream: header/body bắt buộc của endpoint subscription ─────────────
// ⚠ GIẢ DANH CLIENT (rủi ro điều khoản): beta oauth + system prompt Claude Code / originator codex_cli_rs.
// Chỉ đúng phần tối thiểu endpoint đòi — KHÔNG giả User-Agent/Stainless/OS, KHÔNG đổi tên tool.
const SESSION_ID = randomUUID(); // ponytail: 1 session_id / process (router chạy 1 lần / app)

export function applyOAuth(kind: ProviderKind, headers: Record<string, string>, body: any, c: OAuthCreds): void {
  if (kind === 'oauth-anthropic') {
    const beta = [...ANTHROPIC.beta, ...(headers['anthropic-beta'] ?? '').split(',')].map((s) => s.trim()).filter(Boolean);
    headers['anthropic-beta'] = [...new Set(beta)].join(',');
    // Anthropic từ chối OAuth cho model không phải haiku nếu system không mở đầu bằng câu này; claude CLI đã gửi sẵn
    const sys = body.system;
    const blocks: any[] = typeof sys === 'string' ? (sys ? [{ type: 'text', text: sys }] : []) : Array.isArray(sys) ? sys : [];
    if (!blocks.some((b) => typeof b?.text === 'string' && b.text.startsWith(ANTHROPIC.systemPrefix))) {
      body.system = [{ type: 'text', text: ANTHROPIC.systemPrefix }, ...blocks];
    }
  } else {
    headers.originator = OPENAI.originator;
    headers.session_id = SESSION_ID;
    if (c.accountId) headers['chatgpt-account-id'] = c.accountId;
    body.stream = true; // backend codex chỉ nhận stream + store:false
    body.store = false;
  }
}

/** gom SSE của Responses API → JSON cuối (response.completed) cho client không stream */
export function completedFromSse(text: string): any | null {
  let out = null;
  for (const l of text.split(/\r?\n/)) {
    if (!l.startsWith('data:')) continue;
    try {
      const j = JSON.parse(l.slice(5).trim());
      if (j?.type === 'response.completed' && j.response) out = j.response;
    } catch {
      /* dòng không phải JSON */
    }
  }
  return out;
}

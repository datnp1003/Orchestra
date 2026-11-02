// Router R1 — proxy LLM local: 1 endpoint 127.0.0.1, model `<providerId>/<upstreamModel>`.
// Passthrough khi upstream nói native format của client; không thì dịch Messages ⇄ Chat, Responses → Chat/Messages (R2b).
// Không bao giờ log/echo key hay local token.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { OAuthLoginError, applyOAuth, completedFromSse, getAccessToken } from './oauth.js';
import { authHeaders, isOAuth, type Format, type ProviderConfig } from './providers.js';
import {
  ChatToMessagesStream,
  ChatToResponsesStream,
  MessagesToChatStream,
  chatToMessagesRequest,
  chatToMessagesResponse,
  chatToResponsesResponse,
  messagesToChatRequest,
  messagesToChatResponse,
  responsesToChatRequest,
  type ToolNames,
} from './translate.js';

export interface RouterOptions {
  store: { listProviders(): ProviderConfig[]; getKey(id: string): string | null; setKey(id: string, value: string): void };
  port?: number; // 0/undefined = random
  token?: string;
  defaultModel?: string | (() => string | undefined); // `<provider>/<model>` cho model không prefix (claude CLI gửi claude-haiku-… nền); hàm = đọc lại mỗi request
  onLog?: (line: string) => void;
  upstreamTimeoutMs?: number;
}
export interface RouterHandle {
  port: number;
  token: string;
  close(): Promise<void>;
}

const BODY_LIMIT = 20 * 1024 * 1024;
const MODELS_TTL = 5 * 60_000;
const FORWARD = ['anthropic-version', 'anthropic-beta', 'content-type', 'accept'];
const ROUTES: Record<string, Format> = { '/v1/messages': 'messages', '/v1/messages/count_tokens': 'messages', '/v1/chat/completions': 'chat', '/v1/responses': 'responses' };

class HttpError extends Error {
  constructor(readonly status: number, readonly type: string, message: string) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  if (Number(req.headers['content-length'] ?? 0) > BODY_LIMIT) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > BODY_LIMIT) {
        chunks.length = 0;
        resolve(null);
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tokenOk(req: http.IncomingMessage, token: Buffer): boolean {
  const auth = req.headers.authorization;
  const given = auth?.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-api-key'];
  if (typeof given !== 'string') return false;
  const b = Buffer.from(given);
  return b.length === token.length && timingSafeEqual(b, token);
}

export async function startRouter(opts: RouterOptions): Promise<RouterHandle> {
  const token = opts.token ?? randomBytes(32).toString('hex');
  const tokenBuf = Buffer.from(token);
  const timeoutMs = opts.upstreamTimeoutMs ?? 10 * 60_000;
  const modelCache = new Map<string, { at: number; ids: string[] }>();
  let port = 0;

  const enabled = () => opts.store.listProviders().filter((p) => p.enabled);
  const warned = new Set<string>();
  const warnOAuth = (p: ProviderConfig) => {
    if (!isOAuth(p.kind) || warned.has(p.id)) return;
    warned.add(p.id);
    opts.onLog?.(`[router] CẢNH BÁO: ${p.id} dùng OAuth subscription — rủi ro điều khoản/khoá tài khoản`);
  };
  enabled().forEach(warnOAuth);
  const resolve = (model: unknown): { p: ProviderConfig; model: string } | null => {
    const s = typeof model === 'string' ? model : '';
    const i = s.indexOf('/'); // tách ở '/' ĐẦU — model upstream có thể chứa '/'
    const p = i > 0 && i < s.length - 1 ? enabled().find((x) => x.id === s.slice(0, i)) : undefined;
    return p ? { p, model: s.slice(i + 1) } : null;
  };

  async function upstreamModels(p: ProviderConfig): Promise<string[]> {
    if (p.models) return p.models;
    const key = `${p.id}|${p.baseUrl}`;
    const hit = modelCache.get(key);
    if (hit && Date.now() - hit.at < MODELS_TTL) return hit.ids;
    const r = await fetch(`${p.baseUrl}/v1/models`, { headers: authHeaders(p.kind, opts.store.getKey(p.id)), signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ids = (((await r.json()) as any).data ?? []).map((m: any) => m?.id).filter((id: unknown) => typeof id === 'string');
    modelCache.set(key, { at: Date.now(), ids });
    return ids;
  }

  async function listModels(res: http.ServerResponse) {
    let errors = 0;
    const lists = await Promise.all(enabled().map((p) => upstreamModels(p).then((ids) => ids.map((id) => ({ id: `${p.id}/${id}`, object: 'model', owned_by: p.id })), () => (errors++, []))));
    sendJson(res, 200, { object: 'list', data: lists.flat() }, errors ? { 'x-orchestra-model-errors': String(errors) } : {});
  }

  async function proxy(req: http.IncomingMessage, res: http.ServerResponse, url: URL, log: { provider?: string; model?: string }) {
    const clientFmt = ROUTES[url.pathname];
    if (req.method !== 'POST' || !clientFmt) throw new HttpError(404, 'not_found', `không có route ${req.method} ${url.pathname}`);
    const raw = await readBody(req);
    // phần body thừa: node tự đọc bỏ sau khi trả 413 (client đã qua auth) — cắt socket thì client chỉ thấy ECONNRESET
    if (!raw) throw new HttpError(413, 'request_too_large', 'body > 20 MB');
    let body: any;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid_request_error', 'body không phải JSON');
    }
    if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid_request_error', 'body phải là JSON object');
    const def = typeof opts.defaultModel === 'function' ? opts.defaultModel() : opts.defaultModel;
    const r = resolve(body.model) ?? (def ? resolve(def) : null);
    if (!r) throw new HttpError(400, 'model_not_found', `model không route được: ${String(body.model)} (dùng <provider>/<model>)`);
    const { p, model } = r;
    Object.assign(log, { provider: p.id, model });

    const native = p.formats.includes(clientFmt);
    let target: string;
    let upstreamBody: any;
    let mode: 'pass' | 'm2c' | 'c2m' | 'r2c' | 'r2m' = 'pass';
    let names: ToolNames = new Map();
    if (native) {
      target = `${url.pathname}${url.search}`; // giữ query (claude gửi ?beta=true)
      upstreamBody = { ...body, model };
    } else if (url.pathname === '/v1/messages/count_tokens') {
      throw new HttpError(404, 'not_found', `provider ${p.id} không hỗ trợ count_tokens`);
    } else if (clientFmt === 'messages' && p.formats.includes('chat')) {
      mode = 'm2c';
      target = '/v1/chat/completions';
      upstreamBody = messagesToChatRequest(body, model);
    } else if (clientFmt === 'chat' && p.formats.includes('messages')) {
      mode = 'c2m';
      target = '/v1/messages';
      upstreamBody = chatToMessagesRequest(body, model);
    } else if (clientFmt === 'responses' && (p.formats.includes('chat') || p.formats.includes('messages'))) {
      const r = responsesToChatRequest(body, model);
      names = r.names;
      mode = p.formats.includes('chat') ? 'r2c' : 'r2m';
      target = mode === 'r2c' ? '/v1/chat/completions' : '/v1/messages';
      upstreamBody = mode === 'r2c' ? r.req : chatToMessagesRequest(r.req, model);
    } else {
      throw new HttpError(400, 'unsupported_route', `provider ${p.id} (${p.formats.join(',')}) không nhận ${clientFmt}`);
    }

    const headers: Record<string, string> = { ...authHeaders(p.kind, opts.store.getKey(p.id)), 'content-type': 'application/json' };
    if (native) for (const h of FORWARD) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h] as string;
    if (isOAuth(p.kind)) {
      warnOAuth(p);
      const creds = await getAccessToken(opts.store, p).catch((e) => {
        throw e instanceof OAuthLoginError ? new HttpError(401, 'authentication_error', `${p.id}: ${e.message}`) : e;
      });
      headers.authorization = `Bearer ${creds.access}`;
      applyOAuth(p.kind, headers, upstreamBody, creds);
      // endpoint subscription: anthropic luôn ?beta=true; codex backend ở <base>/responses
      target = p.kind === 'oauth-openai' ? '/responses' : `${target.split('?')[0]}?beta=true`;
    }
    // client ngắt → huỷ upstream; ponytail: timeout tính cả thời gian stream, đổi sang idle-timeout nếu có turn > 10 phút
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const up = await fetch(`${p.baseUrl}${target}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)]),
    });
    const ctype = up.headers.get('content-type') ?? 'application/json';

    // codex backend bị ép stream — client không stream nhận JSON gom từ response.completed
    if (p.kind === 'oauth-openai' && !body.stream && up.ok) {
      const done = completedFromSse(await up.text());
      if (!done) throw new HttpError(502, 'upstream_error', 'upstream không gửi response.completed');
      sendJson(res, 200, { ...done, model: body.model });
      return;
    }

    // passthrough hoặc lỗi upstream: status + content-type + bytes nguyên vẹn (fetch đã giải nén → không chuyển content-encoding)
    if (mode === 'pass' || !up.ok) {
      res.writeHead(up.status, { 'content-type': ctype, ...(ctype.includes('event-stream') ? { 'cache-control': 'no-cache' } : {}) });
      if (up.body) await pipeline(Readable.fromWeb(up.body as any), res);
      else res.end();
      return;
    }
    if (!body.stream) {
      const j = await up.json().catch(() => null);
      if (!j) throw new HttpError(502, 'upstream_error', 'upstream trả JSON không hợp lệ');
      const out =
        mode === 'm2c' ? chatToMessagesResponse(j)
        : mode === 'c2m' ? messagesToChatResponse(j)
        : chatToResponsesResponse(mode === 'r2c' ? j : messagesToChatResponse(j), names);
      sendJson(res, 200, { ...out, model: body.model });
      return;
    }
    let tr: { push(s: string): string; end(): string };
    if (mode === 'm2c') tr = new ChatToMessagesStream();
    else if (mode === 'c2m') tr = new MessagesToChatStream();
    else if (mode === 'r2c') tr = new ChatToResponsesStream(names);
    else {
      const a = new MessagesToChatStream();
      const b = new ChatToResponsesStream(names);
      tr = { push: (s) => b.push(a.push(s)), end: () => b.push(a.end()) + b.end() };
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const dec = new TextDecoder();
    await pipeline(
      Readable.fromWeb(up.body as any),
      async function* (src: AsyncIterable<Uint8Array>) {
        for await (const c of src) {
          const s = tr.push(dec.decode(c, { stream: true }));
          if (s) yield s;
        }
        yield tr.end();
      },
      res,
    );
  }

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const log: { provider?: string; model?: string } = {};
    res.on('close', () => opts.onLog?.(`${req.method} ${url.pathname} ${log.provider ?? '-'} ${log.model ?? '-'} ${res.statusCode} ${Date.now() - t0}ms`));
    try {
      // chống DNS rebinding: trang web trỏ domain → 127.0.0.1 sẽ có Host khác
      const host = req.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'forbidden', 'Host không hợp lệ');
      if (!tokenOk(req, tokenBuf)) throw new HttpError(401, 'authentication_error', 'thiếu hoặc sai token router');
      if (req.method === 'GET' && url.pathname === '/v1/models') await listModels(res);
      else await proxy(req, res, url, log);
    } catch (err) {
      if (res.headersSent) {
        res.destroy(); // đang stream dở — chỉ còn cách cắt kết nối
        return;
      }
      const e = err instanceof HttpError ? err : new HttpError(502, 'upstream_error', err instanceof Error ? err.message : String(err));
      sendJson(res, e.status, { type: 'error', error: { type: e.type, message: e.message } });
    }
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 0, '127.0.0.1', () => ok());
  });
  port = (server.address() as { port: number }).port;
  return {
    port,
    token,
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}

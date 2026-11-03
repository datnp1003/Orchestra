// Approval broker — thuần, KHÔNG import electron (unit test được): câu hỏi duyệt đi vào chat (card) thay vì modal native
import { randomUUID } from 'node:crypto';
import type { ApprovalKind } from '../../../prototype/src/permissions.js';

export interface ApprovalRequest { id: string; question: string; kind: ApprovalKind; approveLabel: string; rejectLabel: string }
export interface ApprovalBroker {
  /** resolve true/false khi user trả lời; signal abort (Dừng) / cancelAll → false */
  request(o: Omit<ApprovalRequest, 'id'> & { signal?: AbortSignal }): Promise<boolean>;
  /** false = id không chờ / đã trả lời / approve không phải boolean (bỏ qua) */
  respond(id: unknown, approve: unknown): boolean;
  pending(): ApprovalRequest[];
  cancelAll(): void;
}

export function createApprovalBroker(hooks: { onRequest: (r: ApprovalRequest) => void; onResolved?: (id: string, approve: boolean) => void }): ApprovalBroker {
  const open = new Map<string, { req: ApprovalRequest; done: (v: boolean) => void }>();
  return {
    request({ signal, ...o }) {
      if (signal?.aborted) return Promise.resolve(false);
      // id ngẫu nhiên: link orchestra://approval/<id>/approve từ web lạ không đoán được id
      const req: ApprovalRequest = { id: randomUUID(), ...o };
      return new Promise<boolean>((resolve) => {
        const onAbort = () => done(false);
        const done = (v: boolean) => {
          if (!open.delete(req.id)) return;
          signal?.removeEventListener('abort', onAbort);
          hooks.onResolved?.(req.id, v);
          resolve(v);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        open.set(req.id, { req, done });
        hooks.onRequest(req);
      });
    },
    respond(id, approve) {
      const p = typeof id === 'string' ? open.get(id) : undefined;
      if (!p || typeof approve !== 'boolean') return false;
      p.done(approve);
      return true;
    },
    pending: () => [...open.values()].map((p) => p.req),
    cancelAll() {
      for (const p of [...open.values()]) p.done(false);
    },
  };
}

/** orchestra://approval/<uuid>/approve|reject (toast action) — chuỗi khác → null */
export function parseApprovalUrl(url: unknown): { id: string; approve: boolean } | null {
  const m = /^orchestra:\/\/approval\/([0-9a-f-]{36})\/(approve|reject)\/?$/i.exec(typeof url === 'string' ? url : '');
  return m ? { id: m[1]!.toLowerCase(), approve: m[2]!.toLowerCase() === 'approve' } : null;
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
/** Windows toast có 2 nút Approve/Reject kích hoạt qua protocol orchestra:// */
export function approvalToastXml(r: ApprovalRequest, title: string): string {
  const body = r.question.split('\n')[0]!.slice(0, 200);
  const act = (label: string, a: string) => `<action content="${xml(label)}" activationType="protocol" arguments="orchestra://approval/${r.id}/${a}"/>`;
  return `<toast><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual>`
    + `<actions>${act(r.approveLabel, 'approve')}${act(r.rejectLabel, 'reject')}</actions></toast>`;
}

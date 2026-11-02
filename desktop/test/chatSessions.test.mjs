// Session chat — parse jsonl để resume (hàm thuần, không fs)
import assert from 'node:assert/strict';
import { parseChatSession, SESSION_ID_RE } from '../out/desktop/src/main/chatSessions.js';
import { setLocale } from '../out/prototype/src/i18n/index.js';

const at = '2026-11-02T00:00:00.000Z';
const L = (role, content) => JSON.stringify({ at, role, content });
const long = 'Thêm cổng thanh toán X theo pattern Y cho service payment, kèm test và docs đầy đủ';
const text = [
  L('user', long),
  L('assistant', [{ type: 'thinking', thinking: 'hm', signature: 'sig' }, { type: 'text', text: 'Khảo sát repo' }, { type: 'tool_use', id: 't1', name: 'fleet_dispatch', input: {} }]),
  L('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
  L('assistant', [{ type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'Xong' }]),
  '{hỏng',
  L('user', 'lượt 2'),
  L('assistant', [{ type: 'thinking', thinking: 'x', signature: 's' }]), // chỉ thinking → rỗng → bỏ
  L('assistant', [{ type: 'tool_use', id: 't2', name: 'fleet_status', input: {} }]), // treo, không có tool_result
  '',
].join('\r\n');

const s = parseChatSession(text);
assert.ok(!JSON.stringify(s.history).includes('thinking'), 'thinking/redacted_thinking bị bỏ');
assert.equal(s.history.length, 4, 'tool_use treo + user chưa có phản hồi bị bỏ');
assert.equal(s.history.at(-1).role, 'assistant');
assert.deepEqual(s.messages, [
  { role: 'user', text: long },
  { role: 'orch', text: 'Khảo sát repo' },
  { role: 'step', text: '🔧 fleet_dispatch' },
  { role: 'orch', text: 'Xong' },
], 'lượt chỉ có tool_result bị bỏ');
assert.equal(s.title.length, 60);
assert.ok(long.startsWith(s.title.slice(0, -1)) && s.title.endsWith('…'), 'title từ user message đầu');
assert.equal(s.turns, 1);
setLocale('vi');
assert.deepEqual(parseChatSession(''), { history: [], messages: [], title: '(trống)', turns: 0 });
setLocale('en');
assert.equal(parseChatSession('').title, '(empty)', 'title rỗng theo locale');
console.log('✓ parseChatSession: thinking bỏ, tool_use treo bỏ, title, tool_result-only bỏ');

for (const bad of ['../x', 'a/b', 'a\\b', '']) assert.ok(!SESSION_ID_RE.test(bad), `id ${bad} bị chặn`);
assert.ok(SESSION_ID_RE.test('2026-11-02T08-00-00-000Z'));
console.log('✓ SESSION_ID_RE chặn path traversal');
console.log('CHAT SESSIONS TEST PASS ✓');

// fleetCache: get() chờ probe đang chạy, refresh() de-dup, stale → trả cũ + refresh nền (fake probe + fake clock)
import assert from 'node:assert/strict';
import { createFleetCache } from '../out/desktop/src/main/fleetCache.js';

let clock = 0;
let calls = 0;
let release = [];
const probe = () => new Promise((r) => { calls++; release.push(() => r(`v${calls}`)); });
const changed = [];
const c = createFleetCache(probe, { staleMs: 1000, now: () => clock, onChange: (v) => changed.push(v) });
const flush = () => { release.splice(0).forEach((f) => f()); return new Promise((r) => setImmediate(r)); };

// startup probe + get() trước khi xong → cùng 1 probe
const boot = c.refresh();
const first = c.get();
assert.equal(calls, 1, 'get() khi đang probe không probe lần 2');
await flush();
assert.equal(await boot, 'v1');
assert.equal(await first, 'v1');
assert.deepEqual(changed, ['v1']);

// cache còn tươi → trả ngay, không probe
assert.equal(await c.get(), 'v1');
assert.equal(calls, 1);

// refresh() de-dup
const a = c.refresh();
const b = c.refresh();
assert.equal(a, b, 'refresh trùng trả cùng promise');
assert.equal(calls, 2);
await flush();
assert.equal(await a, 'v2');

// stale → trả cũ ngay, refresh nền, onChange khi xong
clock = 5000;
assert.equal(await c.get(), 'v2', 'stale vẫn trả data cũ');
assert.equal(calls, 3, 'stale kích refresh nền');
assert.equal(await c.get(), 'v2');
assert.equal(calls, 3, 'refresh nền đang chạy → không probe thêm');
await flush();
assert.deepEqual(changed, ['v1', 'v2', 'v3']);
assert.equal(await c.get(), 'v3');

// probe lỗi: get() lần đầu reject, lần sau thử lại
const bad = createFleetCache(() => (calls++ % 2 ? Promise.resolve('ok') : Promise.reject(new Error('boom'))));
calls = 0;
await assert.rejects(bad.get(), /boom/);
assert.equal(await bad.get(), 'ok');
console.log('FLEET CACHE TEST PASS ✓');

// fleetCache: get() waits for the running probe, refresh() de-dups, stale → return old + background refresh (fake probe + fake clock)
import assert from 'node:assert/strict';
import { createFleetCache } from '../out/desktop/src/main/fleetCache.js';

let clock = 0;
let calls = 0;
let release = [];
const probe = () => new Promise((r) => { calls++; release.push(() => r(`v${calls}`)); });
const changed = [];
const c = createFleetCache(probe, { staleMs: 1000, now: () => clock, onChange: (v) => changed.push(v) });
const flush = () => { release.splice(0).forEach((f) => f()); return new Promise((r) => setImmediate(r)); };

// startup probe + get() before it finishes → same probe
const boot = c.refresh();
const first = c.get();
assert.equal(calls, 1, 'get() during a probe does not probe again');
await flush();
assert.equal(await boot, 'v1');
assert.equal(await first, 'v1');
assert.deepEqual(changed, ['v1']);

// cache still fresh → return immediately, no probe
assert.equal(await c.get(), 'v1');
assert.equal(calls, 1);

// refresh() de-dup
const a = c.refresh();
const b = c.refresh();
assert.equal(a, b, 'duplicate refresh returns the same promise');
assert.equal(calls, 2);
await flush();
assert.equal(await a, 'v2');

// stale → return old immediately, background refresh, onChange when done
clock = 5000;
assert.equal(await c.get(), 'v2', 'stale still returns old data');
assert.equal(calls, 3, 'stale triggers background refresh');
assert.equal(await c.get(), 'v2');
assert.equal(calls, 3, 'background refresh running → no extra probe');
await flush();
assert.deepEqual(changed, ['v1', 'v2', 'v3']);
assert.equal(await c.get(), 'v3');

// probe error: first get() rejects, next one retries
const bad = createFleetCache(() => (calls++ % 2 ? Promise.resolve('ok') : Promise.reject(new Error('boom'))));
calls = 0;
await assert.rejects(bad.get(), /boom/);
assert.equal(await bad.get(), 'ok');
console.log('FLEET CACHE TEST PASS ✓');

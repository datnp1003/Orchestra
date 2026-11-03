// checkStatusAsync: parse version, binary thiếu → installed:false, probe chạy song song (không spawnSync)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStatusAsync } from '../dist/registry.js';

const fake = (over) => ({ id: 'fake', display: 'Fake', bin: 'node', versionRegex: /v(\d+\.\d+\.\d+)/, notes: [], ...over });
const node = (code) => ({ cmd: process.execPath, args: ['-e', code] });

test('checkStatusAsync: version parse + auth từ text', async () => {
  const s = await checkStatusAsync(fake({ versionCmd: node("console.log('v1.2.3')"), authCmd: node("console.log('Logged in using ChatGPT')") }));
  assert.equal(s.installed, true);
  assert.ok(s.binPath);
  assert.equal(s.version, '1.2.3');
  assert.equal(s.auth, 'ok');
});

test('checkStatusAsync: binary thiếu → installed:false, không chạy version', async () => {
  const s = await checkStatusAsync(fake({ bin: 'orchestra-no-such-bin-zz9', versionCmd: { cmd: 'orchestra-no-such-bin-zz9', args: ['--version'] } }));
  assert.equal(s.installed, false);
  assert.equal(s.version, undefined);
  assert.equal(s.auth, 'unknown');
});

// ponytail: so với 1 probe đo ngay trước (where + node startup ≈ 250ms/probe trên Windows → mốc tuyệt đối 550ms không đạt được); tuần tự sẽ ≥ 2×
test('checkStatusAsync: 2 probe 300ms song song < 1.6× một probe', async () => {
  const slow = fake({ versionCmd: node("setTimeout(() => console.log('v0.0.1'), 300)") });
  let t0 = performance.now();
  await checkStatusAsync(slow);
  const one = performance.now() - t0;
  t0 = performance.now();
  const r = await Promise.all([checkStatusAsync(slow), checkStatusAsync(slow)]);
  const ms = performance.now() - t0;
  assert.deepEqual(r.map((x) => x.version), ['0.0.1', '0.0.1']);
  assert.ok(ms < one * 1.6, `parallel ${ms.toFixed(0)}ms vs single ${one.toFixed(0)}ms`);
});

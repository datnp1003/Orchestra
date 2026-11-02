// Import provider từ config CLI — hàm thuần, không đọc file thật
import assert from 'node:assert/strict';
import { tomlSection, fromClaudeSettings, fromCodexConfig } from '../out/desktop/src/main/importCli.js';

const toml = `# codex
model = "gpt-5"
model_provider = "gw"   # active

[model_providers.gw]
name = "Gateway"
base_url = "https://gw.example.com/v1"
env_key = "GW_KEY"
query_params = { a = 1 }

[model_providers.other]
base_url = "https://other"

[profiles."x"]
model_provider = "other"
`;
assert.deepEqual(tomlSection(toml, ''), { model: 'gpt-5', model_provider: 'gw' });
assert.deepEqual(tomlSection(toml, 'model_providers.gw'), { name: 'Gateway', base_url: 'https://gw.example.com/v1', env_key: 'GW_KEY' });
assert.equal(tomlSection('a = "x\\"y"', '').a, 'x"y', 'escape trong chuỗi');
console.log('✓ tomlSection');

const cx = fromCodexConfig(toml, { GW_KEY: 'sk-cx' });
assert.deepEqual(cx, { cfg: { id: 'codex-gw', kind: 'openai-compatible', baseUrl: 'https://gw.example.com/v1', formats: ['responses', 'chat'] }, key: 'sk-cx' });
assert.equal(fromCodexConfig(toml, {}).key, undefined, 'env thiếu → không key');
assert.ok('skip' in fromCodexConfig('model = "x"', {}), 'không model_provider → skip');
assert.ok('skip' in fromCodexConfig('model_provider = "nope"', {}), 'section thiếu base_url → skip');
console.log('✓ fromCodexConfig');

const gw = fromClaudeSettings(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw.co/api', ANTHROPIC_AUTH_TOKEN: 'tok' } }));
assert.deepEqual(gw, { cfg: { id: 'claude-gw', kind: 'anthropic-compatible', baseUrl: 'https://gw.co/api', formats: ['messages', 'chat', 'responses'] }, key: 'tok' });
const off = fromClaudeSettings(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: 'sk-ant' } }));
assert.equal(off.cfg.kind, 'anthropic');
assert.equal(off.key, 'sk-ant');
assert.ok('skip' in fromClaudeSettings('{}'), 'không env → skip');
assert.ok('skip' in fromClaudeSettings('{bad'), 'JSON hỏng → skip');
assert.ok('skip' in fromClaudeSettings(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'not a url' } })), 'URL hỏng → skip');
console.log('✓ fromClaudeSettings');
console.log('IMPORT CLI TEST PASS ✓');

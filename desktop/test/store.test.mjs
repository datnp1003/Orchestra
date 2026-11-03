// Store distribution must never invoke the GitHub/NSIS updater.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../out/desktop/src/main/ipc.js', import.meta.url), 'utf8');
const setup = source.slice(source.indexOf('export function setupAutoUpdater('), source.indexOf('\nvoid conformanceBadge;')).replace('export ', '');
vm.runInNewContext(`${setup}; setupAutoUpdater(() => null, () => {});`, { process: { windowsStore: true }, app: { get isPackaged() { throw Error('Store guard missing'); } } });
const start = source.indexOf('ipcMain.handle(IPC.UPDATE_CHECK, async () => {');
assert.ok(start >= 0);
const handler = source.slice(start, source.indexOf('\n    });', start) + 7);
let callback;
vm.runInNewContext(handler, { process: { windowsStore: true }, app: { get isPackaged() { throw Error('Store guard missing'); } }, IPC: { UPDATE_CHECK: 'check' }, ipcMain: { handle: (_name, fn) => { callback = fn; } } });
assert.equal((await callback()).status, 'store-managed');
const config = JSON.parse(readFileSync(new URL('../electron-builder.store.json', import.meta.url), 'utf8'));
assert.equal(config.appx.identityName, 'tNguyn.OrchestraDesktop');
assert.equal(config.appx.publisher, 'CN=EC19BE28-3DD8-47CF-9951-1CF43B3974C7');
assert.equal(config.appx.electronUpdaterAware, false);
console.log('STORE UPDATER GUARDS PASS');

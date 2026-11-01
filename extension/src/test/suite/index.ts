// Integration test — chạy trong VS Code thật (headless qua @vscode/test-electron)
import * as assert from 'node:assert';
import * as vscode from 'vscode';

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension('orchestra-dev.orchestra');
  assert.ok(ext, 'extension orchestra-dev.orchestra không tìm thấy');
  await ext!.activate();
  assert.ok(ext!.isActive, 'extension chưa active');

  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['orchestra.dispatch', 'orchestra.runPipeline', 'orchestra.showMatrix', 'orchestra.refreshViews', 'orchestra._fleetSnapshot']) {
    assert.ok(cmds.includes(c), `thiếu command ${c}`);
  }

  // Fleet snapshot — phải thấy CLI thật trên máy
  const fleet = (await vscode.commands.executeCommand('orchestra._fleetSnapshot')) as { id: string; installed: boolean; version?: string }[];
  assert.ok(Array.isArray(fleet) && fleet.length >= 2, `fleet snapshot: ${JSON.stringify(fleet)}`);
  const claude = fleet.find((f) => f.id === 'claude');
  assert.ok(claude && claude.installed, 'claude phải installed');
  const codex = fleet.find((f) => f.id === 'codex');
  assert.ok(codex && codex.installed, 'codex phải installed');

  // Tasks snapshot — demo repo có task records từ P2–P4
  const tasks = (await vscode.commands.executeCommand('orchestra._tasksSnapshot')) as number;
  assert.ok(typeof tasks === 'number' && tasks >= 3, `tasks snapshot: ${tasks}`);

  // Policy matrix html — có bảng role × worker + KB
  const html = (await vscode.commands.executeCommand('orchestra._policyMatrixHtml')) as string;
  assert.ok(typeof html === 'string' && html.includes('<table') && html.includes('coder'), 'policy matrix html');

  console.log('INTEGRATION TEST PASS ✓ (activation + commands + fleet + tasks + matrix)');
}

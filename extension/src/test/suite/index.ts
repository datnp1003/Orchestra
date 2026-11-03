// Integration test — runs in real VS Code (headless via @vscode/test-electron)
import * as assert from 'node:assert';
import * as vscode from 'vscode';

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension('orchestra-dev.orchestra');
  assert.ok(ext, 'extension orchestra-dev.orchestra not found');
  await ext!.activate();
  assert.ok(ext!.isActive, 'extension not active');

  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['orchestra.dispatch', 'orchestra.runPipeline', 'orchestra.showMatrix', 'orchestra.refreshViews', 'orchestra._fleetSnapshot']) {
    assert.ok(cmds.includes(c), `missing command ${c}`);
  }

  // Fleet snapshot — must see real CLIs on the machine
  const fleet = (await vscode.commands.executeCommand('orchestra._fleetSnapshot')) as { id: string; installed: boolean; version?: string }[];
  assert.ok(Array.isArray(fleet) && fleet.length >= 2, `fleet snapshot: ${JSON.stringify(fleet)}`);
  const claude = fleet.find((f) => f.id === 'claude');
  assert.ok(claude && claude.installed, 'claude must be installed');
  const codex = fleet.find((f) => f.id === 'codex');
  assert.ok(codex && codex.installed, 'codex must be installed');

  // Tasks snapshot — demo repo has task records from P2–P4
  const tasks = (await vscode.commands.executeCommand('orchestra._tasksSnapshot')) as number;
  assert.ok(typeof tasks === 'number' && tasks >= 3, `tasks snapshot: ${tasks}`);

  // Policy matrix html — has role × worker table + KB
  const html = (await vscode.commands.executeCommand('orchestra._policyMatrixHtml')) as string;
  assert.ok(typeof html === 'string' && html.includes('<table') && html.includes('coder'), 'policy matrix html');

  console.log('INTEGRATION TEST PASS ✓ (activation + commands + fleet + tasks + matrix)');
}

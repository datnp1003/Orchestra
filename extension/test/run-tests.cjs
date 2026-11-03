// Test runner — uses the locally installed VS Code (no extra download), runs headless
const { runTests } = require('@vscode/test-electron');
const path = require('path');
const fs = require('fs');

function findVscode() {
  const candidates = [
    'C:\\Users\\Nitro V 15\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return undefined; // fallback: let test-electron download it
}

async function main() {
  try {
    await runTests({
      vscodeExecutablePath: findVscode(),
      extensionDevelopmentPath: path.join(__dirname, '..'),
      extensionTestsPath: path.join(__dirname, '..', 'out', 'extension', 'src', 'test', 'suite', 'index.js'),
      launchArgs: [
        'C:\\Users\\Nitro V 15\\Desktop\\Source\\Orchestra\\prototype\\demo-repo',
        '--disable-extensions',
        '--disable-gpu',
      ],
    });
    console.log('VS Code integration test: DONE');
    process.exit(0);
  } catch (err) {
    console.error('INTEGRATION TEST FAILED:', err);
    process.exit(1);
  }
}

main();

// Test runner — dùng VS Code đã cài trên máy (không tải thêm), chạy headless
const { runTests } = require('@vscode/test-electron');
const path = require('path');
const fs = require('fs');

function findVscode() {
  const candidates = [
    'C:\\Users\\Nitro V 15\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return undefined; // fallback: để test-electron tự tải
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

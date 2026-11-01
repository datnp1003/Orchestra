import { spawnSync, spawn, type ChildProcess } from 'node:child_process';

// ---------- P6.3: installer — Worker Protocol §3/§4 ----------
// npm là kênh chuẩn phân phối agent CLI (claude/codex/opencode đều có package npm).
// Auth KHÔNG tự động được (OAuth trình duyệt) — sau install, hướng dẫn user login bằng tay.

export function installWorker(
  m: import('./types.js').Manifest,
  onLog?: (s: string) => void,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const log = (s: string) => onLog?.(s);
    if (!m.install?.npm) {
      resolve({ ok: false, detail: `manifest '${m.id}' không khai install — chưa có kênh phân phối` });
      return;
    }
    const npmCheck = spawnSync('npm', ['--version'], { encoding: 'utf8', windowsHide: true, shell: true, timeout: 30_000 });
    if (npmCheck.status !== 0) {
      resolve({ ok: false, detail: 'npm không có trên PATH — cài Node.js (https://nodejs.org) trước khi cài worker' });
      return;
    }
    log(`npm install -g ${m.install.npm} …`);
    const child: ChildProcess = spawn('npm', ['install', '-g', m.install.npm], {
      windowsHide: true,
      shell: true, // npm.cmd trên Windows
    });
    let tail = '';
    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      tail = (tail + '\n' + s).slice(-2000);
      for (const line of s.split(/\r?\n/)) if (line.trim()) log(line.trim());
    });
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) log(s.slice(0, 200));
    });
    child.on('error', (err) => resolve({ ok: false, detail: `spawn npm lỗi: ${err.message}` }));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, detail: `npm install exit=${code}: ${tail.slice(-300)}` });
        return;
      }
      const v = tryRun(m.versionCmd, 60_000);
      if (!v.ok) {
        resolve({ ok: true, detail: `cài xong NHƯNG chưa thấy '${m.bin}' trên PATH — mở terminal mới hoặc restart VS Code để PATH cập nhật, rồi chạy '${m.bin}' để login` });
        return;
      }
      resolve({ ok: true, detail: `cài xong: ${m.bin} ${v.out.split(/\r?\n/)[0]}` });
    });
  });
}

export function uninstallWorker(m: import('./types.js').Manifest): { ok: boolean; detail: string } {
  if (!m.install?.npm) return { ok: false, detail: `manifest '${m.id}' không khai install.npm` };
  const r = spawnSync('npm', ['uninstall', '-g', m.install.npm], { encoding: 'utf8', windowsHide: true, shell: true, timeout: 120_000 });
  return { ok: r.status === 0, detail: r.status === 0 ? `đã gỡ ${m.install.npm}` : `npm uninstall exit=${r.status}` };
}

export interface WorkerStatus {
  id: string;
  display: string;
  installed: boolean;
  binPath?: string;
  version?: string;
  auth: 'ok' | 'failed' | 'unknown';
  experimental: boolean;
  notes: string[];
}

function lookupBin(bin: string): string | undefined {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [bin], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout) return undefined;
  const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first;
}

function tryRun(spec: { cmd: string; args: string[] }, timeoutMs = 15000): { ok: boolean; out: string } {
  try {
    const r = spawnSync(spec.cmd, spec.args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    return { ok: r.status === 0, out };
  } catch {
    return { ok: false, out: '' };
  }
}

export function checkStatus(m: import('./types.js').Manifest): WorkerStatus {
  const binPath = lookupBin(m.bin);
  const base: WorkerStatus = {
    id: m.id,
    display: m.display,
    installed: binPath !== undefined,
    binPath,
    auth: 'unknown',
    experimental: m.experimental === true,
    notes: m.notes,
  };
  if (!binPath) return base;

  const v = tryRun(m.versionCmd);
  if (v.ok) {
    const match = m.versionRegex.exec(v.out.split(/\r?\n/)[0] ?? '');
    base.version = match ? (match[1] ?? v.out.split(/\r?\n/)[0]) : v.out.split(/\r?\n/)[0];
  }
  if (m.authCmd) {
    const a = tryRun(m.authCmd);
    // codex login status exit 0 = logged in; nhưng một số version in trạng thái mà exit 0
    // kể cả khi chưa login → coi text là tín hiệu phụ
    const text = a.out.toLowerCase();
    if (!a.ok || text.includes('not logged in')) base.auth = 'failed';
    else if (text.includes('logged in')) base.auth = 'ok';
  }
  return base;
}

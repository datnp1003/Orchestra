// Legacy binary Office (.doc/.xls/.ppt) → OOXML using whatever is installed: LibreOffice first, else Microsoft Office (COM).
// No parser of our own: these formats are huge binary specs; the installed office suite is the correct reader.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const TARGET: Record<string, 'docx' | 'xlsx' | 'pptx'> = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' };
const TIMEOUT_MS = 90_000;

const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) =>
  new Promise<boolean>((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true, env: env ? { ...process.env, ...env } : process.env }, (err) => resolve(!err));
  });

function sofficePath(): string | null {
  const known = ['C:/Program Files/LibreOffice/program/soffice.exe', 'C:/Program Files (x86)/LibreOffice/program/soffice.exe', '/usr/bin/soffice', '/usr/local/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'];
  return known.find((p) => existsSync(p)) ?? null;
}

// Paths reach PowerShell only through env vars — never interpolated into the script.
// Macros forced off (AutomationSecurity = 3); a dummy password makes protected files fail instead of prompting.
// PowerPoint is single-instance: only Quit when it was not already running (never close the user's open decks).
const PS: Record<string, string> = {
  doc: `$a = New-Object -ComObject Word.Application; try { $a.Visible = $false; $a.DisplayAlerts = 0; $a.AutomationSecurity = 3
  $d = $a.Documents.Open($env:ORCH_SRC, $false, $true, $false, 'x-no-password'); $d.SaveAs2($env:ORCH_DST, 16); $d.Close(0) } finally { $a.Quit() }`,
  xls: `$a = New-Object -ComObject Excel.Application; try { $a.Visible = $false; $a.DisplayAlerts = $false; $a.AutomationSecurity = 3
  $b = $a.Workbooks.Open($env:ORCH_SRC, 0, $true, [Type]::Missing, 'x-no-password'); $b.SaveAs($env:ORCH_DST, 51); $b.Close($false) } finally { $a.Quit() }`,
  ppt: `$had = Get-Process POWERPNT -ErrorAction SilentlyContinue; $a = New-Object -ComObject PowerPoint.Application; try { $a.AutomationSecurity = 3
  $p = $a.Presentations.Open($env:ORCH_SRC + '::x-no-password', -1, 0, 0); $p.SaveAs($env:ORCH_DST, 24); $p.Close() } finally { if (-not $had) { $a.Quit() } }`,
};

/** convert src (.doc/.xls/.ppt) into dir → absolute path of the new file, or null (no office suite / failed / timed out) */
// ponytail: a timed-out COM conversion can leave a hidden WINWORD/EXCEL process behind — track its PID if that shows up in practice
export async function convertLegacyOffice(src: string, dir: string): Promise<{ file: string; via: string } | null> {
  const ext = path.extname(src).slice(1).toLowerCase();
  const to = TARGET[ext];
  if (!to) return null;
  const dst = path.join(dir, `${path.basename(src, path.extname(src))}.${to}`);
  const so = sofficePath();
  if (so && (await run(so, ['--headless', '--norestore', '--convert-to', to, '--outdir', dir, src])) && existsSync(dst)) return { file: dst, via: 'LibreOffice' };
  if (process.platform === 'win32' && (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS[ext]!], { ORCH_SRC: src, ORCH_DST: dst })) && existsSync(dst)) {
    return { file: dst, via: 'Microsoft Office' };
  }
  return null;
}

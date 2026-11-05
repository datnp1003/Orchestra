// Legacy binary Office (.doc/.xls/.ppt) → OOXML. LibreOffice is the required engine (as ZCode's docx/xlsx skills):
// missing → install it (caller asks the user first); Microsoft Office (COM) only when the install was declined or failed.
// No parser of our own: these formats are huge binary specs; an office suite is the correct reader.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const TARGET: Record<string, 'docx' | 'xlsx' | 'pptx'> = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' };
const CONVERT_TIMEOUT_MS = 90_000;
const INSTALL_TIMEOUT_MS = 20 * 60_000;
export const SOFFICE_KNOWN = ['C:/Program Files/LibreOffice/program/soffice.exe', 'C:/Program Files (x86)/LibreOffice/program/soffice.exe', '/usr/bin/soffice', '/usr/local/bin/soffice', '/opt/homebrew/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'];

const run = (cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv; timeout?: number } = {}) =>
  new Promise<boolean>((resolve) => {
    execFile(cmd, args, { timeout: o.timeout ?? CONVERT_TIMEOUT_MS, windowsHide: true, env: o.env ? { ...process.env, ...o.env } : process.env }, (err) => resolve(!err));
  });

/** installed soffice: default install dirs, then PATH (portable / custom installs) */
export function sofficePath(pathEnv = process.env.PATH ?? process.env.Path ?? ''): string | null {
  const exe = process.platform === 'win32' ? 'soffice.exe' : 'soffice';
  const onPath = pathEnv.split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe));
  return [...SOFFICE_KNOWN, ...onPath].find((p) => existsSync(p)) ?? null;
}

/** install LibreOffice silently (Windows: winget; Windows shows its own UAC prompt) → soffice path, or null */
// ponytail: macOS/Linux need sudo/brew — not automated; the caller reports it. Add brew/apt when a non-Windows user needs it.
export async function installLibreOffice(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  // exit code ignored: "already installed" / "no upgrade" are non-zero too — the binary on disk decides
  await run('winget.exe', ['install', '--id', 'TheDocumentFoundation.LibreOffice', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], { timeout: INSTALL_TIMEOUT_MS });
  return sofficePath();
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

export interface ConvertOpts {
  /** LibreOffice missing → get it (ask + install); memoize per turn so several files ask once */
  ensureLibreOffice?: () => Promise<string | null>;
  /** last resort when LibreOffice is unavailable (default: on, Windows only) */
  msOffice?: boolean;
}
/** convert src (.doc/.xls/.ppt) into dir → absolute path of the new file, or null */
// ponytail: a timed-out COM conversion can leave a hidden WINWORD/EXCEL process behind — track its PID if that shows up in practice
export async function convertLegacyOffice(src: string, dir: string, o: ConvertOpts = {}): Promise<{ file: string; via: string } | null> {
  const ext = path.extname(src).slice(1).toLowerCase();
  const to = TARGET[ext];
  if (!to) return null;
  const dst = path.join(dir, `${path.basename(src, path.extname(src))}.${to}`);
  const so = sofficePath() ?? (o.ensureLibreOffice ? await o.ensureLibreOffice() : null);
  if (so && (await run(so, ['--headless', '--norestore', '--convert-to', to, '--outdir', dir, src])) && existsSync(dst)) return { file: dst, via: 'LibreOffice' };
  if ((o.msOffice ?? true) && process.platform === 'win32' && (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS[ext]!], { env: { ORCH_SRC: src, ORCH_DST: dst } })) && existsSync(dst)) {
    return { file: dst, via: 'Microsoft Office' };
  }
  return null;
}

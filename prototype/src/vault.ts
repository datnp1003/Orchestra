// Credential Vault — Worker Protocol §5: OS-level DPAPI (CurrentUser), key never passes through the LLM,
// never plaintext on disk, never in the repo. Stored at ~/.orchestra-vault/<provider>.bin
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const vaultDir = () => path.join(os.homedir(), '.orchestra-vault');
const credPath = (provider: string) => path.join(vaultDir(), `${provider}.bin`);

function ps(script: string, input?: string): { ok: boolean; out: string } {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      input,
    });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
}

const ADD_TYPE = "Add-Type -AssemblyName System.Security;";

export function vaultSet(provider: string, secret: string, baseUrl?: string): boolean {
  if (process.platform !== 'win32') return false;
  mkdirSync(vaultDir(), { recursive: true });
  const file = credPath(provider).replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference='Stop'",
    ADD_TYPE,
    "$s=[Console]::In.ReadToEnd().Trim()",
    '$k=[Text.Encoding]::UTF8.GetBytes($s)',
    '$p=[Security.Cryptography.ProtectedData]::Protect($k,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    `[IO.File]::WriteAllBytes('${file}',$p)`,
    "'OK'",
  ].join('; ');
  // P6.4: entry JSON {v:2, secret, base_url?} — the vault now holds provider config, not just a key
  // base_url omitted → KEEP the old entry's value (setting only the key must not wipe a custom provider)
  const existing = readRaw(provider);
  const effectiveBaseUrl = baseUrl !== undefined ? baseUrl : existing?.base_url ?? null;
  // secret goes via stdin — not on the command line (invisible to task manager)
  const payload = JSON.stringify({ v: 2, secret, base_url: effectiveBaseUrl });
  const r = ps(script, payload);
  return r.ok && r.out.includes('OK');
}

function readRaw(provider: string): { secret: string; base_url: string | null } | null {
  if (process.platform !== 'win32') return null;
  const file = credPath(provider);
  if (!existsSync(file)) return null;
  const script = [
    "$ErrorActionPreference='Stop'",
    ADD_TYPE,
    `[byte[]]$b=[IO.File]::ReadAllBytes('${file.replaceAll("'", "''")}')`,
    '$u=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($u))',
  ].join('; ');
  const r = ps(script);
  if (!r.ok || !r.out) return null;
  try {
    const parsed = JSON.parse(r.out) as { v?: number; secret?: string; base_url?: string | null };
    if (parsed && typeof parsed.secret === 'string') {
      return { secret: parsed.secret, base_url: parsed.base_url ?? null };
    }
  } catch {
    /* legacy: raw secret, not JSON */
  }
  return { secret: r.out, base_url: null };
}

export function vaultGet(provider: string): string | null {
  return readRaw(provider)?.secret ?? null;
}

export function vaultGetBaseUrl(provider: string): string | null {
  return readRaw(provider)?.base_url ?? null;
}

export function vaultList(): string[] {
  const dir = vaultDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.bin')).map((f) => f.replace(/\.bin$/, ''));
}

export function vaultDelete(provider: string): boolean {
  const file = credPath(provider);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

/** Status for the UI — never returns the key value */
export function vaultStatus(provider: string): { configured: boolean } {
  return { configured: existsSync(credPath(provider)) };
}

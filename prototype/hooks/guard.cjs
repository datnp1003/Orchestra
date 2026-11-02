#!/usr/bin/env node
// Orchestra guard hook — PreToolUse chặn TRƯỚC khi lệnh chạy (Worker Protocol §9 Lớp 1/§9b, conformance case 8)
// Đọc JSON từ stdin ({tool_name, tool_input}), deny bằng JSON permissionDecision.
// Cấu hình qua env: ORCH_GUARD_NET=off|on, ORCH_GUARD_ROOT=<worktree cwd>
const path = require('node:path');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  let input = {};
  try {
    input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    process.exit(0);
  }
  const tool = String(input.tool_name || '');
  const ti = input.tool_input || {};
  const cmd = String(ti.command || '');
  const fp = String(ti.file_path || '');
  // resolve (khử ..), \ → /, bỏ / cuối, lowercase (Windows FS không phân biệt hoa thường)
  const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const rawRoot = process.env.ORCH_GUARD_ROOT || '';
  const root = rawRoot ? norm(rawRoot) : '';
  const netOff = process.env.ORCH_GUARD_NET === 'off';

  const deny = (reason) => {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `[orchestra-guard] ${reason}`,
        },
      }),
    );
    process.exit(0);
  };

  // net: off — pattern-level (không phải OS guarantee; lưu ý trung thực trong spec)
  if (netOff && tool === 'Bash' && /\b(curl|wget|nc|netcat|ssh|scp|ftp)\b/.test(cmd)) {
    return deny(`network attempt bị chặn (net: off): ${cmd.slice(0, 120)}`);
  }
  if (tool === 'Bash' && /\bgit\s+push\b/.test(cmd)) {
    return deny('git push bị chặn — merge chỉ qua merge gate của orchestrator');
  }
  if (tool === 'Bash' && /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+\/(\s|$)/.test(cmd)) {
    return deny('rm -rf / bị chặn');
  }
  // path escape: file_path ngoài worktree root (path tương đối → resolve theo root)
  const outside = (p) => {
    const abs = norm(path.resolve(rawRoot, p));
    return abs !== root && !abs.startsWith(root + '/');
  };
  if (fp && root && outside(fp)) return deny(`ghi ngoài worktree bị chặn: ${fp}`);
  // codex: sửa file = apply_patch envelope (tool_name Bash hoặc apply_patch, nằm trong command)
  if (root && cmd.includes('*** Begin Patch')) {
    for (const m of cmd.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
      const p = m[1].trim();
      if (outside(p)) return deny(`apply_patch ghi ngoài worktree bị chặn: ${p}`);
    }
  }
  process.exit(0);
});

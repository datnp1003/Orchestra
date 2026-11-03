#!/usr/bin/env node
// Orchestra guard hook — PreToolUse blocks BEFORE the command runs (Worker Protocol §9 Layer 1/§9b, conformance case 8)
// Reads JSON from stdin ({tool_name, tool_input}), denies via JSON permissionDecision.
// Configured via env: ORCH_GUARD_NET=off|on, ORCH_GUARD_ROOT=<worktree cwd>
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
  // resolve (removes ..), \ → /, strip trailing /, lowercase (Windows FS is case-insensitive)
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

  // net: off — pattern-level (not an OS guarantee; stated honestly in the spec)
  if (netOff && tool === 'Bash' && /\b(curl|wget|nc|netcat|ssh|scp|ftp)\b/.test(cmd)) {
    return deny(`network attempt blocked (net: off): ${cmd.slice(0, 120)}`);
  }
  if (tool === 'Bash' && /\bgit\s+push\b/.test(cmd)) {
    return deny('git push blocked — merge only via the orchestrator merge gate');
  }
  if (tool === 'Bash' && /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+\/(\s|$)/.test(cmd)) {
    return deny('rm -rf / blocked');
  }
  // path escape: file_path outside the worktree root (relative path → resolved against root)
  const outside = (p) => {
    const abs = norm(path.resolve(rawRoot, p));
    return abs !== root && !abs.startsWith(root + '/');
  };
  if (fp && root && outside(fp)) return deny(`write outside worktree blocked: ${fp}`);
  // codex: file edits = apply_patch envelope (tool_name Bash or apply_patch, inside command)
  if (root && cmd.includes('*** Begin Patch')) {
    for (const m of cmd.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
      const p = m[1].trim();
      if (outside(p)) return deny(`apply_patch write outside worktree blocked: ${p}`);
    }
  }
  process.exit(0);
});

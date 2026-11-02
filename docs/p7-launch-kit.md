# P7 Launch Kit — ready-to-run commands (needs your accounts)

> English only (canonical).

> Everything machine-doable is done. The 4 items below need your accounts/decisions —
> the commands are ready, copy and run. Status: repo **private** (safe default), npm **not logged in**.

---

## 1. Make the repo public — enables auto-updater for every user

```bash
gh repo edit datnp1003/Orchestra --visibility public --accept-visibility-change-consequences
```

After this command: electron-updater in the Desktop app **works for every user** (already wired,
Release v0.1.0 + `latest.yml` already published at
[releases/tag/v0.1.0](https://github.com/datnp1003/Orchestra/releases/tag/v0.1.0)).
If kept private, the updater only works on machines with `GH_TOKEN`.

## 2. npm publish — `orchestra-cli`

```bash
npm login                                   # your npm account (2FA required)
cd Orchestra/prototype
# edit package.json: name "orchestra-cli", add repository + license MIT
npm publish --access public
```

After publishing: users install with `npm i -g orchestra-cli`.
(Rename to `orchestra-cli` in prototype/package.json from "orchestra-prototype" — check the
name is free: `npm view orchestra-cli`.)

## 3. VS Code Marketplace — extension

```bash
# once: create a publisher at https://marketplace.visualstudio.com/manage
# create a Personal Access Token (Azure DevOps, scope Marketplace → Manage)
npx --yes @vscode/vsce login orchestra-dev    # paste the PAT
cd Orchestra/extension
npx --yes @vscode/vsce publish 0.2.4          # bump version + publish
```

128x128 icon: **✓ DONE** — `extension/resources/icon128.png` (generated in code, accent "O" ring)
wired into `package.json` (`"icon"` field) and into VSIX 0.2.4. Skip the icon step in §3.

## 4. Docs site

Content is ready: `docs/QUICKSTART.md` (15-minute onboarding) + 4 specs + roadmap.
2 hosting options:
- **GitHub Pages** (once the repo is public): Settings → Pages → branch `main` / `docs`
- Or keep README.md as the landing page (GitHub renders it already)

## 5. Beta (10–20 users, 2 weeks)

- Channels: repo Issues + weekly release (new tag + `gh release create`)
- Metrics already in the product: task records (`.orchestra/tasks/`), crash = exit!=0,
  cost/usage in each record — aggregate with: `node dist/cli.js stats <repo>`
- Beta exit gate: crash rate < 1/100 tasks + ≥1 user/day

## Awaiting your decision

| Item | Blocked by | Ready command |
|---|---|---|
| Repo public | your decision | §1 |
| npm publish | `npm login` | §2 |
| Marketplace | PAT + publisher (icon ✓ done) | §3 |
| macOS/Linux builds | other environment | `electron-builder -ml` (run on the matching machine) |
| Code signing | EV certificate (optional) | configure `win.certificateFile` |

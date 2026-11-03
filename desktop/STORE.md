# Microsoft Store build

Product: Orchestra Desktop (`9NGV7SDVNQGX`).
Package identity: `tNguyn.OrchestraDesktop`.
Publisher: `CN=EC19BE28-3DD8-47CF-9951-1CF43B3974C7`.

```sh
npm run build
./node_modules/.bin/electron-builder --config electron-builder.store.json --win appx --x64 --publish never
node test/store.test.mjs
```

The installed electron-builder 25 uses its AppX target and Windows MakeAppx to produce the `.msix` package. Partner Center package validation, installed-package runtime checks and certification remain separate gates. No signing certificate is embedded. Store signs the submission; an unsigned Store-identity package is not directly sideloadable.

`release-store/` is ignored. Store tile assets are in `build/appx/`. GitHub/NSIS packaging stays in `package.json`; Store runtime bypasses electron-updater using `process.windowsStore`.

## Verified draft upload

The x64 `0.3.1.0` package passed Partner Center package acceptance and is saved in Submission 1 (`1152921505702305569`). Acceptance reports a `runFullTrust` restricted-capability approval warning; this is not certification. Direct local installation with `Add-AppxPackage -AllowUnsigned` was rejected with `0x80073D2C` because the production publisher is not in the unsigned namespace. No certificate trust or security settings were changed.

## Pending verification

- Install a trusted signed package (or an explicitly authorized developer test package); launch and verify worker subprocesses, repo/worktree writes, router loopback, settings/session persistence and updater guards.
- Verify packaged application identity for taskbar/toasts and approval protocol activation.
- Complete Store listing, screenshots, privacy policy, pricing/availability and age rating before submitting for certification.

# P7 Launch Kit — lệnh sẵn chạy (cần tài khoản của bạn)

> Mọi thứ machine-doable đã xong. 4 mục dưới đây cần tài khoản/quyết định của bạn —
> lệnh đã chuẩn, copy-chạy. Trạng thái: repo **private** (mặc định an toàn), npm **chưa login**.

---

## 1. Repo public — bật auto-updater cho mọi user

```bash
gh repo edit datnp1003/Orchestra --visibility public --accept-visibility-change-consequences
```

Sau lệnh này: electron-updater trong Desktop app **hoạt động cho mọi user** (đã wired,
Release v0.1.0 + `latest.yml` đã publish tại
[releases/tag/v0.1.0](https://github.com/datnp1003/Orchestra/releases/tag/v0.1.0)).
Giữ private thì updater chỉ chạy trên máy có `GH_TOKEN`.

## 2. npm publish — `orchestra-cli`

```bash
npm login                                   # tài khoản npm của bạn (yêu cầu 2FA)
cd Orchestra/prototype
# sửa package.json: name "orchestra-cli", thêm repository + license MIT
npm publish --access public
```

Sau publish: người dùng cài bằng `npm i -g orchestra-cli`.
(Đổi tên `orchestra-cli` trong prototype/package.json từ "orchestra-prototype" — kiểm tra
tên trống: `npm view orchestra-cli`.)

## 3. VS Code Marketplace — extension

```bash
# 1 lần: tạo publisher tại https://marketplace.visualstudio.com/manage
# tạo Personal Access Token (Azure DevOps, scope Marketplace → Manage)
npx --yes @vscode/vsce login orchestra-dev    # dán PAT
cd Orchestra/extension
npx --yes @vscode/vsce publish 0.2.4          # bump version + publish
```

Icon 128x128 cần thêm trước khi publish (`--icon` trong package.json + `"icon"` field).

## 4. Docs site

Nội dung đã sẵn: `docs/QUICKSTART.md` (onboarding 15 phút) + 4 spec + roadmap.
2 lựa chọn host:
- **GitHub Pages** (sau khi repo public): Settings → Pages → branch `main` / `docs`
- Hoặc giữ README.md làm landing (GitHub hiển thị sẵn)

## 5. Beta (10–20 users, 2 tuần)

- Kênh: Issues của repo + weekly release (tag mới + `gh release create`)
- Metrics có sẵn trong sản phẩm: task records (`.orchestra/tasks/`), crash = exit!=0,
  cost/usage trong từng record — tổng hợp: `node dist/cli.js stats <repo>`
- Gate beta kết thúc: crash rate < 1/100 task + ≥1 user/ngày

## Trạng thái chờ quyết định của bạn

| Mục | Chặn bởi | Lệnh sẵn |
|---|---|---|
| Repo public | quyết định của bạn | §1 |
| npm publish | `npm login` | §2 |
| Marketplace | PAT + publisher | §3 |
| macOS/Linux builds | môi trường khác | `electron-builder -ml` (chạy trên máy tương ứng) |
| Code signing | chứng thư EV (tùy chọn) | cấu hình `win.certificateFile` |

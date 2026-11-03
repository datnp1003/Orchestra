// Orchestra Desktop — main process (P-D1)
import { app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wireIpc, wireTerminals, setupAutoUpdater, killAllTerminals, startOrchestraRouter, stopOrchestraRouter, respondApproval, cancelApprovals } from './ipc.js';
import { IPC, EVENTS } from './contract.js';
import { parseApprovalUrl, approvalToastXml, type ApprovalRequest } from './approvals.js';
import { initLanguage } from './settingsStore.js';
import { t, setLocale, detectLocale } from '../../../prototype/src/i18n/index.js';

// D1-fix: dùng app.getAppPath() — dev = desktop/, packaged = asar root (paths nhất quán 2 môi trường)
const appRoot = app.getAppPath();
const protoDir = app.isPackaged ? appRoot : path.join(appRoot, '..');
const settingsFile = path.join(app.getPath('userData'), 'orchestra-settings.json');

// icon từ file (PNG base64 cũ hỏng → nativeImage rỗng → tray/taskbar không có icon)
const ICON = nativeImage.createFromPath(path.join(appRoot, 'assets', 'icon.png'));
// tray 16px: bản đơn giản (chỉ nhạc trưởng) — icon đầy đủ bị nhoè ở cỡ này
const TRAY_ICON = nativeImage.createFromPath(path.join(appRoot, 'assets', 'tray.png'));
if (ICON.isEmpty()) console.error('[orchestra] assets/icon.png failed to load — tray icon will be missing');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // toast action Approve/Reject → orchestra://approval/<id>/<action> (Windows: instance mới → second-instance; macOS: open-url)
  if (process.defaultApp) app.setAsDefaultProtocolClient('orchestra', process.execPath, [path.resolve(process.argv[1] ?? '.')]);
  else app.setAsDefaultProtocolClient('orchestra');
  const showWin = (): void => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
  const handleUrl = (url: string): void => {
    const a = parseApprovalUrl(url);
    if (a) respondApproval(a.id, a.approve); // id lạ / đã trả lời → bỏ qua
  };
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((x) => x.startsWith('orchestra://'));
    if (url) handleUrl(url);
    else showWin();
  });
  app.on('open-url', (e, url) => {
    e.preventDefault();
    handleUrl(url);
  });
  const toasts = new Set<Notification>();
  // cửa sổ không focus → notification; click = mở Chat + focus card; Windows thử toast có nút Approve/Reject
  const notifyApproval = (r: ApprovalRequest): void => {
    if (!Notification.isSupported() || win?.isFocused()) return;
    const title = t('desktop.approval.title');
    let n: Notification;
    try {
      n = process.platform === 'win32' ? new Notification({ toastXml: approvalToastXml(r, title) }) : new Notification({ title, body: r.question.split('\n')[0] });
    } catch {
      n = new Notification({ title, body: r.question.split('\n')[0] });
    }
    toasts.add(n); // giữ tham chiếu — Notification bị GC thì mất handler click
    n.on('close', () => toasts.delete(n));
    n.on('click', () => {
      toasts.delete(n);
      if (!win) createWindow();
      showWin();
      win?.webContents.send(EVENTS.APPROVAL_FOCUS, r.id);
    });
    n.show();
  };

  const createWindow = (): void => {
    win = new BrowserWindow({
      width: 1360,
      height: 860,
      title: 'Orchestra Desktop',
      icon: ICON,
      // title bar + menu cùng nền tối của app (không dùng thanh tiêu đề/menu trắng mặc định của Windows)
      backgroundColor: '#0e0e11',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0e0e11', symbolColor: '#8f8f9a', height: 46 },
      webPreferences: {
        preload: path.join(appRoot, 'src', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // E2E: --page=chat mở thẳng page (router hash) — dùng cho screenshot gate
    const pageArg = process.argv.find((a) => a.startsWith('--page='));
    const hash = pageArg ? pageArg.split('=')[1] ?? '' : '';
    win.removeMenu(); // menu File/Edit/View mặc định không dùng tới
    win.loadFile(path.join(appRoot, 'src', 'renderer', 'index.html'), { hash: hash ? `/${hash}` : undefined });
    win.on('closed', () => {
      win = null;
      cancelApprovals(); // không còn chỗ trả lời → từ chối
    });
  };

  // gọi lại khi đổi ngôn ngữ (ipc onLocaleChange) — menu tray dựng tĩnh
  const buildTrayMenu = (): void => {
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: t('desktop.tray.open'), click: () => (win ? win.focus() : createWindow()) },
        { type: 'separator' },
        {
          label: t('desktop.tray.fleet'),
          click: () => {
            if (win) {
              win.focus();
              win.webContents.send('nav', 'dashboard');
            }
          },
        },
        { type: 'separator' },
        { label: t('desktop.tray.quit'), click: () => app.quit() },
      ]),
    );
  };
  const createTray = (): void => {
    tray = new Tray((TRAY_ICON.isEmpty() ? ICON : TRAY_ICON).resize({ width: 16, height: 16, quality: 'best' }));
    tray.setToolTip('Orchestra Desktop');
    buildTrayMenu();
    // click trái tray → focus/hiện cửa sổ
    tray.on('click', () => {
      if (win) win.focus();
      else createWindow();
    });
  };

  app.whenReady().then(async () => {
    // smoke settings sớm — fail nhanh nếu userData không ghi được; lần đầu: ngôn ngữ theo locale OS
    setLocale(initLanguage(settingsFile, detectLocale(app.getLocale())).language);
    // R2a: router trước IPC — chat/dispatch đầu tiên đã có router; lỗi (router.json hỏng…) không chặn app
    await startOrchestraRouter(settingsFile).catch((err) => console.error('[router] failed to start:', err));
    wireIpc(ipcMain, {
      win: () => win,
      settingsFile,
      notify: (title, body) => {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      },
      protoDir,
      onLocaleChange: buildTrayMenu,
      notifyApproval,
    });
    wireTerminals(ipcMain, {
      win: () => win,
      settingsFile,
      notify: (title, body) => {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      },
      protoDir,
    });
    setupAutoUpdater(
      () => win,
      (title, body) => {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      },
    );
    createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Desktop chạy nền theo tray — đóng cửa sổ KHÔNG thoát app (chuẩn messenger)
    // thoát qua tray menu → app.quit()
    if (process.platform !== 'darwin') {
      /* giữ app trong tray */
    }
  });

  app.on('before-quit', () => {
    killAllTerminals();
    void stopOrchestraRouter();
  });

  // export cho test nội bộ — IPC channel list hiển thị trong About
  void IPC;
}

// Orchestra Desktop — main process (P-D1)
import { app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wireIpc, wireTerminals, setupAutoUpdater, killAllTerminals, startOrchestraRouter, stopOrchestraRouter, respondApproval, cancelApprovals } from './ipc.js';
import { IPC, EVENTS } from './contract.js';
import { parseApprovalUrl, approvalToastXml, type ApprovalRequest } from './approvals.js';
import { initLanguage } from './settingsStore.js';
import { t, setLocale, detectLocale } from '../../../prototype/src/i18n/index.js';

// D1-fix: use app.getAppPath() — dev = desktop/, packaged = asar root (consistent paths in both)
const appRoot = app.getAppPath();
const protoDir = app.isPackaged ? appRoot : path.join(appRoot, '..');
const settingsFile = path.join(app.getPath('userData'), 'orchestra-settings.json');

// icon from file (old base64 PNG was broken → empty nativeImage → no tray/taskbar icon)
const ICON = nativeImage.createFromPath(path.join(appRoot, 'assets', 'icon.png'));
// tray 16px: simplified version (conductor only) — full icon blurs at this size
const TRAY_ICON = nativeImage.createFromPath(path.join(appRoot, 'assets', 'tray.png'));
if (ICON.isEmpty()) console.error('[orchestra] assets/icon.png failed to load — tray icon will be missing');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // toast action Approve/Reject → orchestra://approval/<id>/<action> (Windows: new instance → second-instance; macOS: open-url)
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
    if (a) respondApproval(a.id, a.approve); // unknown id / already answered → ignore
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
  // window unfocused → notification; click = open Chat + focus card; on Windows try a toast with Approve/Reject buttons
  const notifyApproval = (r: ApprovalRequest): void => {
    if (!Notification.isSupported() || win?.isFocused()) return;
    const title = t('desktop.approval.title');
    let n: Notification;
    try {
      n = process.platform === 'win32' ? new Notification({ toastXml: approvalToastXml(r, title) }) : new Notification({ title, body: r.question.split('\n')[0] });
    } catch {
      n = new Notification({ title, body: r.question.split('\n')[0] });
    }
    toasts.add(n); // keep a reference — a GC'd Notification loses its click handler
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
      // title bar + menu share the app's dark background (not Windows' default white title bar/menu)
      backgroundColor: '#0e0e11',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0e0e11', symbolColor: '#8f8f9a', height: 46 },
      webPreferences: {
        preload: path.join(appRoot, 'src', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // E2E: --page=chat opens the page directly (router hash) — used by the screenshot gate
    const pageArg = process.argv.find((a) => a.startsWith('--page='));
    const hash = pageArg ? pageArg.split('=')[1] ?? '' : '';
    win.removeMenu(); // default File/Edit/View menu is unused
    win.loadFile(path.join(appRoot, 'src', 'renderer', 'index.html'), { hash: hash ? `/${hash}` : undefined });
    win.on('closed', () => {
      win = null;
      cancelApprovals(); // nowhere left to answer → reject
    });
  };

  // called again on language change (ipc onLocaleChange) — tray menu is built statically
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
    // left-click tray → focus/show window
    tray.on('click', () => {
      if (win) win.focus();
      else createWindow();
    });
  };

  // Windows groups taskbar/toast/jump-list by AppUserModelID; must equal build.appId or toasts/pinning show "electron"
  if (process.platform === 'win32') app.setAppUserModelId('dev.orchestra.desktop');

  app.whenReady().then(async () => {
    // early settings smoke — fail fast if userData isn't writable; first run: language from OS locale
    setLocale(initLanguage(settingsFile, detectLocale(app.getLocale())).language);
    // R2a: router before IPC — first chat/dispatch already has a router; errors (broken router.json…) don't block the app
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
    // Desktop runs in the background via tray — closing the window does NOT quit (messenger-style)
    // quit via tray menu → app.quit()
    if (process.platform !== 'darwin') {
      /* keep app in tray */
    }
  });

  app.on('before-quit', () => {
    killAllTerminals();
    void stopOrchestraRouter();
  });

  // exported for internal tests — IPC channel list shown in About
  void IPC;
}

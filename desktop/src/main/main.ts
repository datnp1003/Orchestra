// Orchestra Desktop — main process (P-D1)
import { app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wireIpc, wireTerminals, setupAutoUpdater, killAllTerminals } from './ipc.js';
import { IPC } from './contract.js';
import { loadSettings } from './settingsStore.js';

// D1-fix: dùng app.getAppPath() — dev = desktop/, packaged = asar root (paths nhất quán 2 môi trường)
const appRoot = app.getAppPath();
const protoDir = app.isPackaged ? appRoot : path.join(appRoot, '..');
const settingsFile = path.join(app.getPath('userData'), 'orchestra-settings.json');

// icon từ file (PNG base64 cũ hỏng → nativeImage rỗng → tray/taskbar không có icon)
const ICON = nativeImage.createFromPath(path.join(appRoot, 'assets', 'icon.png'));
if (ICON.isEmpty()) console.error('[orchestra] assets/icon.png không load được — tray sẽ không hiện');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  const createWindow = (): void => {
    win = new BrowserWindow({
      width: 1360,
      height: 860,
      title: 'Orchestra Desktop',
      icon: ICON,
      webPreferences: {
        preload: path.join(appRoot, 'src', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // E2E: --page=chat mở thẳng page (router hash) — dùng cho screenshot gate
    const pageArg = process.argv.find((a) => a.startsWith('--page='));
    const hash = pageArg ? pageArg.split('=')[1] ?? '' : '';
    win.loadFile(path.join(appRoot, 'src', 'renderer', 'index.html'), { hash: hash ? `/${hash}` : undefined });
    win.on('closed', () => {
      win = null;
    });
  };

  const createTray = (): void => {
    tray = new Tray(ICON.resize({ width: 16, height: 16 }));
    tray.setToolTip('Orchestra Desktop');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Mở Orchestra', click: () => (win ? win.focus() : createWindow()) },
        { type: 'separator' },
        {
          label: 'Trạng thái Fleet',
          click: () => {
            if (win) {
              win.focus();
              win.webContents.send('nav', 'dashboard');
            }
          },
        },
        { type: 'separator' },
        { label: 'Thoát', click: () => app.quit() },
      ]),
    );
    // click trái tray → focus/hiện cửa sổ
    tray.on('click', () => {
      if (win) win.focus();
      else createWindow();
    });
  };

  app.whenReady().then(() => {
    // smoke settings sớm — fail nhanh nếu userData không ghi được
    loadSettings(settingsFile);
    wireIpc(ipcMain, {
      win: () => win,
      settingsFile,
      notify: (title, body) => {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      },
      protoDir,
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

  app.on('before-quit', () => killAllTerminals());

  // export cho test nội bộ — IPC channel list hiển thị trong About
  void IPC;
}

// Orchestra Desktop — main process (P-D1)
import { app, BrowserWindow, Tray, Menu, Notification, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wireIpc, wireTerminals, setupAutoUpdater, killAllTerminals } from './ipc.js';
import { IPC } from './contract.js';
import { loadSettings } from './settingsStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// out/desktop/src/main → lên 3 cấp = desktop/, lên 4 = Orchestra/
const desktopDir = path.resolve(__dirname, '..', '..', '..');
const protoDir = path.resolve(desktopDir, '..');
const settingsFile = path.join(app.getPath('userData'), 'orchestra-settings.json');

// icon 16x16 PNG sinh từ base64 tối giản — tránh phụ thuộc asset file
const ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR42mNk+M/wn4EIwESMolGx' +
    'iEYhRqNiEY1CjEYhRiMTYjQKIxoVSwBzCgD/3C0mCAAAAAElFTkSuQmCC',
  'base64',
);

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
      icon: nativeImage.createFromBuffer(ICON_PNG),
      webPreferences: {
        preload: path.join(desktopDir, 'src', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // E2E: --page=chat mở thẳng page (router hash) — dùng cho screenshot gate
    const pageArg = process.argv.find((a) => a.startsWith('--page='));
    const hash = pageArg ? pageArg.split('=')[1] ?? '' : '';
    win.loadFile(path.join(desktopDir, 'src', 'renderer', 'index.html'), { hash: hash ? `/${hash}` : undefined });
    win.on('closed', () => {
      win = null;
    });
  };

  const createTray = (): void => {
    tray = new Tray(nativeImage.createFromBuffer(ICON_PNG));
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
    wireIpc(app as unknown as Parameters<typeof wireIpc>[0], {
      win: () => win,
      settingsFile,
      notify: (title, body) => {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      },
      protoDir,
    });
    wireTerminals(app as unknown as Parameters<typeof wireIpc>[0], {
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

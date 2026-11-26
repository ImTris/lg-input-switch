'use strict';
const { app, BrowserWindow, ipcMain, Menu, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createMonitorService } = require('./monitor');

const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
let window;
let busy = false;
let switchingPbp = false;
let quitAfterSwitch = false;
const service = createMonitorService();

async function handle(event, operation) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) {
    throw new Error('Ongeldige aanroep.');
  }
  if (busy) throw new Error('De monitor wordt nog uitgelezen. Probeer het zo opnieuw.');
  busy = true;
  try { return await operation(); } finally { busy = false; }
}

function createWindow() {
  window = new BrowserWindow({
    width: 490, height: 750, minWidth: 420, minHeight: 650,
    title: 'LG Input Switch', backgroundColor: '#f7f7f2',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('closed', () => { window = null; });
  window.loadFile(path.join(__dirname, 'index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    ipcMain.handle('monitor:list', event => handle(event, () => service.list()));
    ipcMain.handle('monitor:switch', (event, request) => handle(event, async () => {
      switchingPbp = request?.mode === 'pbp';
      try { return await service.switchInput(request); }
      finally {
        switchingPbp = false;
        if (quitAfterSwitch) app.quit();
      }
    }));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' }, { role: 'windowMenu' },
    ]));
    createWindow();
  });
  app.on('activate', () => { if (!window) createWindow(); });
  // Complete the two-step transition (or its recovery) if Quit is pressed mid-PBP.
  app.on('before-quit', event => {
    if (switchingPbp) { event.preventDefault(); quitAfterSwitch = true; }
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

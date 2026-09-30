'use strict';

/**
 * 主进程入口。
 * - 单实例运行；启动即进入设置界面
 * - 所有网络请求都在主进程发出（不受 CORS 限制），渲染进程只通过 IPC 调用
 * - 演示模式由 DemoLock 统一控制全屏与快捷键封锁
 */

const path = require('path');
const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');

const configStore = require('./config-store.js');
const llm = require('./llm-client.js');
const gomoku = require('./gomoku-service.js');
const localEngine = require('./local-engine.js');
const { DemoLock } = require('./kiosk.js');
const boards = require('../shared/boards.js');
const rules = require('../shared/gomoku-rules.js');
const prompts = require('../shared/default-prompts.js');

// ---------------------------------------------------------------------------
// Windows 7/8/8.1 兼容：老显卡驱动在 GPU 合成下容易白屏，直接走软件渲染
// ---------------------------------------------------------------------------
function isLegacyWindows() {
  try {
    const v = process.getSystemVersion() || '';
    return /^6\.1/.test(v) || /^6\.2/.test(v) || /^6\.3/.test(v);
  } catch (_) {
    return false;
  }
}
if (isLegacyWindows()) {
  try { app.disableHardwareAcceleration(); } catch (_) { /* ignore */ }
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-direct-composition');
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
}

let mainWindow = null;
let lock = null;
const activeRequests = new Map();
const isDev = !app.isPackaged || process.argv.includes('--dev');

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0a0e14',
    title: '技术演示台',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 只在开发/显式 --dev 时允许打开 DevTools：
      // 产物里开着 DevTools 会让演示现场的人直接读到设置页的 API Key
      devTools: isDev,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const isSmokeTest = process.env.DEMO_SMOKE === '1';
  mainWindow.once('ready-to-show', () => {
    if (!isSmokeTest) mainWindow.show();
    if (isDev && !isSmokeTest) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // 演示锁生效时，任何关闭动作都不允许
  mainWindow.on('close', (event) => {
    if (lock && lock.locked) {
      event.preventDefault();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  mainWindow.on('minimize', (event) => {
    if (lock && lock.locked) {
      event.preventDefault();
      mainWindow.restore();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // 不允许新开窗口 / 导航到外部地址
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  // 演示场景下禁用右键菜单
  mainWindow.webContents.on('context-menu', (event) => {
    if (lock && lock.locked) event.preventDefault();
  });

  lock = new DemoLock(mainWindow);
  lock.onExit((reason) => {
    send('demo:exited', { reason });
  });
  // 把暗码输入进度推给界面（只发进度长度，不发内容）
  lock.onKeyHint((length, total, extra) => {
    send('demo:key-progress', { length, total, wrong: !!(extra && extra.wrong) });
  });

  mainWindow.on('blur', () => {
    if (lock && lock.locked) {
      setTimeout(() => {
        if (lock && lock.locked && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.focus();
          mainWindow.moveTop();
        }
      }, 120);
    }
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('app:info', () => {
    const cfg = configStore.load();
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      windowsVersion: process.getSystemVersion(),
      configPath: configStore.configPath(),
      packaged: app.isPackaged,
      boards: boards.list(),
      defaultBoardId: cfg.ui.lastBoard,
      locked: !!(lock && lock.locked),
      exitCodeLength: String(cfg.demo.exitCode).length,
      showLockHint: cfg.demo.showLockHint,
      encryptionAvailable: (() => {
        try {
          const { safeStorage } = require('electron');
          return safeStorage.isEncryptionAvailable();
        } catch (_) { return false; }
      })()
    };
  });

  ipcMain.handle('config:get', () => configStore.load());

  ipcMain.handle('config:save', (event, patch) => {
    const cfg = configStore.save(patch || {});
    return { ok: true, config: cfg };
  });

  ipcMain.handle('config:defaults', () => ({
    defaults: configStore.DEFAULTS,
    systemPrompt: prompts.DEFAULT_SYSTEM_PROMPT
  }));

  ipcMain.handle('llm:test', async (event, payload) => {
    const cfg = configStore.load();
    const baseUrl = (payload && payload.baseUrl) || cfg.api.baseUrl;
    const apiKey = payload && payload.apiKey !== undefined ? payload.apiKey : cfg.api.apiKey;
    const model = (payload && payload.model) || cfg.black.model;
    return llm.testConnection({ baseUrl, apiKey, model });
  });

  ipcMain.handle('llm:models', async (event, payload) => {
    const cfg = configStore.load();
    const baseUrl = (payload && payload.baseUrl) || cfg.api.baseUrl;
    const apiKey = payload && payload.apiKey !== undefined ? payload.apiKey : cfg.api.apiKey;
    try {
      const models = await llm.listModels({ baseUrl, apiKey, timeoutMs: 20000 });
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  // ---- 演示模式 -----------------------------------------------------------
  ipcMain.handle('demo:start', (event, boardId) => {
    const cfg = configStore.load();
    const board = boards.get(boardId) || boards.get('gomoku');
    if (!board) return { ok: false, error: '未知板块：' + boardId };
    const lockInfo = lock.enter({ exitCode: cfg.demo.exitCode });
    configStore.save({ ui: { lastBoard: board.id } });
    send('demo:started', {
      boardId: board.id,
      exitCodeLength: String(cfg.demo.exitCode).length,
      showLockHint: cfg.demo.showLockHint
    });
    return { ok: true, boardId: board.id, lock: lockInfo };
  });

  ipcMain.handle('demo:exit', () => {
    if (lock && lock.locked) {
      return { ok: false, error: '演示模式已锁定：请输入退出暗码解除。' };
    }
    return { ok: true, already: true };
  });

  ipcMain.handle('demo:state', () => ({
    locked: !!(lock && lock.locked),
    bufferLength: lock ? lock.buffer.length : 0
  }));

  // ---- 五子棋 -------------------------------------------------------------
  ipcMain.handle('gomoku:move', async (event, payload) => {
    const requestId = (payload && payload.requestId) || String(Date.now());
    const cancelToken = new llm.CancelToken();
    activeRequests.set(requestId, cancelToken);
    const onDelta = (delta) => send('gomoku:delta', Object.assign({ requestId }, delta));
    try {
      const result = await gomoku.requestMove(payload || {}, { onDelta, cancelToken });
      return Object.assign({ ok: true, requestId }, result);
    } catch (err) {
      const cancelled = !!(err && (err.code === 'CANCELLED' || cancelToken.cancelled));
      return {
        ok: false,
        cancelled,
        requestId,
        error: err && err.message ? err.message : String(err),
        code: (err && err.code) || 'ERROR',
        attempts: err && err.attempts,
        elapsedMs: err && err.elapsedMs,
        reasoning: err && err.reasoning,
        raw: err && err.raw
      };
    } finally {
      activeRequests.delete(requestId);
    }
  });

  ipcMain.on('gomoku:cancel', (event, requestId) => {
    const token = activeRequests.get(requestId);
    if (token) token.cancel('用户暂停/中断了本步思考');
    if (!requestId) {
      for (const t of activeRequests.values()) t.cancel('用户中断了思考');
    }
  });

  ipcMain.handle('game:board-text', (event, board) => rules.boardToText(rules.normalizeBoard(board)));

  // ---- 本地引擎自检（不联网也能验证界面） ---------------------------------
  ipcMain.handle('local:think', (event, payload) => {
    const board = rules.normalizeBoard(payload && payload.board);
    const side = payload && payload.side === rules.WHITE ? rules.WHITE : rules.BLACK;
    const cfg = configStore.load();
    const result = localEngine.think(board, side, { level: (payload && payload.level) || cfg.local.level });
    return { ok: true, move: result.move, reasoning: result.reasoning, meta: result.meta };
  });

  // ---- 其它 ---------------------------------------------------------------
  ipcMain.handle('shell:openExternal', (event, url) => {
    if (/^https?:\/\//i.test(String(url || ''))) {
      shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false, error: '只允许打开 http(s) 链接' };
  });

  ipcMain.handle('app:quit', () => {
    if (lock && lock.locked) return { ok: false, error: '演示模式已锁定' };
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('app:showConfig', () => {
    shell.showItemInFolder(configStore.configPath());
    return { ok: true, path: configStore.configPath() };
  });

  ipcMain.on('renderer:error', (event, info) => {
    console.error('[renderer]', info && info.message, info && info.stack);
  });
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('before-quit', (event) => {
  if (lock && lock.locked) {
    event.preventDefault();
    send('demo:blocked-action', { action: 'quit', message: '演示模式已锁定：请输入退出暗码解除后再退出程序。' });
    return;
  }
  try { require('electron').globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ---------------------------------------------------------------------------
// 纵深防御：任何新建的 webContents（未来可能出现的 WebView / 新窗口）
// 一律禁止开新窗口，禁止导航到 file:// 之外的地址；外链交给系统浏览器。
// 主窗口自身在上面注册了同样的规则，这里只兜住其余内容。
// ---------------------------------------------------------------------------
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '程序内部错误',
        message: String(err && err.message || err),
        detail: String(err && err.stack || '').slice(0, 1500)
      });
    }
  } catch (_) { /* ignore */ }
});

'use strict';

/**
 * 演示模式锁定（Windows 桌面演示用）：
 * - 进入后 Kiosk 全屏、置顶、隐藏任务栏图标、禁用右键菜单与开发者工具
 * - 尽最大可能抢占并屏蔽系统快捷键（globalShortcut + before-input-event 双层）
 * - 关闭/最小化/失焦均被拦截；只有在窗口内连续键入暗码（默认 114514）才解除锁定
 *
 * 无法屏蔽（任何用户态程序都做不到）：Ctrl+Alt+Del、Win+L（安全注意序列）、
 * 部分显卡/输入法自带的驱动级热键。
 */

const { globalShortcut, Menu } = require('electron');

const SYSTEM_SHORTCUTS = [
  // 刷新 / 开发者工具 / 全屏切换
  'F5', 'CommandOrControl+R', 'CommandOrControl+Shift+R', 'F11', 'F12',
  'CommandOrControl+Shift+I', 'CommandOrControl+Shift+J', 'CommandOrControl+Shift+C',
  // 窗口与标签
  'CommandOrControl+W', 'CommandOrControl+N', 'CommandOrControl+T', 'CommandOrControl+Q',
  'CommandOrControl+P', 'CommandOrControl+S', 'CommandOrControl+O', 'CommandOrControl+U',
  'CommandOrControl+Shift+W', 'CommandOrControl+Shift+T', 'CommandOrControl+Shift+N',
  // 系统级
  'Alt+F4', 'Alt+Tab', 'Alt+Shift+Tab', 'Alt+Esc', 'Control+Esc', 'Control+Shift+Esc',
  'CommandOrControl+Esc', 'Super', 'Meta', 'PrintScreen', 'CommandOrControl+Shift+Escape',
  'CommandOrControl+Alt+Delete', 'CommandOrControl+Shift+Delete'
];

const INPUT_BLOCK_KEYS = [
  'F5', 'F11', 'F12', 'F1', 'F3', 'F7',
  'Escape', 'Tab',
  'NumLock', 'PrintScreen', 'Insert'
];

class DemoLock {
  constructor(win) {
    this.win = win;
    this.locked = false;
    this.buffer = '';
    this.exitCode = '114514';
    this.shortcutFailures = [];
    this.registered = [];
    this._lastKey = { key: '', at: 0, source: '' };
    this._focusTimer = null;
    this._onExit = null;
    this._onKeyHint = null;
    this._inputHandler = null;
  }

  onExit(fn) { this._onExit = fn; }
  onKeyHint(fn) { this._onKeyHint = fn; }

  /**
   * 双层按键缓冲：globalShortcut 与 before-input-event 都会投递同一次按键，
   * 因此要按「来源」去重——同一来源的连击（人手连续按同一个键，间隔通常 >30ms）
   * 必须放行，否则 114514 这类含连续相同数字的暗码永远输不进去。
   */
  _pushKey(key, source) {
    if (!this.locked) return;
    const now = Date.now();
    const src = source || 'input';
    if (this._lastKey.key === key) {
      const sameSource = this._lastKey.source === src && now - this._lastKey.at < 25;   // 输入法/按键自动重复
      const crossSource = this._lastKey.source !== src && now - this._lastKey.at < 80;  // 同一次按键被两个通道投递
      if (sameSource || crossSource) return;
    }
    this._lastKey = { key, at: now, source: src };
    if (!/^[0-9A-Za-z]$/.test(key)) return;
    const candidate = (this.buffer + key).slice(-this.exitCode.length);
    // 输错时给出提示：新序列不是暗码的前缀，则本次尝试作废
    if (this.exitCode.indexOf(candidate) !== 0) {
      const hadProgress = this.buffer.length > 0;
      this.buffer = key === this.exitCode[0] ? key : '';
      if (hadProgress && this._onKeyHint) this._onKeyHint(this.buffer.length, this.exitCode.length, { wrong: true });
      return;
    }
    this.buffer = candidate;
    if (this._onKeyHint) this._onKeyHint(this.buffer.length, this.exitCode.length, { wrong: false });
    if (this.buffer === this.exitCode) {
      this.buffer = '';
      this.exit('暗码校验通过');
    }
  }

  enter(options) {
    if (this.locked) return { ok: true, already: true };
    const opts = options || {};
    this.exitCode = String(opts.exitCode || '114514');
    this.buffer = '';
    this._lastKey = { key: '', at: 0, source: '' };
    this.shortcutFailures = [];
    this.registered = [];

    Menu.setApplicationMenu(null);
    this.locked = true;

    const win = this.win;
    try {
      win.setKiosk(true);
    } catch (err) {
      console.error('[lock] setKiosk 失败：', err && err.message);
      try { win.setFullScreen(true); } catch (_) { /* ignore */ }
    }
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (_) { /* ignore */ }
    try { win.setSkipTaskbar(true); } catch (_) { /* ignore */ }
    try { win.setClosable(false); } catch (_) { /* ignore */ }
    try { win.setMinimizable(false); } catch (_) { /* ignore */ }
    try { win.focus(); } catch (_) { /* ignore */ }

    const accelerators = SYSTEM_SHORTCUTS.concat(opts.alsoBlockDigits === false ? [] : ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    for (const acc of accelerators) {
      try {
        const ok = globalShortcut.register(acc, () => {
          if (/^[0-9]$/.test(acc)) this._pushKey(acc, 'global');
        });
        if (ok) this.registered.push(acc);
        else this.shortcutFailures.push(acc);
      } catch (err) {
        this.shortcutFailures.push(acc);
      }
    }

    this._inputHandler = (event, input) => {
      if (!this.locked) return;
      if (input.type !== 'keyDown') return;
      const key = input.key;
      if (/^[0-9A-Za-z]$/.test(key)) this._pushKey(key, 'input');
      const blocked = INPUT_BLOCK_KEYS.indexOf(key) >= 0;
      const withModifier = !!(input.control || input.meta) && /^[a-zA-Z]$/.test(key);
      if (blocked || withModifier || key === 'F4' && input.alt) {
        event.preventDefault();
      }
    };
    win.webContents.on('before-input-event', this._inputHandler);

    // 失焦/最小化立刻抢回焦点（Kiosk 演示场景下的正当行为）
    this._focusTimer = setInterval(() => {
      if (!this.locked) return;
      try {
        if (win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        if (!win.isFocused()) {
          win.show();
          win.focus();
          win.moveTop();
        }
      } catch (_) { /* ignore */ }
    }, 1200);

    return {
      ok: true,
      exitCodeLength: this.exitCode.length,
      blocked: this.registered.slice(),
      failures: this.shortcutFailures.slice()
    };
  }

  exit(reason) {
    if (!this.locked) return false;
    this.locked = false;
    const win = this.win;

    if (this._focusTimer) {
      clearInterval(this._focusTimer);
      this._focusTimer = null;
    }
    if (this._inputHandler && win && !win.isDestroyed()) {
      try { win.webContents.removeListener('before-input-event', this._inputHandler); } catch (_) { /* ignore */ }
    }
    this._inputHandler = null;

    try { globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }

    if (win && !win.isDestroyed()) {
      try { win.setKiosk(false); } catch (_) { /* ignore */ }
      try { win.setFullScreen(false); } catch (_) { /* ignore */ }
      try { win.setAlwaysOnTop(false); } catch (_) { /* ignore */ }
      try { win.setSkipTaskbar(false); } catch (_) { /* ignore */ }
      try { win.setClosable(true); } catch (_) { /* ignore */ }
      try { win.setMinimizable(true); } catch (_) { /* ignore */ }
      try { win.show(); } catch (_) { /* ignore */ }
      try { win.focus(); } catch (_) { /* ignore */ }
    }

    if (this._onExit) this._onExit(reason || '已退出演示模式');
    return true;
  }
}

module.exports = { DemoLock, SYSTEM_SHORTCUTS };

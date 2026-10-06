'use strict';

/**
 * Electron 端到端冒烟测试：
 *   npx electron tools/smoke-electron.js
 *
 * 三阶段：
 *   A. 真实窗口（隐藏）+ 真实 IPC：设置界面渲染、配置读写、本地引擎、五子棋自对弈、控件交互
 *   B. 演示锁定端到端：demo:start 进入 Kiosk → 错误暗码不退出 → 正确暗码退出
 *   C. DemoLock 单元校验：缓冲滑动、去重、进度回调、exit 清理
 *
 * 注意：阶段 B 会短暂进入全屏置顶（约 3~6 秒）并临时占用若干全局快捷键，
 * 结束时（含异常与超时）一定会 app.exit()，从而释放所有全局快捷键。
 */

process.env.DEMO_SMOKE = '1';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const TRACE_FILE = path.join(__dirname, '..', 'smoke-trace.log');
const RESULT_FILE = path.join(__dirname, '..', 'smoke-result.json');
const SHOT_DIR = path.join(__dirname, '..', 'shots');
async function capture(win, name) {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    // 隐藏/非激活窗口下合成器可能交出上一帧，先强制重绘再截
    try { win.webContents.invalidate(); } catch (_) { /* ignore */ }
    await wait(350);
    const image = await win.webContents.capturePage();
    const file = path.join(SHOT_DIR, name + '.png');
    fs.writeFileSync(file, image.toPNG());
    console.log('[shot] ' + file);
    return file;
  } catch (err) {
    console.log('[shot] 失败：' + err.message);
    return null;
  }
}
try { fs.writeFileSync(TRACE_FILE, '[boot] ' + new Date().toISOString() + '\n'); } catch (_) { /* ignore */ }
function trace(msg) {
  try { fs.appendFileSync(TRACE_FILE, msg + '\n'); } catch (_) { /* ignore */ }
  console.log(msg);
}

// 被测应用根目录：默认源码目录；设置 SMOKE_APP_ROOT 可指向已打包的 asar，
// 例如 SMOKE_APP_ROOT=dist/win-unpacked/resources/app.asar/src
const APP_ROOT = process.env.SMOKE_APP_ROOT
  ? path.resolve(process.env.SMOKE_APP_ROOT)
  : path.join(__dirname, '..', 'src');
function appRequire(rel) { return require(path.join(APP_ROOT, rel)); }

const results = { phaseA: null, phaseB: null, phaseC: null, errors: [] };

// 看门狗：无论发生什么，最多 300 秒后强制退出（释放全局快捷键）
const watchdog = setTimeout(() => {
  results.errors.push('看门狗触发：测试超时，强制退出');
  finish(90);
}, 300000);

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  results.ok = code === 0 && results.errors.length === 0;
  const payload = JSON.stringify(results, null, 2);
  try { fs.writeFileSync(RESULT_FILE, payload, 'utf8'); } catch (_) { /* ignore */ }
  console.log('\n===SMOKE-RESULT===');
  console.log(payload);
  console.log('===END-SMOKE-RESULT===');
  trace('[finish] code=' + code);
  app.exit(code);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ------------------------------------------------------------------ 阶段 A
const PHASE_A_SCRIPT = `(async () => {
  const out = {};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  out.apiExposed = typeof window.demoAPI === 'object' && typeof window.demoAPI.gomoku.move === 'function';
  out.globals = {
    rules: typeof window.GomokuRules, boards: typeof window.DemoBoards, prompts: typeof window.GomokuPrompts,
    ui: typeof window.UI, game: typeof window.GomokuGame, renderer: typeof window.BoardRenderer,
    settings: typeof window.Settings, view: typeof window.DemoView
  };
  out.rulesSize = window.GomokuRules.SIZE;
  // 安全：CSP 已生效（meta 存在 + connect-src 'none' 真的拦住了渲染层网络请求）
  const cspEl = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  out.cspMeta = cspEl ? cspEl.getAttribute('content') : null;
  out.cspViolation = await new Promise((resolve) => {
    function onV(e) {
      clearTimeout(timer);
      document.removeEventListener('securitypolicyviolation', onV);
      resolve(String(e.violatedDirective || e.effectiveDirective || '') + '|' + String(e.blockedURI || ''));
    }
    const timer = setTimeout(() => {
      document.removeEventListener('securitypolicyviolation', onV);
      resolve('NONE');
    }, 900);
    document.addEventListener('securitypolicyviolation', onV);
    // .invalid 顶级域名保证无法解析：即使 CSP 没生效也不会产生真实外网流量
    fetch('https://csp-probe.invalid/v1/models').catch(() => {});
  });
  out.boardCards = document.querySelectorAll('#board-list .board-card').length;
  out.boardButtons = document.querySelectorAll('#board-list .board-card .board-actions button').length;

  // 设置界面：写入 → 保存 → 读回
  document.getElementById('api-base-url').value = 'https://api.deepseek.com';
  document.getElementById('api-key').value = 'sk-smoke-test-key';
  document.getElementById('black-engine').value = 'local';
  document.getElementById('white-engine').value = 'local';
  document.getElementById('white-model').value = 'deepseek-reasoner';   // 旧模型名，保存后应迁移
  document.getElementById('black-effort').value = 'low';                // 新增档位
  document.getElementById('demo-exit-code').value = '114514';
  document.getElementById('demo-step-delay').value = '0';
  document.getElementById('move-attempts').value = '2';
  ['api-base-url','api-key','black-engine','white-engine','white-model','black-effort','demo-exit-code','demo-step-delay','move-attempts']
    .forEach(id => document.getElementById(id).dispatchEvent(new Event('input', { bubbles: true })));
  document.getElementById('black-effort').dispatchEvent(new Event('change', { bubbles: true }));

  document.getElementById('btn-save').click();
  await sleep(600);
  out.saveState = document.getElementById('save-state').textContent;
  const cfgRead = await window.demoAPI.config.get();
  out.savedKey = cfgRead.api.apiKey;
  out.savedWhiteEngine = cfgRead.white.engine;
  out.savedAttempts = cfgRead.move.maxAttempts;
  out.savedWhiteModel = cfgRead.white.model;
  out.legacyModelMigrated = cfgRead.white.model === 'deepseek-flash';
  out.savedBlackEffort = cfgRead.black.reasoningEffort;
  out.lowEffortSaved = cfgRead.black.reasoningEffort === 'low';

  // 系统信息 / 板块列表
  const appInfo = await window.demoAPI.app.info();
  out.electron = appInfo.electron;
  out.chrome = appInfo.chrome;
  out.exitCodeLength = appInfo.exitCodeLength;
  out.configPathTail = appInfo.configPath.split(/[\\\\/]/).pop();

  // ---- 修复项校验：模型下拉、思考档位、本地引擎字段显隐、顶部大标题
  out.comboMenus = document.querySelectorAll('#black-model-menu, #white-model-menu').length;
  out.datalistGone = document.getElementById('model-datalist') === null;
  out.blackEffortOptions = Array.from(document.getElementById('black-effort').options).map(o => o.value).join(',');
  out.whiteEffortOptions = Array.from(document.getElementById('white-effort').options).map(o => o.value).join(',');
  out.headlineText = (document.querySelector('#view-demo .demo-headline h1') || {}).textContent;
  out.headlineCount = document.querySelectorAll('.demo-headline h1').length;
  out.headlineFontSize = parseFloat(getComputedStyle(document.querySelector('#view-demo .demo-headline h1')).fontSize) || 0;

  // 本地引擎：模型与思考档位必须被隐藏
  document.getElementById('black-engine').value = 'local';
  document.getElementById('black-engine').dispatchEvent(new Event('change', { bubbles: true }));
  out.localFieldsHidden = document.getElementById('black-ai-fields').classList.contains('hidden');
  out.localNoteShown = !document.getElementById('black-local-note').classList.contains('hidden');
  document.getElementById('black-engine').value = 'api';
  document.getElementById('black-engine').dispatchEvent(new Event('change', { bubbles: true }));
  out.apiFieldsShown = !document.getElementById('black-ai-fields').classList.contains('hidden');
  out.apiNoteHidden = document.getElementById('black-local-note').classList.contains('hidden');

  // 自绘下拉：点箭头出菜单、点候选项写回输入框
  document.getElementById('black-model-arrow').click();
  out.comboOpen = document.getElementById('black-model-menu').classList.contains('show');
  out.comboItems = document.querySelectorAll('#black-model-menu .combo-item').length;
  const firstItem = document.querySelector('#black-model-menu .combo-item');
  const firstId = firstItem ? firstItem.querySelector('span').textContent : '';
  if (firstItem) firstItem.click();
  out.comboPicked = document.getElementById('black-model').value;
  out.comboPickedMatches = out.comboPicked === firstId;
  out.comboClosedAfterPick = !document.getElementById('black-model-menu').classList.contains('show');

  // IPC：棋盘文本 + 本地引擎
  const empty = window.GomokuRules.createBoard();
  const text = await window.demoAPI.gomoku.boardText(empty);
  out.boardTextLines = String(text).split('\\n').length;
  const lt = await window.demoAPI.local.think({ board: empty, side: 1, level: 1 });
  out.localThink = !!(lt && lt.ok && Array.isArray(lt.move));
  out.localMove = lt && lt.move;

  // 棋局逻辑（纯渲染层）
  const g = window.GomokuGame.create();
  const seq = [[7,3],[0,0],[7,4],[0,1],[7,5],[0,2],[7,6],[0,3]];
  seq.forEach(mv => g.place(mv, { engine: 'human' }));
  const fin = g.place([7,7], { engine: 'human' });
  out.winner = g.winner && g.winner.side;
  out.winLineLength = g.winner ? g.winner.line.length : 0;
  out.historyLength = g.history.length;
  out.finalPlaceOk = !!fin.ok;
  const afterOver = g.place([1,1], {});
  out.rejectsAfterOver = afterOver.ok === false;
  g.undo();
  out.afterUndoWinner = g.winner;

  // 演示视图（不经过 demo:start，因此不进入 Kiosk）
  await window.DemoView.start('gomoku');
  out.demoActive = document.getElementById('view-demo').classList.contains('active');
  out.canvasWidth = document.getElementById('gomoku-canvas').width;
  out.lockDots = document.querySelectorAll('#lock-keys i').length;
  await sleep(6000);
  out.movesPlayed = document.querySelectorAll('#demo-moves .move-tag').length;
  out.blackReasoningLen = document.getElementById('black-reasoning').textContent.length;
  out.whiteReasoningLen = document.getElementById('white-reasoning').textContent.length;
  out.phaseText = document.getElementById('demo-phase').textContent;
  out.errorShown = document.getElementById('demo-error').classList.contains('show');
  out.errorText = document.getElementById('demo-error-text').textContent;
  out.bannerShown = document.getElementById('board-banner').classList.contains('show');

  // 控件：暂停 / 悔一步（暂停态下测，避免 AI 立刻补一手）/ 手数 / 继续 / 重新开始
  document.getElementById('btn-demo-pause').click();
  out.pauseLabel = document.getElementById('btn-demo-pause').textContent;
  await sleep(600);
  const beforeUndo = document.querySelectorAll('#demo-moves .move-tag').length;
  document.getElementById('btn-demo-undo').click();
  await sleep(250);
  const afterUndo = document.querySelectorAll('#demo-moves .move-tag').length;
  out.beforeUndo = beforeUndo;
  out.afterUndo = afterUndo;
  out.undoDelta = beforeUndo - afterUndo;
  document.getElementById('btn-demo-numbers').click();
  out.numbersLabel = document.getElementById('btn-demo-numbers').textContent;
  document.getElementById('btn-demo-pause').click();
  out.resumeLabel = document.getElementById('btn-demo-pause').textContent;
  document.getElementById('btn-demo-restart').click();
  await sleep(2500);
  out.movesAfterRestart = document.querySelectorAll('#demo-moves .move-tag').length;

  // ---- 手数多了之后底部不应被顶起来（滚动容器）+ 人机对战接管
  const movesBox = document.getElementById('demo-moves');
  out.movesOverflowX = getComputedStyle(movesBox).overflowX;
  out.movesNoWrap = getComputedStyle(movesBox).flexWrap;
  out.footerHeight = Math.round(document.querySelector('.demo-footer').getBoundingClientRect().height);

  // 画布坐标 → 交叉点像素坐标（与 board-renderer 的几何一致）
  const canvas = document.getElementById('gomoku-canvas');
  const cvSize = canvas.width;
  const cvMargin = Math.round(cvSize * 0.062);
  const cvCell = (cvSize - cvMargin * 2) / 14;
  function clickCell(row, col) {
    const rect = canvas.getBoundingClientRect();
    const cx = cvMargin + col * cvCell;
    const cy = cvMargin + row * cvCell;
    canvas.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true,
      clientX: rect.left + (cx / cvSize) * rect.width,
      clientY: rect.top + (cy / cvSize) * rect.height
    }));
  }

  out.manualLabelBefore = document.getElementById('btn-demo-manual').textContent;
  out.challengeInBoardArea = document.getElementById('btn-demo-manual').parentNode.id === 'board-area';
  out.challengeFontSize = parseFloat(getComputedStyle(document.getElementById('btn-demo-manual')).fontSize) || 0;
  out.challengeBelowCanvas = (() => {
    const b = document.getElementById('btn-demo-manual').getBoundingClientRect();
    const c = document.getElementById('gomoku-canvas').getBoundingClientRect();
    return b.top >= c.bottom - 2 && b.width >= 180;
  })();
  document.getElementById('btn-demo-manual').click();   // 接管一方（优先接管本地引擎一方）
  await sleep(200);
  out.manualLabelAfter = document.getElementById('btn-demo-manual').textContent;
  out.manualHint = document.getElementById('board-hint').textContent;
  out.manualBadges = document.getElementById('black-engine-badge').textContent + ' | ' + document.getElementById('white-engine-badge').textContent;
  // 等 AI 先手落子、回合真正交到人手里（最多 20s），再暂停冻结对局做人工落子
  let waitHuman = 0;
  for (; waitHuman < 80; waitHuman++) {
    const st = document.getElementById('black-panel-state').textContent + document.getElementById('white-panel-state').textContent;
    if (st.indexOf('等你落子') >= 0) break;
    await sleep(250);
  }
  out.humanTurnFirst = waitHuman < 80;
  document.getElementById('btn-demo-pause').click();   // 暂停，保证人工落子确定性
  await sleep(300);
  const candidates = [[0, 0], [0, 14], [14, 0], [14, 14], [0, 7], [7, 0], [7, 14], [14, 7], [3, 3], [11, 11]];
  out.humanPlaced = 0;
  out.humanCell = '';
  for (const mv of candidates) {
    const before = document.querySelectorAll('#demo-moves .move-tag').length;
    clickCell(mv[0], mv[1]);
    await sleep(80);
    const after = document.querySelectorAll('#demo-moves .move-tag').length;
    if (after > before) { out.humanPlaced = 1; out.humanCell = mv[0] + ',' + mv[1]; break; }
  }
  out.humanReasoningShown = (document.getElementById('white-reasoning').textContent + document.getElementById('black-reasoning').textContent).indexOf('人机对战') >= 0;
  document.getElementById('btn-demo-manual').click();   // 交还引擎
  await sleep(200);
  out.manualLabelBack = document.getElementById('btn-demo-manual').textContent;
  out.badgeRestored = document.getElementById('white-engine-badge').textContent + ' | ' + document.getElementById('black-engine-badge').textContent;
  document.getElementById('btn-demo-pause').click();    // 恢复运行
  await sleep(200);

  // 回归：人机对战中「人落子后 AI 必须自动接着走」（不能停在等对方落子）
  // 先重开一局：棋局只有几手，排除「上一局刚好被 AI 下到分胜负」这种时序偶然
  document.getElementById('btn-demo-restart').click();
  await sleep(600);
  document.getElementById('btn-demo-manual').click();   // 重新接管
  out.timeline = [];
  const snap = (tag) => out.timeline.push(tag + '|' + document.querySelectorAll('#demo-moves .move-tag').length
    + '|' + document.getElementById('demo-phase').textContent
    + '|' + document.getElementById('btn-demo-pause').textContent
    + '|' + document.getElementById('black-panel-state').textContent + '/' + document.getElementById('white-panel-state').textContent);
  snap('t0');
  let waitTurn = 0;
  for (; waitTurn < 90; waitTurn++) {
    const states = document.getElementById('black-panel-state').textContent + document.getElementById('white-panel-state').textContent;
    if (states.indexOf('等你落子') >= 0) break;
    if (waitTurn % 8 === 7) snap('t' + (waitTurn + 1));
    await sleep(250);
  }
  snap('end');
  out.humanTurnReached = waitTurn < 90;
  out.humanTurnWait = waitTurn;
  if (!out.humanTurnReached) {
    out.diagStates = document.getElementById('black-panel-state').textContent + ' / ' + document.getElementById('white-panel-state').textContent;
    out.diagPhase = document.getElementById('demo-phase').textContent;
    out.diagHint = document.getElementById('board-hint').textContent;
    out.diagMoves = document.querySelectorAll('#demo-moves .move-tag').length;
    out.diagBadges = document.getElementById('black-engine-badge').textContent + ' | ' + document.getElementById('white-engine-badge').textContent;
  }
  let humanThenAI = false;
  if (out.humanTurnReached) {
    const beforeAI = document.querySelectorAll('#demo-moves .move-tag').length;
    let placedNow = false;
    for (const mv of candidates) {
      const before = document.querySelectorAll('#demo-moves .move-tag').length;
      clickCell(mv[0], mv[1]);
      await sleep(90);
      if (document.querySelectorAll('#demo-moves .move-tag').length > before) { placedNow = true; break; }
    }
    const deadline = Date.now() + 25000;
    while (placedNow && Date.now() < deadline) {
      if (document.querySelectorAll('#demo-moves .move-tag').length >= beforeAI + 2) { humanThenAI = true; break; }
      await sleep(250);
    }
    out.humanThenPlaceOk = placedNow;
  }
  out.humanThenAiMoves = humanThenAI;
  // AI 走完这一步后必须把回合交回人类（面板重新显示「等你落子」）
  if (humanThenAI) {
    let back = 0;
    for (; back < 40; back++) {
      const st = document.getElementById('black-panel-state').textContent + document.getElementById('white-panel-state').textContent;
      if (st.indexOf('等你落子') >= 0) break;
      await sleep(250);
    }
    out.humanTurnAfterAi = back < 40;
    if (!out.humanTurnAfterAi) {
      out.diag2States = document.getElementById('black-panel-state').textContent + ' / ' + document.getElementById('white-panel-state').textContent;
      out.diag2Phase = document.getElementById('demo-phase').textContent;
      out.diag2Moves = document.querySelectorAll('#demo-moves .move-tag').length;
      out.diag2Banner = document.getElementById('board-banner').classList.contains('show');
    }
  }
  document.getElementById('btn-demo-manual').click();   // 交还，恢复正常演示
  await sleep(200);

  // 只有五子棋一个板块：占位视图已删除，未知板块必须被拒绝
  out.blankViewGone = document.getElementById('view-blank') === null;
  const unknownRes = await window.DemoView.start('vision');
  out.unknownBoardRejected = !!(unknownRes && unknownRes.ok === false);
  out.backToSettingsAfterReject = document.getElementById('view-settings').classList.contains('active');

  return out;
})()`;

// ------------------------------------------------------------------ 阶段 B
const PHASE_B_SCRIPT_STATE = 'window.demoAPI.demo.state()';

async function phaseB(win, results) {
  const out = {};
  const js = (code) => win.webContents.executeJavaScript(code);

  const entered = await js("window.demoAPI.demo.start('gomoku')");
  out.startResult = entered && entered.ok;
  out.lockInfo = entered && entered.lock ? {
    exitCodeLength: entered.lock.exitCodeLength,
    blockedCount: (entered.lock.blocked || []).length,
    failures: (entered.lock.failures || [])
  } : null;
  await wait(250);

  const state1 = await js(PHASE_B_SCRIPT_STATE);
  out.lockedAfterStart = state1.locked;
  out.viewActive = await js("document.getElementById('view-demo').classList.contains('active')");
  // 演示视图真正可见时，顶部大标题必须占据真实尺寸
  out.headlineVisibleInDemo = await js(`(() => {
    const el = document.querySelector('#view-demo .demo-headline h1');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 100 && r.height > 20 && el.offsetParent !== null;
  })()`);
  await wait(1600);
  if (results) results.shotDemo = await capture(win, '02-demo-headline');

  // 错误暗码：不应退出
  const wrong = ['1', '1', '4', '5', '1', '3'];
  for (const k of wrong) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k });
    await wait(70);
  }
  await wait(150);
  out.lockedAfterWrongCode = (await js(PHASE_B_SCRIPT_STATE)).locked;
  // 输错暗码必须有反馈（抖动/红点/文案/toast），且 1.7 秒后恢复
  out.wrongBadgeClass = await js("document.getElementById('lock-badge').classList.contains('wrong')");
  out.wrongText = await js("document.getElementById('lock-text').textContent");
  out.wrongDots = await js("document.querySelectorAll('#lock-keys i.bad').length");
  out.wrongToast = await js("document.querySelectorAll('#toast-host .toast').length");
  if (results) results.shotWrongCode = await capture(win, '03-wrong-code');
  await wait(1900);
  out.wrongRecoveredText = await js("document.getElementById('lock-text').textContent");
  out.wrongClassCleared = await js("!document.getElementById('lock-badge').classList.contains('wrong')");

  // 正确暗码：应退出
  const right = ['1', '1', '4', '5', '1', '4'];
  for (const k of right) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k });
    await wait(70);
  }
  await wait(500);
  const state2 = await js(PHASE_B_SCRIPT_STATE);
  out.lockedAfterRightCode = state2.locked;
  out.backToSettings = await js("document.getElementById('view-settings').classList.contains('active')");
  out.toastCount = await js("document.querySelectorAll('#toast-host .toast').length");

  // 退出后再次进入应当可用（验证清理干净）
  const again = await js("window.demoAPI.demo.start('gomoku')");
  out.reenterOk = !!(again && again.ok);
  await wait(200);
  // 用正确暗码再退一次，保证测试结束时桌面处于解锁状态
  for (const k of right) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k });
    await wait(70);
  }
  await wait(400);
  out.finalLocked = (await js(PHASE_B_SCRIPT_STATE)).locked;
  return out;
}

// ------------------------------------------------------------------ 阶段 C
function phaseC() {
  const out = {};
  const { DemoLock } = appRequire('main/kiosk.js');
  const calls = { kiosk: [], fullscreen: [], top: [], taskbar: [], closable: [], minimizable: [] };
  const stubWin = {
    setKiosk: (v) => calls.kiosk.push(v),
    setFullScreen: (v) => calls.fullscreen.push(v),
    setAlwaysOnTop: (v) => calls.top.push(v),
    setSkipTaskbar: (v) => calls.taskbar.push(v),
    setClosable: (v) => calls.closable.push(v),
    setMinimizable: (v) => calls.minimizable.push(v),
    isDestroyed: () => false,
    isMinimized: () => false,
    isFocused: () => true,
    show: () => {}, focus: () => {}, moveTop: () => {}, restore: () => {},
    webContents: { on: () => {}, removeListener: () => {} }
  };
  const lock = new DemoLock(stubWin);
  let exited = null;
  let hints = [];
  let wrongHints = [];
  lock.onExit((reason) => { exited = reason; });
  lock.onKeyHint((len, total, extra) => { hints.push([len, total]); wrongHints.push(!!(extra && extra.wrong)); });
  lock.locked = true;
  lock.exitCode = '114514';

  // 1) 同一物理按键被 globalShortcut 与 before-input-event 双重投递时只算一次
  lock.buffer = '';
  lock._lastKey = { key: '', at: 0, source: '' };
  lock._pushKey('1', 'global');
  lock._pushKey('1', 'input');
  out.dedupeBuffer = lock.buffer;
  out.dedupeNotExited = lock.locked === true && lock.buffer === '1';
  out.crossChannelDedupe = lock.buffer === '1';
  out.dedupeReason = exited;

  // 1b) 人手连按同一数字（间隔远大于去重窗口）不得丢键
  lock._lastKey = { key: '1', at: 0, source: 'input' };
  lock._pushKey('1', 'input');
  out.humanRepeatKept = lock.buffer === '11';
  lock.buffer = '';

  // 模拟「人类打字速度」（相邻按键间隔 > 去重窗口）：每次都重置去重状态
  const type = (seq) => seq.forEach((k) => { lock._lastKey = { key: '', at: 0, source: '' }; lock._pushKey(k); });

  // 2) 合法前缀逐位累加
  lock.buffer = '';
  type(['1', '1', '4', '5', '1']);
  out.prefixKept = lock.buffer === '11451';

  // 3) 输错一位即重置缓冲，并给出错误提示
  hints = [];
  wrongHints = [];
  lock.buffer = '';
  type(['9']);
  out.wrongResetsBuffer = lock.buffer === '';
  type(['1', '1', '9']);
  out.wrongResetsBuffer2 = lock.buffer === '';
  out.wrongHintFired = wrongHints.some(Boolean);
  out.notExitedYet = lock.locked === true && exited === null;

  // 3) 非字母数字键不得进入缓冲
  lock.buffer = '';
  type(['F5', 'Tab', 'Escape']);
  out.nonAlnumIgnored = lock.buffer === '';

  // 4) 正确暗码 → 退出并清理
  lock.buffer = '';
  hints = [];
  type(['1', '1', '4', '5', '1', '4']);
  out.exitedReason = exited;
  out.lockedAfterCode = lock.locked === false;
  out.hintPairs = hints.map((h) => h.join('/'));
  out.hintTotal = hints.length ? hints[0][1] : null;
  out.cleanup = {
    kioskOff: calls.kiosk.indexOf(false) >= 0,
    fullscreenOff: calls.fullscreen.indexOf(false) >= 0,
    topOff: calls.top.indexOf(false) >= 0,
    taskbarOn: calls.taskbar.indexOf(false) >= 0,
    closableOn: calls.closable.indexOf(true) >= 0
  };
  return out;
}

// ------------------------------------------------------------------ 阶段 D：终局横幅
async function phaseBanner(win, results) {
  const out = {};
  const js = (code) => win.webContents.executeJavaScript(code);

  // 双方都用内置本地引擎 + 0 节奏，让对局尽快分出胜负
  await js(`(() => {
    ['black', 'white'].forEach((side) => {
      const sel = document.getElementById(side + '-engine');
      sel.value = 'local';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    document.getElementById('btn-save').click();
  })()`);
  await wait(700);
  await js("window.DemoView.start('gomoku')");   // 只切视图，不进入锁定
  await wait(400);
  // 比分条：进入演示时归零，且必须位于标题下方
  out.scoreAtStart = await js(`(() => {
    const board = document.getElementById('demo-score');
    const sub = document.querySelector('#view-demo .demo-headline .headline-sub');
    const r = board.getBoundingClientRect();
    const sr = sub.getBoundingClientRect();
    const num = (id) => parseInt((document.getElementById(id) || {}).textContent, 10) || 0;
    return {
      black: num('score-black'), white: num('score-white'), draw: num('score-draw'),
      visible: r.width > 0 && r.height > 0,
      belowSubtitle: r.top >= sr.bottom - 1,
      fontSize: parseFloat(getComputedStyle(document.getElementById('score-black')).fontSize) || 0
    };
  })()`);
  await js(`(() => {
    const pace = document.getElementById('demo-pace');
    pace.value = '0';
    pace.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  let shown = false;
  for (let i = 0; i < 200; i++) {
    const st = await js(`(() => ({
      shown: document.getElementById('board-banner').classList.contains('show'),
      moves: document.querySelectorAll('#demo-moves .move-tag').length
    }))()`);
    if (st.shown) { shown = true; out.movesAtEnd = st.moves; break; }
    if (i % 20 === 19) console.log('[smoke] 等待终局…手数=' + st.moves);
    await wait(500);
  }
  out.bannerShown = shown;
  if (!shown) return out;

  // 优化②：横幅刚弹出时倒计时应为 10 秒（后面还要等它到点自动续场）
  out.autoCountdown = await js(`(() => {
    const c = document.getElementById('banner-countdown');
    const r = c.getBoundingClientRect();
    return { visible: !c.classList.contains('hidden') && r.height > 0, text: c.textContent };
  })()`);

  const scoreNow = () => js(`(() => {
    const num = (id) => parseInt((document.getElementById(id) || {}).textContent, 10) || 0;
    return num('score-black') + num('score-white') + num('score-draw');
  })()`);
  out.scoreAfterEnd = await scoreNow();   // 一局终了：必须正好累加 1

  out.bannerGeo = await js(`(() => {
    const b = document.getElementById('board-banner');
    const btn = document.getElementById('btn-banner-new');
    const title = document.getElementById('banner-title');
    const sub = document.getElementById('banner-sub');
    const r = b.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const tr = title.getBoundingClientRect();
    const sr = sub.getBoundingClientRect();
    const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
    return {
      title: title.textContent,
      sub: sub.textContent,
      lineHeight: getComputedStyle(b).lineHeight,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
      buttonTopmost: hit === btn || btn.contains(hit),
      noTextOverlap: sr.top >= tr.bottom - 1.5,
      buttonBelowText: br.top >= sr.bottom - 1.5
    };
  })()`);
  await wait(700);   // 等一帧真正提交（隐藏窗口下 capturePage 会拿到上一次合成的帧）
  try { win.show(); win.focus(); } catch (_) {}
  await wait(1600);
  results.shotBanner = await capture(win, '04-banner-win');

  // 优化①：步数条出现横向滚动条时不能压住落子标签
  out.movesGeo = await js(`(() => {
    const m = document.getElementById('demo-moves');
    const tags = Array.from(m.querySelectorAll('.move-tag'));
    const cs = getComputedStyle(m);
    const r = m.getBoundingClientRect();
    const scrollbar = m.offsetHeight - m.clientHeight;   // 横向滚动条占掉的高度
    const bandTop = r.bottom - scrollbar;                // 滚动条顶沿（视口坐标）
    let lowest = -1e9;
    tags.forEach((t) => { lowest = Math.max(lowest, t.getBoundingClientRect().bottom); });
    return {
      count: tags.length,
      overflow: m.scrollWidth > m.clientWidth + 1,
      scrollbarHeight: scrollbar,
      paddingBottom: cs.paddingBottom,
      boxHeight: Math.round(r.height),
      tagBottomMax: Math.round(lowest),
      bandTop: Math.round(bandTop),
      clearance: Math.round(bandTop - lowest)   // >= 0 表示没有被遮挡
    };
  })()`);

  // 优化②：终局后 10 秒内无操作应自动开始下一局（倒计时可见 → 到点自动重开）
  const scoreBeforeAuto = await scoreNow();
  let autoStarted = false;
  for (let i = 0; i < 30; i++) {                     // 最多等 15 秒
    if (await js("!document.getElementById('board-banner').classList.contains('show')")) { autoStarted = true; break; }
    await wait(500);
  }
  out.autoNextStarted = autoStarted;
  out.scoreAfterAutoNext = await scoreNow();         // 自动续场只应重开新局，不应多加一分
  out.scoreBeforeAuto = scoreBeforeAuto;

  await js("document.getElementById('btn-banner-new').click()");
  await wait(800);
  out.bannerHiddenAfterRestart = await js("!document.getElementById('board-banner').classList.contains('show')");
  out.movesAfterBannerRestart = await js("document.querySelectorAll('#demo-moves .move-tag').length");
  out.newGameRunning = await js("document.getElementById('board-hint').textContent.indexOf('本局已结束') < 0");
  out.scoreAfterNewGame = await scoreNow();   // 「再来一局」不清零、也不重复累加

  // 第二局再分出胜负 → 比分应累加到 2；随后悔一步 → 已计分的那局要回退
  let second = false;
  for (let i = 0; i < 200; i++) {
    if (await js("document.getElementById('board-banner').classList.contains('show')")) { second = true; break; }
    await wait(500);
  }
  out.secondBannerShown = second;
  if (second) {
    out.scoreAfterSecondEnd = await scoreNow();
    out.countdownBeforePause = await js("!document.getElementById('banner-countdown').classList.contains('hidden')");
    await js("document.getElementById('btn-demo-pause').click()");   // 先冻结，避免撤销后 AI 又立刻结束一局
    await wait(250);
    out.countdownClearedOnPause = await js("document.getElementById('banner-countdown').classList.contains('hidden')");
    await js("document.getElementById('btn-demo-undo').click()");
    await wait(400);
    out.scoreAfterUndo = await scoreNow();
    out.bannerHiddenAfterUndo = await js("!document.getElementById('board-banner').classList.contains('show')");
  }
  return out;
}

// ------------------------------------------------------------------ 主流程
trace('[boot] requiring ' + path.join(APP_ROOT, 'main', 'main.js'));
appRequire('main/main.js');
trace('[boot] main.js loaded');

app.whenReady().then(async () => {
  trace('[boot] app ready');
  // 关闭主进程可能弹出的错误对话框，避免测试卡住
  app.on('browser-window-created', (event, win) => {
    win.webContents.on('console-message', (e, level, message) => {
      if (level >= 3) results.errors.push('renderer console: ' + message);
    });
  });

  try {
    let win = null;
    for (let i = 0; i < 100 && !win; i++) {
      win = BrowserWindow.getAllWindows()[0];
      if (!win) await wait(100);
    }
    if (!win) throw new Error('主窗口未创建');
    if (win.webContents.isLoading()) {
      await new Promise((r) => win.webContents.once('did-finish-load', r));
    }
    // 等待渲染层启动完成（board-list 渲染出来）
    for (let i = 0; i < 60; i++) {
      const ready = await win.webContents.executeJavaScript("document.querySelectorAll('#board-list .board-card').length");
      if (ready > 0) break;
      await wait(200);
    }

    console.log('[smoke] 阶段 A：设置界面 / IPC / 五子棋自对弈');
    // 截图前把双方切到「大模型 API」，确保能看到模型下拉组件
    await win.webContents.executeJavaScript(`(() => {
      ['black', 'white'].forEach((side) => {
        const sel = document.getElementById(side + '-engine');
        sel.value = 'api';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
    })()`);
    await wait(700);
    results.shotSettings = await capture(win, '01-settings');
    await win.webContents.executeJavaScript("document.getElementById('black-model-arrow').click()");
    await wait(300);
    results.shotCombo = await capture(win, '01b-model-combo');
    await win.webContents.executeJavaScript("document.getElementById('black-model-arrow').click()");
    await wait(150);
    results.phaseA = await win.webContents.executeJavaScript(PHASE_A_SCRIPT);

    console.log('[smoke] 阶段 D：终局横幅 / 再来一局');
    results.phaseD = await phaseBanner(win, results);

    console.log('[smoke] 阶段 B：演示锁定端到端（会短暂全屏置顶）');
    results.phaseB = await phaseB(win, results);

    console.log('[smoke] 阶段 C：DemoLock 单元校验');
    results.phaseC = phaseC();
  } catch (err) {
    results.errors.push('异常：' + (err && err.stack ? err.stack : String(err)));
  }

  const a = results.phaseA || {};
  const b = results.phaseB || {};
  const c = results.phaseC || {};
  const d = results.phaseD || {};
  const assertions = [
    ['demoAPI 暴露', a.apiExposed === true],
    ['CSP 已配置且禁止远程连接', typeof a.cspMeta === 'string' && /connect-src 'none'/.test(a.cspMeta) && /script-src 'self'/.test(a.cspMeta)],
    ['CSP 实际拦截渲染层网络请求', /^connect-src/.test(String(a.cspViolation))],
    ['棋盘 15×15', a.rulesSize === 15],
    ['1 个技术板块卡片', a.boardCards === 1],
    ['板块卡片按钮可用', a.boardButtons >= 1],
    ['设置可保存', a.saveState === '设置已同步'],
    ['API Key 回读一致', a.savedKey === 'sk-smoke-test-key'],
    ['白方引擎保存为 local', a.savedWhiteEngine === 'local'],
    ['重试次数被 clamp 保存', a.savedAttempts === 2],
    ['Electron 22', String(a.electron).startsWith('22.')],
    ['暗码长度 6', a.exitCodeLength === 6],
    ['棋盘文本 16 行', a.boardTextLines === 16],
    ['本地引擎 IPC 可用', a.localThink === true],
    ['五子连珠判胜', a.winner === 1 && a.winLineLength >= 5],
    ['第 9 手起已结束并拒绝落子', a.rejectsAfterOver === true && a.finalPlaceOk === true],
    ['悔棋清除胜负', a.afterUndoWinner === null],
    ['演示视图切到五子棋', a.demoActive === true],
    ['棋盘 Canvas 已绘制', a.canvasWidth > 300],
    ['暗码进度点 6 个', a.lockDots === 6],
    ['AI 双方自动落子', a.movesPlayed >= 4],
    ['黑方思考文本已展示', a.blackReasoningLen > 0],
    ['无引擎错误弹窗', a.errorShown === false],
    ['暂停按钮生效', a.pauseLabel === '继续'],
    ['继续按钮生效', a.resumeLabel === '暂停'],
    ['悔一步减少一手', a.undoDelta === 1],
    ['手数标记可切换', typeof a.numbersLabel === 'string' && a.numbersLabel.length > 0],
    ['重新开始后继续对弈', a.movesAfterRestart >= 2],
    ['模型下拉为自绘组件', a.comboMenus === 2 && a.datalistGone === true],
    ['思考档位 off/low/high/max', a.blackEffortOptions === 'off,low,high,max' && a.whiteEffortOptions === 'off,low,high,max'],
    ['本地引擎隐藏模型与档位', a.localFieldsHidden === true && a.localNoteShown === true],
    ['切回 API 恢复模型字段', a.apiFieldsShown === true && a.apiNoteHidden === true],
    ['下拉可展开并选中候选项', a.comboOpen === true && a.comboItems >= 2 && a.comboPickedMatches === true && a.comboClosedAfterPick === true],
    ['顶部大标题正确且可见', a.headlineText === 'DeepSeek能否战胜机器？' && a.headlineCount === 1 && a.headlineFontSize >= 24 && b.headlineVisibleInDemo === true],
    ['旧模型名保存后被迁移', a.legacyModelMigrated === true],
    ['low 思考档位可保存', a.lowEffortSaved === true],
    ['手数区为横向滚动不换行', a.movesOverflowX === 'auto' && a.movesNoWrap === 'nowrap'],
    ['底部栏高度稳定', a.footerHeight > 0 && a.footerHeight <= 90],
    ['人机对战可接管一方', a.manualLabelBefore === '我要挑战deepseek！' && typeof a.manualLabelAfter === 'string' && a.manualLabelAfter.indexOf('交还') >= 0 && /人类棋手/.test(a.manualBadges || '')],
    ['挑战按钮在棋盘下方并放大', a.challengeInBoardArea === true && a.challengeBelowCanvas === true && a.challengeFontSize >= 15],
    ['人工点击棋盘落子成功', a.humanPlaced === 1 && a.humanReasoningShown === true],
    ['交还引擎后按钮与徽章还原', typeof a.manualLabelBack === 'string' && a.manualLabelBack.indexOf('我要挑战') >= 0 && !/人类棋手/.test(a.badgeRestored || '')],
    ['人落子后 AI 自动接续落子', a.humanTurnFirst === true && a.humanTurnReached === true && a.humanThenPlaceOk === true && a.humanThenAiMoves === true],
    ['AI 落子后回合自动交回人类', a.humanTurnAfterAi === true],
    ['占位视图已删除且未知板块被拒绝', a.blankViewGone === true && a.unknownBoardRejected === true && a.backToSettingsAfterReject === true],
    ['demo:start 成功进入锁定', b.startResult === true && b.lockedAfterStart === true],
    ['锁定后切到演示视图', b.viewActive === true],
    ['注册了系统快捷键封锁', b.lockInfo && b.lockInfo.blockedCount >= 30],
    ['错误暗码不退出', b.lockedAfterWrongCode === true],
    ['输错暗码有红色反馈', b.wrongBadgeClass === true && b.wrongToast >= 1],
    ['输错提示文案与红点齐全', /错误/.test(b.wrongText || '') && b.wrongDots === 6],
    ['输错提示 1.7 秒后恢复', b.wrongClassCleared === true && /演示锁定中/.test(b.wrongRecoveredText || '')],
    ['正确暗码退出锁定', b.lockedAfterRightCode === false],
    ['退出后回到设置界面', b.backToSettings === true],
    ['可再次进入演示', b.reenterOk === true],
    ['第二轮也正常退出', b.finalLocked === false],
    ['合法前缀逐位累加', c.prefixKept === true],
    ['输错一位即重置缓冲', c.wrongResetsBuffer === true && c.wrongResetsBuffer2 === true && c.wrongHintFired === true],
    ['未输完不退出', c.notExitedYet === true],
    ['同一按键双通道只记一次', c.dedupeNotExited === true || c.crossChannelDedupe === true],
    ['人手连按同一数字不丢键', c.humanRepeatKept === true],
    ['退出回调携带原因', typeof c.exitedReason === 'string' && c.exitedReason.length > 0],
    ['退出后 locked=false', c.lockedAfterCode === true],
    ['进度回调 1..6', Array.isArray(c.hintPairs) && c.hintPairs.length === 6 && c.hintPairs[5] === '6/6'],
    ['退出时还原 Kiosk', c.cleanup && c.cleanup.kioskOff === true && c.cleanup.fullscreenOff === true],
    ['退出时还原置顶/任务栏', c.cleanup && c.cleanup.topOff === true && c.cleanup.taskbarOn === true],
    ['非数字字符不进入缓冲', c.nonAlnumIgnored === true],
    ['对局能自行分出胜负并弹出横幅', d.bannerShown === true && d.movesAtEnd >= 5],
    ['再来一局对话框文字不重叠', d.bannerGeo && d.bannerGeo.noTextOverlap === true && d.bannerGeo.buttonBelowText === true],
    ['再来一局对话框完整可见且可点击', d.bannerGeo && d.bannerGeo.inViewport === true && d.bannerGeo.buttonTopmost === true],
    ['横幅行高已修正（非 0）', d.bannerGeo && d.bannerGeo.lineHeight !== '0px'],
    ['再来一局可重开新局', d.bannerHiddenAfterRestart === true && d.newGameRunning === true && d.movesAfterBannerRestart >= 1],
    ['标题下方显示实时比分（进入演示归零）', d.scoreAtStart && d.scoreAtStart.black === 0 && d.scoreAtStart.white === 0 && d.scoreAtStart.draw === 0 && d.scoreAtStart.visible === true && d.scoreAtStart.belowSubtitle === true && d.scoreAtStart.fontSize >= 16],
    ['一局结束后比分自动累加', d.scoreAfterEnd === 1],
    ['再来一局保留比分不重复累加', d.scoreAfterNewGame === 1],
    ['第二局结束后比分继续累加', d.secondBannerShown === true && d.scoreAfterSecondEnd === 2],
    ['悔掉已计分的对局后比分回退', d.scoreAfterUndo === 1 && d.bannerHiddenAfterUndo === true],
    ['步数条横向滚动条不遮挡落子标签', d.movesGeo && d.movesGeo.overflow === true && d.movesGeo.count > 10 && d.movesGeo.clearance >= 0],
    ['终局横幅显示 10 秒自动续场倒计时', d.autoCountdown && d.autoCountdown.visible === true && d.autoCountdown.text.indexOf('秒自动开始下一局') > 0 && Number((d.autoCountdown.text.match(/(\d+)\s*秒/) || [])[1]) >= 8],
    ['终局 10 秒无操作自动开始下一局', d.autoNextStarted === true && d.scoreAfterAutoNext === d.scoreBeforeAuto],
    ['暂停操作会取消自动续场', d.countdownBeforePause === true && d.countdownClearedOnPause === true]
  ];

  const failed = assertions.filter((x) => !x[1]);
  results.assertions = assertions.map((x) => (x[1] ? 'PASS  ' : 'FAIL  ') + x[0]);
  failed.forEach((x) => results.errors.push('断言失败：' + x[0]));

  console.log('\n--- 断言 ---');
  assertions.forEach((x) => console.log((x[1] ? '  ✓ ' : '  ✗ ') + x[0]));
  console.log('\n通过 ' + (assertions.length - failed.length) + ' / ' + assertions.length);

  finish(failed.length === 0 ? 0 : 1);
});

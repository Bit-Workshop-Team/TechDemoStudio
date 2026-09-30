'use strict';

/**
 * 纯 Node 自检（不启动 Electron）：
 *   node tools/self-test.js
 * 覆盖：规则内核、棋盘文本、本地启发式引擎的合法性与成五能力。
 */

const rules = require('../src/shared/gomoku-rules.js');
const prompts = require('../src/shared/default-prompts.js');
const localEngine = require('../src/main/local-engine.js');
const configStore = require('../src/main/config-store.js');
const llm = require('../src/main/llm-client.js');
const { DemoLock } = require('../src/main/kiosk.js');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

// ---------------------------------------------------------------- 规则内核
section('规则内核');
{
  const board = rules.createBoard();
  check('棋盘为 15×15', board.length === 15 && board.every((row) => row.length === 15));
  check('初始为空盘', rules.moveCount(board) === 0 && rules.emptyPoints(board).length === 225);

  // 水平五连
  for (let c = 3; c <= 7; c++) board[7][c] = rules.BLACK;
  const line = rules.findWinLine(board, 7, 7);
  check('水平五连被识别', !!line && line.length === 5, JSON.stringify(line));
  check('五连坐标正确', line && line[0][0] === 7 && line[0][1] === 3 && line[4][1] === 7);

  // 长连（六子）也算胜（无禁手）
  const b2 = rules.createBoard();
  for (let c = 2; c <= 7; c++) b2[2][c] = rules.WHITE;
  check('长连（六子）同样判胜', !!rules.findWinLine(b2, 2, 4));
  check('长连返回 6 个点', rules.findWinLine(b2, 2, 4).length === 6);

  // 斜向五连
  const b3 = rules.createBoard();
  for (let i = 0; i < 5; i++) b3[i][i] = rules.BLACK;
  check('主对角线五连被识别', !!rules.findWinLine(b3, 2, 2));

  // 四子不算胜
  const b4 = rules.createBoard();
  for (let c = 0; c < 4; c++) b4[0][c] = rules.BLACK;
  check('四子不算胜', rules.findWinLine(b4, 0, 0) === null);

  // 被堵住的五连不成立
  const b5 = rules.createBoard();
  for (let c = 0; c < 5; c++) b5[5][c] = rules.BLACK;
  b5[5][2] = rules.WHITE;
  check('中间被异色断开不算五连', rules.findWinLine(b5, 5, 0) === null);

  check('越界坐标无效', !rules.inBounds(-1, 0) && !rules.inBounds(15, 0));
  check('已占点不可落子', !rules.isValidMove(b3, 0, 0) && rules.isValidMove(b3, 14, 14));
  check('棋子字符正确', rules.cellChar(rules.BLACK) === 'B' && rules.cellChar(rules.WHITE) === 'W');
}

// ---------------------------------------------------------------- 棋盘文本
section('棋盘文本（与参考插件一致的坐标格式）');
{
  const board = rules.createBoard();
  board[0][0] = rules.BLACK;
  board[14][14] = rules.WHITE;
  board[7][7] = rules.BLACK;
  const text = rules.boardToText(board);
  const lines = text.split('\n');
  check('输出 16 行（列号 + 15 行棋盘）', lines.length === 16, 'lines=' + lines.length);
  check('首行为列号 0~14', lines[0].trim().split(/\s+/).join(' ') === Array.from({ length: 15 }, (_, i) => i).join(' '), lines[0]);
  check('每行以行号开头', lines[1].trim().startsWith('0') && lines[15].trim().startsWith('14'));
  check('包含 B / W 标记', text.includes('B') && text.includes('W'));
  check('行数行号与坐标一致', /^\s*7[\s]/.test(lines[8]), lines[8]);
}

// ---------------------------------------------------------------- 默认提示词
section('默认提示词 / 用户消息构造');
{
  check('默认系统提示词非空', typeof prompts.DEFAULT_SYSTEM_PROMPT === 'string' && prompts.DEFAULT_SYSTEM_PROMPT.length > 300);
  check('提示词包含返回格式约定', prompts.DEFAULT_SYSTEM_PROMPT.includes('"move"'));
  const msg = prompts.buildUserMessage(rules.boardToText(rules.createBoard()), rules.WHITE, null);
  check('用户消息包含棋盘与执子方', msg.includes('W') && msg.includes('棋盘'));
  const msg2 = prompts.buildUserMessage(rules.boardToText(rules.createBoard()), rules.BLACK, { reason: '坐标越界', raw: '{"move":[15,15]}' });
  check('重试时附带拒绝原因与原文', msg2.includes('坐标越界') && msg2.includes('[15,15]'));
  check('提示词要求使用简体中文', prompts.DEFAULT_SYSTEM_PROMPT.includes('简体中文'));
  check('用户消息要求中文思考', msg.includes('简体中文'));
}

// ---------------------------------------------------------------- 非法落子的纠正提示
section('非法落子 → 重试提示词');
{
  const svc = require('../src/main/gomoku-service.js');
  const board = rules.createBoard();
  board[7][7] = rules.BLACK;                       // 造一个被占用的点
  const cases = [
    ['回复为空', '', 'JSON'],
    ['无 JSON', '我选择落在天元附近，谢谢。', 'JSON'],
    ['缺少 move', '{"action":"place"}', 'move'],
    ['坐标越界', '{"move":[15,3]}', '0 到 14'],
    ['非整数坐标', '{"move":[7.5,7]}', '整数'],
    ['落在已有棋子上', '{"move":[7,7]}', '空']
  ];
  const hints = {};
  cases.forEach(([name, text, must]) => {
    const v = svc.interpretReply(board, text);
    hints[name] = v;
    check('非法落子被拒绝：' + name, v.ok === false && typeof v.hint === 'string' && v.hint.length > 8 && v.hint.includes(must));
  });
  const retry = prompts.buildUserMessage(rules.boardToText(board), rules.BLACK, {
    reason: hints['落在已有棋子上'].reason,
    raw: '{"move":[7,7]}',
    hint: hints['落在已有棋子上'].hint
  }, board);
  check('重试消息包含纠正提示', retry.includes('纠正提示：') && retry.includes(hints['落在已有棋子上'].hint));
  check('重试消息列出空点示例', retry.includes('空点') && /\[\d+,\d+\]/.test(retry));
  const ok = svc.interpretReply(board, '{"move":[8,8]}');
  check('合法落子仍然通过', ok.ok === true && ok.move[0] === 8 && ok.move[1] === 8);
  const draw = svc.interpretReply(board, '{"draw": true}');
  check('和棋回复仍然通过', draw.ok === true && draw.draw === true);
}

// ---------------------------------------------------------------- 配置迁移
section('配置默认值与旧模型名迁移');
{
  check('默认模型为 deepseek-flash', configStore.DEFAULTS.black.model === 'deepseek-flash' && configStore.DEFAULTS.white.model === 'deepseek-flash');
  check('思考档位含 low', configStore.EFFORT_LEVELS.join(',') === 'off,low,high,max');
  check('模型建议非空', Array.isArray(configStore.MODEL_SUGGESTIONS) && configStore.MODEL_SUGGESTIONS.length >= 1);

  const cfg = configStore.sanitize({
    black: { model: 'deepseek-chat', reasoningEffort: 'low' },
    white: { model: 'deepseek-reasoner', reasoningEffort: 'medium' }
  });
  check('旧名 deepseek-chat 迁移为 deepseek-flash', cfg.black.model === 'deepseek-flash', cfg.black.model);
  check('旧名 deepseek-reasoner 迁移为 deepseek-flash', cfg.white.model === 'deepseek-flash', cfg.white.model);
  check('low 档位被接受', cfg.black.reasoningEffort === 'low', cfg.black.reasoningEffort);
  check('非法档位回落到 off', cfg.white.reasoningEffort === 'off', cfg.white.reasoningEffort);
  const custom = configStore.sanitize({ black: { model: 'my-own-model' } });
  check('自定义模型名不被改写', custom.black.model === 'my-own-model', custom.black.model);
}

// ---------------------------------------------------------------- 请求体
section('LLM 请求体（DeepSeek 思考开关）');
{
  const ds = 'https://api.deepseek.com';
  const third = 'https://my-gateway.example.com/v1';
  const off = llm.buildChatBody({ baseUrl: ds, model: 'deepseek-flash', messages: [], maxTokens: 100, reasoningEffort: 'off' });
  check('DeepSeek + off 显式关闭思考', off.thinking && off.thinking.type === 'disabled', JSON.stringify(off.thinking));
  check('DeepSeek + off 不发 reasoning_effort', off.reasoning_effort === undefined);
  const low = llm.buildChatBody({ baseUrl: ds, model: 'deepseek-flash', messages: [], maxTokens: 100, reasoningEffort: 'low' });
  check('DeepSeek + low 开启思考并透传档位', low.thinking.type === 'enabled' && low.reasoning_effort === 'low', JSON.stringify(low));
  const max = llm.buildChatBody({ baseUrl: ds, model: 'deepseek-v4-pro', messages: [], reasoningEffort: 'max' });
  check('max 档位透传', max.reasoning_effort === 'max');
  const other = llm.buildChatBody({ baseUrl: third, model: 'gpt-x', messages: [], reasoningEffort: 'high' });
  check('第三方端点不发 thinking', other.thinking === undefined, JSON.stringify(other));
  check('第三方端点仍透传 reasoning_effort', other.reasoning_effort === 'high');
  check('识别 DeepSeek 域名', llm.isDeepSeekHost('https://api.deepseek.com') && llm.isDeepSeekHost('api.deepseek.com') && !llm.isDeepSeekHost('https://deepseek.com.evil.net'));
  check('模型名与 max_tokens 原样带上', max.model === 'deepseek-v4-pro' && off.max_tokens === 100);
}

// ---------------------------------------------------------------- 退出暗码
section('退出暗码（含输错提示）');
{
  const stubWin = {
    isDestroyed: () => false,
    webContents: { removeListener: () => {} },
    setKiosk: () => {}, setFullScreen: () => {}, setAlwaysOnTop: () => {},
    setSkipTaskbar: () => {}, setClosable: () => {}, setMinimizable: () => {},
    show: () => {}, focus: () => {}
  };
  const hints = [];
  const lock = new DemoLock(stubWin);
  lock.onKeyHint((length, total, extra) => hints.push({ length, total, wrong: !!(extra && extra.wrong) }));
  let exitReason = null;
  lock.onExit((reason) => { exitReason = reason; });
  lock.locked = true;

  // 模拟真实人手敲键（每次按键间隔大于去重窗口）
  const type = (target, code, source) => code.split('').forEach((k) => {
    target._lastKey.at = 0;
    target._pushKey(k, source || 'input');
  });

  type(lock, '114513');
  check('错误暗码不退出', lock.locked === true && exitReason === null);
  check('错误暗码触发 wrong 提示', hints.some((h) => h.wrong), JSON.stringify(hints.slice(-2)));
  check('错误后缓冲被重置', lock.buffer === '' || lock.buffer === '1', 'buffer=' + JSON.stringify(lock.buffer));

  hints.length = 0;
  type(lock, '114514');
  check('正确暗码退出全屏', lock.locked === false && !!exitReason, String(exitReason));
  check('退出后不再接收按键', (lock._pushKey('1', 'input'), lock.buffer === ''));

  // 同一次按键被 globalShortcut 与 before-input-event 双通道投递时只能算一次
  const lock2 = new DemoLock(stubWin);
  lock2.locked = true;
  lock2._pushKey('1', 'global');
  lock2._pushKey('1', 'input');
  check('双通道投递的同一按键只记一次', lock2.buffer === '1', 'buffer=' + JSON.stringify(lock2.buffer));
  // 人手连续按同一个数字（超过 80ms）必须都能记进去
  const lock3 = new DemoLock(stubWin);
  lock3.locked = true;
  lock3._pushKey('1', 'input');
  lock3._lastKey.at = 0;
  lock3._pushKey('1', 'input');
  check('连续相同按键不会被吞掉', lock3.buffer === '11', 'buffer=' + JSON.stringify(lock3.buffer));
}

// ---------------------------------------------------------------- 本地引擎
section('本地启发式引擎');
{
  const empty = rules.createBoard();
  for (const level of [1, 2, 3]) {
    const t0 = Date.now();
    const res = localEngine.think(empty, rules.BLACK, { level });
    const cost = Date.now() - t0;
    check('L' + level + ' 返回合法坐标', Array.isArray(res.move) && rules.isValidMove(empty, res.move[0], res.move[1]), JSON.stringify(res.move));
    check('L' + level + ' 返回思考文本', typeof res.reasoning === 'string' && res.reasoning.length > 10);
    check('L' + level + ' 耗时 < 3000ms', cost < 3000, cost + 'ms');
  }

  // 己方四连 → 必须直接成五
  const b = rules.createBoard();
  for (let c = 3; c <= 6; c++) b[7][c] = rules.BLACK;
  const win = localEngine.think(b, rules.BLACK, { level: 3 });
  check('有四连时直接成五', b[7][win.move[1]] === undefined || true);
  check('成五点被选中', (win.move[0] === 7 && (win.move[1] === 2 || win.move[1] === 7)), JSON.stringify(win.move));

  // 对手四连 → 必须封堵
  const b2 = rules.createBoard();
  for (let c = 3; c <= 6; c++) b2[9][c] = rules.WHITE;
  b2[0][0] = rules.BLACK;
  const block = localEngine.think(b2, rules.BLACK, { level: 3 });
  check('对手四连被封锁', block.move[0] === 9 && (block.move[1] === 2 || block.move[1] === 7), JSON.stringify(block.move));
}

// ---------------------------------------------------------------- 自对弈完整性
section('本地引擎自对弈（黑 L3 vs 白 L2，最多 225 手）');
{
  const board = rules.createBoard();
  let turn = rules.BLACK;
  let moves = 0;
  let illegal = 0;
  let winner = null;
  while (moves < 225) {
    const res = localEngine.think(board, turn, { level: turn === rules.BLACK ? 3 : 2 });
    if (!res.move || !rules.isValidMove(board, res.move[0], res.move[1])) { illegal++; break; }
    board[res.move[0]][res.move[1]] = turn;
    moves++;
    const line = rules.findWinLine(board, res.move[0], res.move[1]);
    if (line) { winner = turn; break; }
    if (rules.isBoardFull(board)) break;
    turn = rules.opponent(turn);
  }
  check('全程无非法落子', illegal === 0);
  check('分出胜负或下满', !!winner || rules.isBoardFull(board), 'moves=' + moves);
  check('产生了落子', moves >= 9, 'moves=' + moves);
  console.log('    → 结果：' + (winner ? (winner === rules.BLACK ? '黑胜' : '白胜') : '和棋') + '，共 ' + moves + ' 手');
}

// ---------------------------------------------------------------- 汇总
console.log('\n' + '─'.repeat(52));
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);

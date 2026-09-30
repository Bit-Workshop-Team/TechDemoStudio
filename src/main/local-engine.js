'use strict';

/**
 * 内置本地五子棋引擎（启发式，无需联网 / 无需 API Key）。
 * 用途：无网络或未配置 API Key 时仍然可以完成"双 AI 对弈"演示。
 * 思路：棋型模板打分 + 取胜/封堵优先 + 双威胁识别 + 1 层预判。
 */

const rules = require('../shared/gomoku-rules.js');

const SCORE = {
  FIVE: 10000000,
  OPEN_FOUR: 500000,
  FOUR: 60000,
  OPEN_THREE: 30000,
  THREE: 3000,
  OPEN_TWO: 800,
  TWO: 80
};

// 注意顺序：从强到弱，每方向取首个命中的棋型
const PATTERNS = [
  { re: /XXXXX/, score: SCORE.FIVE },
  { re: /\.XXXX\./, score: SCORE.OPEN_FOUR },
  { re: /XXXX\.|\.XXXX|XXX\.X|X\.XXX|XX\.XX/, score: SCORE.FOUR },
  { re: /\.XXX\.|\.XX\.X\.|\.X\.XX\./, score: SCORE.OPEN_THREE },
  { re: /XXX|XX\.X|X\.XX/, score: SCORE.THREE },
  { re: /\.XX\.|\.X\.X\./, score: SCORE.OPEN_TWO },
  { re: /XX|X\.X/, score: SCORE.TWO }
];

const LEVELS = {
  1: { candidates: 40, lookahead: 0, jitter: 0.35, label: '快速' },
  2: { candidates: 60, lookahead: 6, jitter: 0.15, label: '标准' },
  3: { candidates: 80, lookahead: 12, jitter: 0.05, label: '强化' }
};

function windowOf(board, r, c, player, dr, dc) {
  let s = '';
  for (let i = -4; i <= 4; i++) {
    const rr = r + dr * i;
    const cc = c + dc * i;
    if (!rules.inBounds(rr, cc)) { s += '#'; continue; }
    const v = board[rr][cc];
    s += v === player ? 'X' : (v === rules.EMPTY ? '.' : '#');
  }
  return s;
}

/** 假设 player 落在 (r,c)，返回该点的棋型打分 */
function scorePoint(board, r, c, player) {
  const original = board[r][c];
  board[r][c] = player;
  let total = 0;
  let best = 0;
  let openThrees = 0;
  let fours = 0;
  const detail = [];
  for (let d = 0; d < rules.DIRECTIONS.length; d++) {
    const dr = rules.DIRECTIONS[d][0];
    const dc = rules.DIRECTIONS[d][1];
    const w = windowOf(board, r, c, player, dr, dc);
    let dirScore = 0;
    for (let p = 0; p < PATTERNS.length; p++) {
      if (PATTERNS[p].re.test(w)) { dirScore = PATTERNS[p].score; break; }
    }
    if (dirScore === SCORE.OPEN_THREE) openThrees++;
    if (dirScore === SCORE.FOUR || dirScore === SCORE.OPEN_FOUR) fours++;
    total += dirScore;
    if (dirScore > best) best = dirScore;
    detail.push({ dir: d, score: dirScore, window: w });
  }
  board[r][c] = original;
  // 双威胁加成
  let bonus = 0;
  if (fours >= 2) bonus += SCORE.OPEN_FOUR;
  else if (fours >= 1 && openThrees >= 1) bonus += SCORE.OPEN_THREE;
  else if (openThrees >= 2) bonus += SCORE.OPEN_THREE * 0.8;
  if (board[7][7] === rules.EMPTY) {
    const dist = Math.abs(r - 7) + Math.abs(c - 7);
    bonus += Math.max(0, 14 - dist) * 2;
  }
  return { total: total + bonus, best: best, openThrees: openThrees, fours: fours, detail: detail };
}

function candidates(board, limit) {
  const has = rules.moveCount(board) > 0;
  if (!has) return [[7, 7]];
  const pts = [];
  for (let r = 0; r < rules.SIZE; r++) {
    for (let c = 0; c < rules.SIZE; c++) {
      if (board[r][c] !== rules.EMPTY) continue;
      let near = false;
      for (let dr = -2; dr <= 2 && !near; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (!rules.inBounds(rr, cc)) continue;
          if (board[rr][cc] !== rules.EMPTY) { near = true; break; }
        }
      }
      if (near) pts.push([r, c]);
    }
  }
  if (pts.length <= limit) return pts;
  // 距离中心越近优先，保证候选集稳定
  pts.sort((a, b) => (Math.abs(a[0] - 7) + Math.abs(a[1] - 7)) - (Math.abs(b[0] - 7) + Math.abs(b[1] - 7)));
  return pts.slice(0, limit);
}

function findWinningMove(board, player, points) {
  for (const [r, c] of points) {
    const original = board[r][c];
    board[r][c] = player;
    const win = rules.findWinLine(board, r, c);
    board[r][c] = original;
    if (win) return [r, c];
  }
  return null;
}

/**
 * 计算一手棋。
 * @param {number[][]} board
 * @param {number} side 1=黑 2=白
 * @param {object} [opts] { level, onLog }
 * @returns {{move:number[], reasoning:string, meta:object}}
 */
function think(board, side, opts) {
  const options = opts || {};
  const level = LEVELS[options.level] || LEVELS[2];
  const log = typeof options.onLog === 'function' ? options.onLog : function () {};
  const opp = rules.opponent(side);
  const myName = rules.playerName(side);
  const lines = [];

  const pts = candidates(board, level.candidates);
  log('本地引擎（' + level.label + '）：扫描 ' + pts.length + ' 个候选点');
  lines.push('候选点 ' + pts.length + ' 个（沿已有棋子外扩 2 格）');

  // 1. 直接取胜
  const winNow = findWinningMove(board, side, pts);
  if (winNow) {
    lines.push('发现直接成五点 (' + winNow[0] + ',' + winNow[1] + ')，立即落子取胜。');
    return {
      move: winNow,
      reasoning: lines.join('\n'),
      meta: { kind: 'win', level: level.label }
    };
  }

  // 2. 必须封堵对手成五点
  const oppWin = findWinningMove(board, opp, pts);
  if (oppWin) {
    lines.push('对手（' + rules.playerName(opp) + '）在 (' + oppWin[0] + ',' + oppWin[1] + ') 有直接成五点，必须封堵。');
    return {
      move: oppWin,
      reasoning: lines.join('\n'),
      meta: { kind: 'block', level: level.label }
    };
  }

  // 3. 综合打分
  const scored = [];
  for (const [r, c] of pts) {
    const mine = scorePoint(board, r, c, side);
    const theirs = scorePoint(board, r, c, opp);
    const value = mine.total + theirs.total * 0.9;
    scored.push({ r, c, value, mine, theirs });
  }
  scored.sort((a, b) => b.value - a.value);

  // 4. 1 层预判：走完这步后，对手最强反击点有多强
  let pool = scored;
  if (level.lookahead > 0) {
    const top = scored.slice(0, level.lookahead);
    for (const cand of top) {
      const original = board[cand.r][cand.c];
      board[cand.r][cand.c] = side;
      let replyBest = 0;
      const replyPts = candidates(board, 30);
      for (const [rr, cc] of replyPts) {
        const s = scorePoint(board, rr, cc, opp);
        if (s.total > replyBest) replyBest = s.total;
      }
      board[cand.r][cand.c] = original;
      cand.reply = replyBest;
      cand.value = cand.value - replyBest * 0.85;
    }
    pool = top.concat(scored.slice(level.lookahead));
    pool.sort((a, b) => b.value - a.value);
  }

  const bestValue = pool[0] ? pool[0].value : 0;
  const jitterRange = Math.max(1, bestValue * level.jitter);
  const near = pool.filter((p) => p.value >= bestValue - jitterRange);
  const pick = near[Math.floor(Math.random() * near.length)] || pool[0] || { r: 7, c: 7, mine: { total: 0 } };

  lines.push('己方最强棋型分 ' + Math.round(pick.mine.total) +
    (pick.reply != null ? '，对手最佳反击分 ' + Math.round(pick.reply) : '') +
    '，最终选择 (' + pick.r + ',' + pick.c + ')。');
  if (pick.theirs.total >= SCORE.FOUR) lines.push('该点同时压制对手棋型，兼顾防守。');
  log('本地引擎落子：(' + pick.r + ',' + pick.c + ') 评分 ' + Math.round(pick.value));

  return {
    move: [pick.r, pick.c],
    reasoning: lines.join('\n'),
    meta: { kind: 'search', level: level.label, candidates: pts.length, score: Math.round(pick.value) }
  };
}

module.exports = { think, scorePoint, LEVELS, SCORE };

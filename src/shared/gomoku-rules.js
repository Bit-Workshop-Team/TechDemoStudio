/**
 * 五子棋规则内核（无禁手 / free-style）
 * 同时被主进程（require）与渲染进程（<script> 全局 GomokuRules）使用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GomokuRules = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SIZE = 15;
  var EMPTY = 0;
  var BLACK = 1;
  var WHITE = 2;
  var DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];

  function createBoard() {
    var board = new Array(SIZE);
    for (var r = 0; r < SIZE; r++) {
      board[r] = new Array(SIZE);
      for (var c = 0; c < SIZE; c++) board[r][c] = EMPTY;
    }
    return board;
  }

  function cloneBoard(board) {
    var out = new Array(SIZE);
    for (var r = 0; r < SIZE; r++) out[r] = board[r].slice();
    return out;
  }

  function inBounds(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  function opponent(player) {
    return player === BLACK ? WHITE : BLACK;
  }

  function playerName(player) {
    return player === BLACK ? '黑方' : '白方';
  }

  function playerLetter(player) {
    return player === BLACK ? 'B' : 'W';
  }

  function cellChar(value) {
    if (value === BLACK) return 'B';
    if (value === WHITE) return 'W';
    return '\u00b7';
  }

  /** 归一化任意来源的棋盘数据，保证是 15x15 的 0/1/2 整数矩阵 */
  function normalizeBoard(raw) {
    var board = createBoard();
    if (!raw) return board;
    for (var r = 0; r < SIZE; r++) {
      var row = raw[r];
      if (!row) continue;
      for (var c = 0; c < SIZE; c++) {
        var v = row[c];
        board[r][c] = (v === BLACK || v === WHITE) ? v : EMPTY;
      }
    }
    return board;
  }

  /** 带行号列号的棋盘文本，供模型阅读 */
  function boardToText(board) {
    var lines = [];
    var header = '   ';
    for (var c = 0; c < SIZE; c++) header += (c < 10 ? ' ' : '') + c + ' ';
    lines.push(header);
    for (var r = 0; r < SIZE; r++) {
      var line = (r < 10 ? ' ' : '') + r + ' ';
      for (var c2 = 0; c2 < SIZE; c2++) line += cellChar(board[r][c2]) + ' ';
      lines.push(line);
    }
    return lines.join('\n');
  }

  function isValidMove(board, r, c) {
    return Number.isInteger(r) && Number.isInteger(c) &&
      inBounds(r, c) && board[r][c] === EMPTY;
  }

  /**
   * 落子后判定胜负：返回获胜连线坐标数组（>=5 子），否则 null。
   * 只在 (r,c) 周围判定，效率足够且与"连成五子及以上即胜"一致。
   */
  function findWinLine(board, r, c) {
    var value = board[r][c];
    if (value !== BLACK && value !== WHITE) return null;
    for (var d = 0; d < DIRECTIONS.length; d++) {
      var dr = DIRECTIONS[d][0];
      var dc = DIRECTIONS[d][1];
      var cells = [[r, c]];
      var i, rr, cc;
      for (i = 1; i < SIZE; i++) {
        rr = r + dr * i; cc = c + dc * i;
        if (!inBounds(rr, cc) || board[rr][cc] !== value) break;
        cells.push([rr, cc]);
      }
      for (i = 1; i < SIZE; i++) {
        rr = r - dr * i; cc = c - dc * i;
        if (!inBounds(rr, cc) || board[rr][cc] !== value) break;
        cells.unshift([rr, cc]);
      }
      if (cells.length >= 5) return cells;
    }
    return null;
  }

  function isBoardFull(board) {
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        if (board[r][c] === EMPTY) return false;
      }
    }
    return true;
  }

  function moveCount(board) {
    var n = 0;
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) if (board[r][c] !== EMPTY) n++;
    }
    return n;
  }

  /** 全部空点 */
  function emptyPoints(board) {
    var pts = [];
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) if (board[r][c] === EMPTY) pts.push([r, c]);
    }
    return pts;
  }

  return {
    SIZE: SIZE,
    EMPTY: EMPTY,
    BLACK: BLACK,
    WHITE: WHITE,
    DIRECTIONS: DIRECTIONS,
    createBoard: createBoard,
    cloneBoard: cloneBoard,
    inBounds: inBounds,
    opponent: opponent,
    playerName: playerName,
    playerLetter: playerLetter,
    cellChar: cellChar,
    normalizeBoard: normalizeBoard,
    boardToText: boardToText,
    isValidMove: isValidMove,
    findWinLine: findWinLine,
    isBoardFull: isBoardFull,
    moveCount: moveCount,
    emptyPoints: emptyPoints
  };
});

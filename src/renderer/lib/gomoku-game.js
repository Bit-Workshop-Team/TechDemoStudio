/* 技术演示台 · 五子棋棋局状态（纯数据，无 UI） */
(function () {
  'use strict';

  var R = window.GomokuRules;

  function createGame() {
    var game = {
      board: R.createBoard(),
      turn: R.BLACK,
      history: [],
      winner: null,
      draw: false,
      startedAt: Date.now()
    };

    game.isOver = function () {
      return !!game.winner || game.draw;
    };

    game.moveNumber = function () {
      return game.history.length;
    };

    /** 落子；返回 {ok, reason} 或 {ok:true, record} */
    game.place = function (move, meta) {
      if (game.isOver()) return { ok: false, reason: '对局已结束' };
      if (!move || move.length < 2) return { ok: false, reason: '缺少落子坐标' };
      var r = Number(move[0]);
      var c = Number(move[1]);
      if (!R.inBounds(r, c)) return { ok: false, reason: '坐标越界 [' + r + ',' + c + ']' };
      if (!R.isValidMove(game.board, r, c)) return { ok: false, reason: '该点已有棋子 [' + r + ',' + c + ']' };

      var side = game.turn;
      var record = {
        index: game.history.length + 1,
        side: side,
        move: [r, c],
        reasoning: (meta && meta.reasoning) || '',
        raw: (meta && meta.raw) || '',
        engine: (meta && meta.engine) || 'human',
        model: (meta && meta.model) || '',
        attempts: (meta && meta.attempts) || 1,
        elapsedMs: (meta && meta.elapsedMs) || 0,
        usage: (meta && meta.usage) || null,
        forced: !!(meta && meta.forced),
        error: (meta && meta.error) || '',
        at: Date.now()
      };
      game.board[r][c] = side;
      game.history.push(record);

      var line = R.findWinLine(game.board, r, c);
      if (line) {
        game.winner = { side: side, line: line };
      } else if (R.isBoardFull(game.board)) {
        game.draw = true;
      } else {
        game.turn = R.opponent(side);
      }
      return { ok: true, record: record };
    };

    /** 悔一步：撤销最后一手 */
    game.undo = function () {
      var last = game.history.pop();
      if (!last) return null;
      game.board[last.move[0]][last.move[1]] = R.EMPTY;
      game.winner = null;
      game.draw = false;
      game.turn = last.side;
      return last;
    };

    game.reset = function () {
      game.board = R.createBoard();
      game.turn = R.BLACK;
      game.history = [];
      game.winner = null;
      game.draw = false;
      game.startedAt = Date.now();
      return game;
    };

    game.lastRecord = function () {
      return game.history.length ? game.history[game.history.length - 1] : null;
    };

    /** 最近一手的坐标数组列表（按落子顺序） */
    game.moveOrder = function () {
      return game.history.map(function (h) { return h.move; });
    };

    game.boardText = function () {
      return R.boardToText(game.board);
    };

    return game;
  }

  window.GomokuGame = { create: createGame };
})();

/* 技术演示台 · 棋盘绘制与交互（Canvas 2D） */
(function () {
  'use strict';

  var R = window.GomokuRules;
  var STAR_POINTS = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];
  var MAX_DPR = 2;

  function mount(canvas, options) {
    var opts = Object.assign({
      interactive: false,
      showNumbers: true,
      onCellClick: null,
      onHover: null
    }, options || {});

    var ctx = canvas.getContext('2d');
    var host = canvas.parentNode;
    var view = {
      board: R.createBoard(),
      numbers: {},
      lastMove: null,
      lastSide: R.EMPTY,
      winLine: null,
      hover: null,
      pending: null
    };
    var geom = { size: 0, margin: 0, cell: 0, pad: 0 };
    var raf = null;
    var dpr = 1;

    function layout() {
      var host = canvas.parentNode;                 // .board-shell
      var area = host.parentNode;                   // .board-area（棋盘 + 提示 + 挑战按钮）
      // 棋盘要减去同列其它元素（提示行、挑战按钮、错误面板）的高度，否则会把这些元素挤出可视区
      var reserved = 0;
      if (area) {
        for (var i = 0; i < area.children.length; i++) {
          var child = area.children[i];
          if (child === host) continue;
          reserved += child.offsetHeight + 10;      // 10px = .board-area 的行间距
        }
      }
      var availW = Math.max(220, (area && area.clientWidth) || host.clientWidth || 480);
      var availH = Math.max(220, ((area && area.clientHeight) || host.clientHeight || 480) - reserved - 8);
      // 给标题/提示留出空间，保持正方形
      var size = Math.floor(Math.min(availW - 6, availH - 6, 760));
      if (size < 220) size = 220;
      dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      geom.size = size;
      geom.margin = Math.round(size * 0.062);
      geom.pad = geom.margin;
      geom.cell = (size - geom.margin * 2) / (R.SIZE - 1);
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      canvas.style.width = size + 'px';
      canvas.style.height = size + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return geom;
    }

    function pos(row, col) {
      return { x: geom.margin + col * geom.cell, y: geom.margin + row * geom.cell };
    }

    function roundRect(c, x, y, w, h, r) {
      c.beginPath();
      c.moveTo(x + r, y);
      c.lineTo(x + w - r, y);
      c.quadraticCurveTo(x + w, y, x + w, y + r);
      c.lineTo(x + w, y + h - r);
      c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      c.lineTo(x + r, y + h);
      c.quadraticCurveTo(x, y + h, x, y + h - r);
      c.lineTo(x, y + r);
      c.quadraticCurveTo(x, y, x + r, y);
      c.closePath();
    }

    function drawBackground(c) {
      var g = c.createLinearGradient(0, 0, geom.size, geom.size);
      g.addColorStop(0, '#18232f');
      g.addColorStop(0.5, '#111a24');
      g.addColorStop(1, '#0c141d');
      c.fillStyle = g;
      roundRect(c, 0, 0, geom.size, geom.size, 12);
      c.fill();

      var halo = c.createRadialGradient(geom.size * 0.3, geom.size * 0.22, geom.size * 0.05, geom.size * 0.5, geom.size * 0.5, geom.size * 0.78);
      halo.addColorStop(0, 'rgba(216,174,98,0.10)');
      halo.addColorStop(1, 'rgba(216,174,98,0)');
      c.fillStyle = halo;
      c.fillRect(0, 0, geom.size, geom.size);

      c.strokeStyle = 'rgba(216,174,98,0.35)';
      c.lineWidth = 1;
      roundRect(c, 0.5, 0.5, geom.size - 1, geom.size - 1, 12);
      c.stroke();
    }

    function drawGrid(c) {
      var i, a, b;
      c.strokeStyle = 'rgba(216,174,98,0.26)';
      c.lineWidth = 1;
      c.beginPath();
      for (i = 0; i < R.SIZE; i++) {
        a = geom.margin;
        b = geom.size - geom.margin;
        var p = pos(i, i);
        // 横线
        c.moveTo(a, snap(p.y));
        c.lineTo(b, snap(p.y));
        // 竖线
        c.moveTo(snap(p.x), a);
        c.lineTo(snap(p.x), b);
      }
      c.stroke();

      // 外框加重
      c.strokeStyle = 'rgba(216,174,98,0.5)';
      c.lineWidth = 1.4;
      c.strokeRect(snap(geom.margin), snap(geom.margin), geom.size - geom.margin * 2, geom.size - geom.margin * 2);

      // 星位
      c.fillStyle = 'rgba(216,174,98,0.62)';
      STAR_POINTS.forEach(function (sp) {
        var q = pos(sp[0], sp[1]);
        c.beginPath();
        c.arc(q.x, q.y, Math.max(1.6, geom.cell * 0.075), 0, Math.PI * 2);
        c.fill();
      });
    }

    function snap(v) { return Math.round(v) + 0.5; }

    function drawCoords(c) {
      c.fillStyle = 'rgba(232,237,245,0.30)';
      c.font = Math.max(8, Math.round(geom.cell * 0.34)) + 'px Consolas, "Courier New", monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      var i, p;
      for (i = 0; i < R.SIZE; i++) {
        p = pos(0, i);
        c.fillText(String(i), p.x, geom.margin * 0.46);
        p = pos(i, 0);
        c.fillText(String(i), geom.margin * 0.46, p.y);
      }
    }

    function drawStone(c, row, col, side, opt) {
      var p = pos(row, col);
      var radius = geom.cell * 0.44;
      c.save();
      c.beginPath();
      c.arc(p.x, p.y + radius * 0.14, radius, 0, Math.PI * 2);
      c.fillStyle = 'rgba(0,0,0,0.38)';
      c.fill();

      var g = c.createRadialGradient(p.x - radius * 0.34, p.y - radius * 0.4, radius * 0.1, p.x, p.y, radius * 1.05);
      if (side === R.BLACK) {
        g.addColorStop(0, '#79818e');
        g.addColorStop(0.42, '#3a414c');
        g.addColorStop(1, '#080a0e');
        c.strokeStyle = 'rgba(255,255,255,0.10)';
      } else {
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.55, '#efeae0');
        g.addColorStop(1, '#c2bbac');
        c.strokeStyle = 'rgba(0,0,0,0.30)';
      }
      c.beginPath();
      c.arc(p.x, p.y, radius, 0, Math.PI * 2);
      c.fillStyle = g;
      c.fill();
      c.lineWidth = 1;
      c.stroke();

      if (opt && opt.number != null && opts.showNumbers) {
        c.fillStyle = side === R.BLACK ? 'rgba(255,255,255,0.82)' : 'rgba(20,24,30,0.78)';
        c.font = '600 ' + Math.max(8, Math.round(radius * 0.92)) + 'px Consolas, "Courier New", monospace';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(String(opt.number), p.x, p.y + 0.5);
      }
      c.restore();
    }

    function drawLastMarker(c, row, col, side) {
      var p = pos(row, col);
      var radius = geom.cell * 0.44;
      c.save();
      c.strokeStyle = side === R.BLACK ? 'rgba(89,165,255,0.95)' : 'rgba(216,174,98,0.95)';
      c.lineWidth = Math.max(1.3, geom.cell * 0.055);
      c.beginPath();
      c.arc(p.x, p.y, radius * 0.42, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }

    function drawWinLine(c, line) {
      if (!line || line.length < 2) return;
      var a = pos(line[0][0], line[0][1]);
      var b = pos(line[line.length - 1][0], line[line.length - 1][1]);
      c.save();
      c.strokeStyle = 'rgba(79,201,138,0.9)';
      c.lineWidth = Math.max(2.4, geom.cell * 0.11);
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.stroke();
      c.restore();
      line.forEach(function (pt) {
        var p = pos(pt[0], pt[1]);
        c.save();
        c.strokeStyle = 'rgba(79,201,138,0.95)';
        c.lineWidth = 2;
        c.beginPath();
        c.arc(p.x, p.y, geom.cell * 0.44 + 2, 0, Math.PI * 2);
        c.stroke();
        c.restore();
      });
    }

    function drawHover(c) {
      if (!view.hover) return;
      var row = view.hover[0];
      var col = view.hover[1];
      if (!R.isValidMove(view.board, row, col)) return;
      var p = pos(row, col);
      var radius = geom.cell * 0.44;
      c.save();
      c.setLineDash([4, 4]);
      c.strokeStyle = view.lastSide === R.WHITE ? 'rgba(216,174,98,0.75)' : 'rgba(89,165,255,0.75)';
      c.lineWidth = 1.3;
      c.beginPath();
      c.arc(p.x, p.y, radius, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }

    function render() {
      raf = null;
      var c = ctx;
      c.clearRect(0, 0, geom.size, geom.size);
      drawBackground(c);
      drawGrid(c);
      drawCoords(c);
      var row, col;
      for (row = 0; row < R.SIZE; row++) {
        for (col = 0; col < R.SIZE; col++) {
          var side = view.board[row][col];
          if (side !== R.EMPTY) {
            drawStone(c, row, col, side, { number: view.numbers[row + ',' + col] });
          }
        }
      }
      if (view.pending) {
        drawGhost(c, view.pending[0], view.pending[1]);
      }
      if (view.lastMove) drawLastMarker(c, view.lastMove[0], view.lastMove[1], view.lastSide);
      if (view.winLine) drawWinLine(c, view.winLine);
      drawHover(c);
    }

    function drawGhost(c, row, col) {
      var p = pos(row, col);
      var radius = geom.cell * 0.44;
      c.save();
      c.globalAlpha = 0.55;
      c.beginPath();
      c.arc(p.x, p.y, radius, 0, Math.PI * 2);
      c.fillStyle = '#e8edf5';
      c.fill();
      c.restore();
    }

    function invalidate() {
      if (raf == null) raf = window.requestAnimationFrame(render);
    }

    function pointFromEvent(event) {
      var rect = canvas.getBoundingClientRect();
      var x = (event.clientX - rect.left) * (geom.size / rect.width);
      var y = (event.clientY - rect.top) * (geom.size / rect.height);
      var col = Math.round((x - geom.margin) / geom.cell);
      var row = Math.round((y - geom.margin) / geom.cell);
      if (row < 0 || col < 0 || row >= R.SIZE || col >= R.SIZE) return null;
      var p = pos(row, col);
      var dist = Math.sqrt((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y));
      if (dist > geom.cell * 0.62) return null;
      return [row, col];
    }

    canvas.addEventListener('click', function (event) {
      if (!opts.interactive) return;
      var cell = pointFromEvent(event);
      if (cell && opts.onCellClick) opts.onCellClick(cell[0], cell[1]);
    });

    canvas.addEventListener('mousemove', function (event) {
      var cell = pointFromEvent(event);
      var changed = String(cell) !== String(view.hover);
      view.hover = cell;
      canvas.style.cursor = cell ? 'pointer' : 'default';
      if (changed) {
        if (opts.onHover) opts.onHover(cell);
        invalidate();
      }
    });

    canvas.addEventListener('mouseleave', function () {
      if (view.hover) {
        view.hover = null;
        invalidate();
      }
    });

    var api = {
      setBoard: function (board, extra) {
        view.board = board;
        if (extra) {
          if ('lastMove' in extra) view.lastMove = extra.lastMove;
          if ('lastSide' in extra) view.lastSide = extra.lastSide;
          if ('winLine' in extra) view.winLine = extra.winLine;
          if ('order' in extra) {
            var map = {};
            (extra.order || []).forEach(function (mv, i) { map[mv[0] + ',' + mv[1]] = i + 1; });
            view.numbers = map;
          }
        }
        invalidate();
      },
      setLastMove: function (move, side, winLine, order) {
        view.lastMove = move || null;
        view.lastSide = side || R.EMPTY;
        view.winLine = winLine || null;
        if (order) {
          var map = {};
          order.forEach(function (mv, i) { map[mv[0] + ',' + mv[1]] = i + 1; });
          view.numbers = map;
        }
        invalidate();
      },
      setPending: function (move) {
        view.pending = move || null;
        invalidate();
      },
      setInteractive: function (flag) {
        opts.interactive = !!flag;
        invalidate();
      },
      isInteractive: function () { return !!opts.interactive; },
      setShowNumbers: function (flag) {
        opts.showNumbers = !!flag;
        invalidate();
      },
      geometry: function () { return geom; },
      resize: function () { layout(); invalidate(); },
      redraw: invalidate
    };

    layout();
    invalidate();
    return api;
  }

  window.BoardRenderer = { mount: mount };
})();

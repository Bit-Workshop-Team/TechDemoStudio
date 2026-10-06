/* 技术演示台 · AI 五子棋演示（双 AI 对弈 / 手动接管 / 暗码锁定） */
(function () {
  'use strict';

  var UI = window.UI;
  var R = window.GomokuRules;

  var state = {
    active: false,
    mode: null,          // 目前只有 'gomoku'
    paused: false,
    humanSide: null,     // 人机对战时由人接管的一方（R.BLACK / R.WHITE），null = 双 AI
    humanBackup: null,   // 接管前的引擎类型，交还时还原
    loopRunning: false,
    loopRequested: false,
    awaiting: false,
    currentRequestId: null,
    seq: 0,
    pace: 600,
    cfg: null,
    engines: { black: 'local', white: 'local' },
    forced: { black: null, white: null },
    viewingIndex: null,
    showNumbers: true,
    showLockHint: true,
    fallbackTimer: null,
    autoNextTimer: null,
    autoNextTick: null,
    score: { black: 0, white: 0, draw: 0 },   // 本轮演示的实时比分（进入演示模式时归零）
    gameScored: false,                        // 当前这局是否已经计过分，避免重复累加
    board: null
  };

  var game = null;
  var renderer = null;
  var P = {};
  var el = {};
  var unsubs = [];
  var info = null;

  // 棋盘下方的挑战按钮文案（接管 / 交还两态）
  var CHALLENGE_ON = '我要挑战deepseek！';
  var CHALLENGE_OFF = '交还引擎（AI 接管）';
  // 一局结束后的自动续场倒计时（无人操作时到点自动开下一局）
  var AUTO_NEXT_MS = 10000;

  function $(id) { return document.getElementById(id); }

  function sideKey(side) { return side === R.WHITE ? 'white' : 'black'; }
  function sideName(side) { return side === R.BLACK ? '黑方' : '白方'; }

  // ------------------------------------------------------------------ 视图切换
  function showView(name) {
    ['view-settings', 'view-demo'].forEach(function (id) {
      var node = $(id);
      if (node) node.classList.toggle('active', id === 'view-' + name);
    });
  }

  // ------------------------------------------------------------------ 面板
  function setupPanels() {
    ['black', 'white'].forEach(function (key) {
      var root = $('panel-' + key);
      var raw = UI.el('div', { class: 'reasoning-raw' });
      raw.style.display = 'none';
      root.querySelector('.sp-body').appendChild(raw);
      P[key] = {
        root: root,
        badge: $(key + '-engine-badge'),
        model: $(key + '-panel-model'),
        dot: $(key + '-panel-dot'),
        stateText: $(key + '-panel-state'),
        reasoning: $(key + '-reasoning'),
        raw: raw,
        meta: $(key + '-panel-meta'),
        usage: $(key + '-panel-usage')
      };
    });
  }

  function setReasoning(key, text, emptyText) {
    resetStream();
    var p = P[key];
    p.reasoning.textContent = text || (emptyText || '等待中…');
    p.reasoning.classList.toggle('empty', !text);
    var body = p.root.querySelector('.sp-body');
    if (text) body.scrollTop = body.scrollHeight;
  }

  function setRaw(key, content, reasoning) {
    var p = P[key];
    var text = '';
    if (content) text += '模型原始回复：\n' + content;
    if (!content && reasoning) text += '完整思考文本：\n' + reasoning;
    p.raw.textContent = text;
    p.raw.style.display = text ? '' : 'none';
  }

  function setSideState(key, text, dotClass) {
    P[key].stateText.textContent = text;
    P[key].dot.className = 'dot ' + (dotClass || 'idle');
  }

  // ---------------------------------------------------------------- 流式渲染节流
  // 模型每秒可能推送几十个增量，若每个增量都写 DOM 会持续重排导致卡顿。
  // 这里把增量攒起来，最多每 STREAM_FLUSH_MS 写一次，并限制单面板最大文本长度。
  var STREAM_FLUSH_MS = 90;
  var RAW_FLUSH_MS = 320;
  var MAX_REASONING_CHARS = 14000;
  var stream = { key: null, text: '', raw: '', pending: false, timer: 0, lastFlush: 0, lastRawFlush: 0 };

  function resetStream() {
    if (stream.timer) clearTimeout(stream.timer);
    stream.key = null;
    stream.text = '';
    stream.raw = '';
    stream.pending = false;
    stream.timer = 0;
  }

  function streamPush(key, text, rawContent) {
    if (stream.key !== key) {
      resetStream();
      stream.key = key;
    }
    stream.text = text || '';
    if (rawContent) stream.raw = rawContent;
    if (stream.pending) return;
    stream.pending = true;
    var wait = Math.max(0, STREAM_FLUSH_MS - (Date.now() - stream.lastFlush));
    stream.timer = setTimeout(flushStream, wait);
  }

  function flushStream() {
    stream.pending = false;
    stream.timer = 0;
    stream.lastFlush = Date.now();
    var key = stream.key;
    if (!key || !P[key]) return;
    var p = P[key];
    var text = stream.text || '';
    if (text.length > MAX_REASONING_CHARS) {
      text = '……（思考过长，仅显示最后 ' + MAX_REASONING_CHARS + ' 字）\n\n' + text.slice(-MAX_REASONING_CHARS);
    }
    if (p.reasoning.textContent !== text) {
      p.reasoning.textContent = text;
      p.reasoning.classList.toggle('empty', !text);
    }
    var now = Date.now();
    if (stream.raw && now - stream.lastRawFlush > RAW_FLUSH_MS) {
      stream.lastRawFlush = now;
      setRaw(key, stream.raw, '');
    }
    var body = p.root.querySelector('.sp-body');
    if (body) body.scrollTop = body.scrollHeight;
  }

  function setSideMeta(key, text) { P[key].meta.textContent = text || '--'; }
  function setSideUsage(key, text) { P[key].usage.textContent = text || ''; }

  function engineLabel(key) {
    if (state.engines[key] === 'human') return '人类棋手（你）';
    if (state.forced[key]) return '内置本地引擎（已降级）';
    return state.engines[key] === 'local' ? '内置本地引擎' : '大模型 API';
  }

  function modelLabel(key) {
    if (state.engines[key] === 'human') {
      return '由你在棋盘上落子 · 对手：' + engineLabel(key === 'black' ? 'white' : 'black');
    }
    if (state.engines[key] === 'local' || state.forced[key]) {
      return '本地启发式引擎 · 棋力 ' + ((state.cfg && state.cfg.local.level) || 2);
    }
    return (state.cfg && state.cfg[key].model) || '--';
  }

  function refreshEngineBadges() {
    ['black', 'white'].forEach(function (key) {
      var label = engineLabel(key);
      P[key].badge.textContent = label;
      P[key].badge.className = 'badge ' + (label.indexOf('本地') === 0 ? 'badge-planned' : (label.indexOf('人类') === 0 ? 'badge-ready' : 'badge-gold'));
      P[key].model.textContent = modelLabel(key);
    });
  }

  // ------------------------------------------------------------------ 棋盘
  function renderBoard() {
    if (!renderer) return;
    renderer.setBoard(game.board, {
      lastMove: game.lastRecord() ? game.lastRecord().move : null,
      lastSide: game.lastRecord() ? game.lastRecord().side : R.EMPTY,
      winLine: game.winner ? game.winner.line : null,
      order: game.moveOrder()
    });
  }

  // ------------------------------------------------------------------ 落子记录
  function renderMoves() {
    UI.clear(el.moves);
    game.history.forEach(function (rec, i) {
      el.moves.appendChild(UI.el('span', {
        class: 'move-tag ' + (rec.side === R.BLACK ? 'black' : 'white') + (state.viewingIndex === i ? ' on' : ''),
        title: '第 ' + rec.index + ' 手 · ' + (rec.engine === 'human' ? '人工落子' : (rec.engine === 'local' ? '本地引擎' : rec.model || 'API')) + ' · ' + UI.coordLabel(rec.move),
        onclick: function () { showRecord(i); }
      }, [
        UI.el('span', { text: rec.index + ' ' + (rec.side === R.BLACK ? '●' : '○') + UI.coordLabel(rec.move) })
      ]));
    });
    el.moves.scrollTop = el.moves.scrollHeight;
  }

  function showRecord(index) {
    if (index === state.viewingIndex) {
      state.viewingIndex = null;
      renderPanelsFromHistory();
      setPhase('实时进行中');
      renderMoves();
      return;
    }
    var rec = game.history[index];
    if (!rec) return;
    state.viewingIndex = index;
    var key = sideKey(rec.side);
    setReasoning(key, rec.reasoning, '（该手没有返回思考文本）');
    setRaw(key, rec.raw, rec.reasoning);
    setSideState(key, '回放第 ' + rec.index + ' 手', 'done');
    setSideMeta(key, '第 ' + rec.index + ' 手 ' + UI.coordLabel(rec.move) + ' · ' + (rec.elapsedMs ? UI.fmtDuration(rec.elapsedMs) : '瞬时'));
    setSideUsage(key, rec.usage && rec.usage.total_tokens ? rec.usage.total_tokens + ' tokens' : '');
    setPhase('正在回放第 ' + rec.index + ' 手 · 再次点击该手数回到实时');
    renderMoves();
  }

  function renderPanelsFromHistory() {
    var keys = ['black', 'white'];
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var side = key === 'black' ? R.BLACK : R.WHITE;
      var rec = null;
      for (var i = game.history.length - 1; i >= 0; i--) {
        if (game.history[i].side === side) { rec = game.history[i]; break; }
      }
      if (!rec) {
        setReasoning(key, '', '等待' + sideName(side) + '落子…');
        setRaw(key, '', '');
        setSideState(key, '待机', 'idle');
        setSideMeta(key, '--');
        setSideUsage(key, '');
        continue;
      }
      setReasoning(key, rec.reasoning, '（该手没有返回思考文本）');
      setRaw(key, rec.raw, rec.reasoning);
      setSideState(key, '已落子 ' + UI.coordLabel(rec.move), 'done');
      setSideMeta(
        key,
        '第 ' + rec.index + ' 手 · ' + UI.coordLabel(rec.move) +
        (rec.elapsedMs ? ' · ' + UI.fmtDuration(rec.elapsedMs) : '') +
        (rec.attempts > 1 ? ' · ' + rec.attempts + ' 次尝试' : '')
      );
      setSideUsage(key, rec.usage && rec.usage.total_tokens ? rec.usage.total_tokens + ' tokens' : '');
    }
  }

  function setPhase(text) { el.phase.textContent = text; }

  function updateLastMoveChip() {
    var rec = game.lastRecord();
    el.lastMove.textContent = rec
      ? '最新落子 ' + (rec.side === R.BLACK ? '●' : '○') + UI.coordLabel(rec.move) + ' · 第 ' + rec.index + ' 手'
      : '最新落子 --';
  }

  // ------------------------------------------------------------------ 提示与错误
  function showBanner(title, sub) {
    el.bannerTitle.textContent = title;
    el.bannerSub.textContent = sub || '';
    el.banner.classList.add('show');
  }

  function hideBanner() {
    el.banner.classList.remove('show');
    clearAutoNext();
  }

  // ---- 一局结束后的自动续场：10 秒内没有任何操作就自动开下一局
  function clearAutoNext() {
    if (state.autoNextTimer) { clearTimeout(state.autoNextTimer); state.autoNextTimer = null; }
    if (state.autoNextTick) { clearInterval(state.autoNextTick); state.autoNextTick = null; }
    if (el.bannerCountdown) {
      el.bannerCountdown.classList.add('hidden');
      el.bannerCountdown.textContent = '';
    }
  }

  function scheduleAutoNext() {
    clearAutoNext();
    if (!state.active || !el.bannerCountdown) return;
    var left = Math.round(AUTO_NEXT_MS / 1000);
    el.bannerCountdown.classList.remove('hidden');
    el.bannerCountdown.innerHTML = '';
    el.bannerCountdown.appendChild(UI.el('span', { text: '本局结束后 ' }));
    el.bannerCountdown.appendChild(UI.el('b', { text: String(left) }));
    el.bannerCountdown.appendChild(UI.el('span', { text: ' 秒自动开始下一局，点击「再来一局」立即开始' }));
    state.autoNextTick = setInterval(function () {
      var b = el.bannerCountdown && el.bannerCountdown.querySelector('b');
      if (!b) return;
      left = Math.max(0, left - 1);
      b.textContent = String(left);
    }, 1000);
    state.autoNextTimer = setTimeout(function () {
      clearAutoNext();
      if (state.active) {
        UI.toast('本局结束已 10 秒，自动开始下一局', 'info');
        restart();
      }
    }, AUTO_NEXT_MS);
  }

  function showError(text, actions) {
    el.errorText.textContent = text;
    UI.clear(el.errorActions);
    (actions || []).forEach(function (a) {
      el.errorActions.appendChild(UI.el('button', {
        class: 'btn btn-sm ' + (a.primary ? 'btn-primary' : 'btn-ghost'),
        type: 'button',
        text: a.label,
        onclick: a.action
      }));
    });
    el.error.classList.add('show');
  }

  function clearError() {
    el.error.classList.remove('show');
    UI.clear(el.errorActions);
  }

  // ------------------------------------------------------------------ 主循环
  function applyFallback(key) {
    if (state.forced[key] === 'local') return;
    state.forced[key] = 'local';
    clearTimeout(state.fallbackTimer);
    refreshEngineBadges();
    clearError();
    scheduleLoop();
  }

  // ------------------------------------------------------------------ 实时比分
  function renderScore() {
    if (!el.scoreBoard) return;
    var s = state.score || { black: 0, white: 0, draw: 0 };
    el.scoreBlack.textContent = String(s.black);
    el.scoreWhite.textContent = String(s.white);
    el.scoreDraw.textContent = String(s.draw);
    el.scoreBoard.classList.toggle('lead-black', s.black > s.white);
    el.scoreBoard.classList.toggle('lead-white', s.white > s.black);
  }

  /** info: { winnerSide, draw }；sign 为 +1（计分）或 -1（撤销已结束的对局时回退） */
  function scoreAdjust(info, sign) {
    if (!info || !state.score) return;
    if (info.winnerSide === R.BLACK) state.score.black = Math.max(0, state.score.black + sign);
    else if (info.winnerSide === R.WHITE) state.score.white = Math.max(0, state.score.white + sign);
    else if (info.draw) state.score.draw = Math.max(0, state.score.draw + sign);
    renderScore();
  }

  function currentResultInfo() {
    return { winnerSide: (game && game.winner) ? game.winner.side : null, draw: !!(game && game.draw) };
  }

  function finishGame() {
    if (!state.gameScored) {
      state.gameScored = true;
      scoreAdjust(currentResultInfo(), 1);
    }
    if (game.winner) {
      var rec = game.lastRecord();
      showBanner(
        sideName(game.winner.side) + ' 五子连珠',
        '第 ' + rec.index + ' 手 ' + UI.coordLabel(rec.move) + ' 达成五连 · 共 ' + game.history.length + ' 手'
      );
      setPhase(sideName(game.winner.side) + '胜');
    } else if (game.draw) {
      showBanner('本局和棋', '棋盘已满，双方均未连成五子');
      setPhase('和棋');
    }
    setSideState('black', game.winner && game.winner.side === R.BLACK ? '胜' : '结束', game.winner && game.winner.side === R.BLACK ? 'done' : 'idle');
    setSideState('white', game.winner && game.winner.side === R.WHITE ? '胜' : '结束', game.winner && game.winner.side === R.WHITE ? 'done' : 'idle');
    setInteractive(false);
    scheduleAutoNext();   // 10 秒内无人操作就自动开下一局
  }

  function afterMove(record, meta) {
    state.viewingIndex = null;
    clearError();
    renderBoard();
    renderMoves();
    updateLastMoveChip();
    renderPanelsFromHistory();
    if (game.isOver()) {
      finishGame();
      return;
    }
    updateInteractive();
    markHumanTurn({ phase: false });
    setPhase(sideName((record && record.side) || (game.turn === R.BLACK ? R.WHITE : R.BLACK)) + '落子完成 · 轮到' + sideName(game.turn) + (humanTurn() ? '（你）' : ''));
  }

  /**
   * 主循环只在「轮到 AI」时运转，轮到人类的一方会直接退出循环。
   * 退出后必须由这里把面板状态 / 提示 / 可交互状态标出来，否则人下完一手后界面会一直停在“对方思考中”。
   */
  function markHumanTurn(opt) {
    if (!state.active || state.paused || !state.humanSide || game.isOver()) return;
    if (game.turn !== state.humanSide) return;
    setSideState(sideKey(state.humanSide), '等你落子', 'done');
    if (!opt || opt.phase !== false) setPhase('轮到你落子（' + sideName(state.humanSide) + '）');
    updateInteractive();
  }

  function handleFailure(key, side, res) {
    var msg = res.error || '未知错误';
    setSideState(key, '请求失败', 'error');
    setRaw(key, res.raw, res.reasoning);
    if (res.reasoning) setReasoning(key, res.reasoning);
    setPhase(sideName(side) + '引擎出错');
    showError('「' + sideName(side) + '」引擎出错：' + msg, [
      { label: '改用本地引擎继续', primary: true, action: function () { applyFallback(key); } },
      { label: '重试这一步', action: function () { clearTimeout(state.fallbackTimer); clearError(); scheduleLoop(); } },
      { label: '暂停', action: function () { clearTimeout(state.fallbackTimer); clearError(); setPaused(true); } }
    ]);
    clearTimeout(state.fallbackTimer);
    state.fallbackTimer = setTimeout(function () {
      if (state.active && !game.isOver() && !state.forced[key] && !state.paused) {
        applyFallback(key);
        UI.toast(sideName(side) + ' 已自动切换到内置本地引擎，演示继续', 'info', 5000);
      }
    }, 2600);
  }

  function step() {
    return new Promise(function (resolve) {
      if (!state.active || game.isOver()) return resolve('stop');
      var side = game.turn;
      var key = sideKey(side);
      // 人机对战时人类一方不发起引擎请求，等操作者点棋盘
      if (state.humanSide === side) {
        markHumanTurn();
        return resolve('stop');
      }
      var engine = state.forced[key] || state.engines[key];
      var requestId = 'move-' + (++state.seq) + '-' + key;
      var t0 = Date.now();

      state.currentRequestId = requestId;
      state.awaiting = true;
      state.viewingIndex = null;
      setInteractive(false);
      setSideState(key, engine === 'local' ? '本地引擎思考中…' : '等待模型返回…', 'thinking');
      setPhase(sideName(side) + '思考中');
      setReasoning(key, '', engine === 'local' ? '本地引擎正在计算…' : '正在请求模型…');
      setRaw(key, '', '');
      setSideMeta(key, '--');
      setSideUsage(key, '');

      // 流式增量由 onDelta 写入对应面板
      window.demoAPI.gomoku.move({
        board: game.board,
        side: side,
        requestId: requestId,
        forceEngine: state.forced[key] || null
      }).then(function (res) {
        if (state.currentRequestId !== requestId) return resolve('stop');
        state.currentRequestId = null;
        state.awaiting = false;
        if (!state.active) return resolve('stop');
        if (res && res.cancelled) {
          setSideState(key, '已中断', 'idle');
          return resolve('stop');
        }
        if (res && res.ok && res.draw) {
          game.draw = true;
          setSideState(key, '提议和棋', 'done');
          afterMove(null, res);
          return resolve('stop');
        }
        if (res && res.ok && res.move) {
          var placed = game.place(res.move, Object.assign({}, res, { elapsedMs: res.elapsedMs || (Date.now() - t0) }));
          if (!placed.ok) {
            handleFailure(key, side, { error: '引擎给出的落点无效：' + placed.reason, code: 'BAD_MOVE' });
            return resolve('stop');
          }
          afterMove(placed.record, res);
          return resolve('continue');
        }
        handleFailure(key, side, res || { error: '主进程未返回结果' });
        resolve('stop');
      }).catch(function (err) {
        state.currentRequestId = null;
        state.awaiting = false;
        handleFailure(key, side, { error: (err && err.message) || String(err), code: 'IPC_ERROR' });
        resolve('stop');
      });
    });
  }

  function shouldRun() {
    return state.active && !state.paused && !game.isOver() && game.turn !== state.humanSide;
  }

  /** 需要时重启主循环；正在跑就登记一次重跑（避免“重启后没人落子”） */
  function scheduleLoop() {
    if (state.loopRunning) { state.loopRequested = true; return; }
    runLoop();
  }

  async function runLoop() {
    if (state.loopRunning) return;
    if (!shouldRun()) return;
    state.loopRunning = true;
    try {
      while (shouldRun()) {
        var verdict = await step();
        if (verdict === 'stop') break;
        if (!shouldRun()) break;
        await UI.delay(state.pace);
      }
    } finally {
      state.loopRunning = false;
      // 循环因为「轮到人类」而退出时，把该有的提示补上
      markHumanTurn();
      if (state.loopRequested) {
        state.loopRequested = false;
        if (shouldRun()) runLoop();
      }
    }
  }

  // ------------------------------------------------------------------ 交互
  function humanTurn() {
    return !!state.humanSide && !!game && !game.isOver() && game.turn === state.humanSide;
  }

  function setInteractive(flag) {
    if (!renderer) return;
    renderer.setInteractive(!!flag);
    el.hint.textContent = flag
      ? (humanTurn()
        ? '人机对战：点击空交叉点为「' + sideName(state.humanSide) + '」落子'
        : '已暂停：点击空交叉点可代为落子')
      : (game && game.isOver() ? '本局已结束' : '15 × 15 棋盘 · 无禁手 · 五子连珠即胜 · 点击手数可回看思考过程');
  }

  function updateInteractive() {
    setInteractive(state.paused || humanTurn());
  }

  function setPaused(flag) {
    state.paused = !!flag;
    if (state.paused) clearAutoNext();   // 人为暂停视为操作，不再自动续场
    el.pause.textContent = state.paused ? '继续' : '暂停';
    el.pause.classList.toggle('on', state.paused);
    if (state.paused) {
      if (state.currentRequestId) window.demoAPI.gomoku.cancel(state.currentRequestId);
      setPhase('已暂停');
    } else if (state.active && !game.isOver()) {
      setPhase('继续演示');
      scheduleLoop();
      markHumanTurn();
    }
    updateInteractive();
  }

  /** 挑选被人类接管的一方：优先接管正在使用「内置本地引擎」的一方，由人带着机器对阵大模型 */
  function pickHumanSide() {
    var keys = ['white', 'black'];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if ((state.forced[key] || state.engines[key]) === 'local') return key === 'white' ? R.WHITE : R.BLACK;
    }
    return R.WHITE;
  }

  function setHuman(flag) {
    if (flag === !!state.humanSide) return;
    clearAutoNext();   // 接管 / 交还都是人为操作，取消自动续场
    if (flag) {
      var side = pickHumanSide();
      var key = sideKey(side);
      state.humanSide = side;
      state.humanBackup = state.engines[key];
      state.engines[key] = 'human';
      state.forced[key] = null;
      if (state.currentRequestId && state.currentRequestId.slice(-key.length - 1) === '-' + key) {
        window.demoAPI.gomoku.cancel(state.currentRequestId);
      }
      el.manual.classList.add('on');
      el.manual.textContent = CHALLENGE_OFF;
      refreshEngineBadges();
      if (game && !game.isOver() && game.turn === side) {
        setReasoning(key, '人机对战：你已接管「' + sideName(side) + '」，请在棋盘上点击空交叉点落子。对手是' + engineLabel(key === 'black' ? 'white' : 'black') + '。');
        markHumanTurn();
      } else {
        setPhase('已接管' + sideName(side) + '，对手落子后轮到你');
      }
      UI.toast('你已接管' + sideName(side) + '，与大模型对抗；再次点击该按钮交还引擎', 'info', 4600);
      scheduleLoop();
    } else {
      var wasSide = state.humanSide;
      var wasKey = sideKey(wasSide);
      state.engines[wasKey] = state.humanBackup || 'local';
      state.humanSide = null;
      state.humanBackup = null;
      el.manual.classList.remove('on');
      el.manual.textContent = CHALLENGE_ON;
      refreshEngineBadges();
      setSideState(wasKey, '引擎接管', 'idle');
      setReasoning(wasKey, '', '等待' + sideName(wasSide) + '落子…');
      setPhase('引擎已接管' + sideName(wasSide));
      scheduleLoop();
    }
    updateInteractive();
  }

  function onCellClick(row, col) {
    clearAutoNext();
    if (!state.active || game.isOver()) return;
    if (!(state.paused || humanTurn())) {
      UI.toast('当前不是你的回合：点击「我要挑战deepseek！」可接管一方', 'info');
      return;
    }
    var placed = game.place([row, col], { engine: 'human', reasoning: '人机对战：由操作者在演示现场直接点选。' });
    if (!placed.ok) { UI.toast(placed.reason, 'error'); return; }
    afterMove(placed.record, { engine: 'human' });
    setPhase('人工落子 ' + UI.coordLabel([row, col]));
    // 人落子后必须把主循环叫醒，否则轮到 AI 的那一方会一直停在“等待”状态
    scheduleLoop();
  }

  function restart() {
    if (state.currentRequestId) window.demoAPI.gomoku.cancel(state.currentRequestId);
    clearTimeout(state.fallbackTimer);
    game.reset();
    state.viewingIndex = null;
    state.gameScored = false;
    hideBanner();
    clearError();
    renderBoard();
    renderMoves();
    updateLastMoveChip();
    renderPanelsFromHistory();
    setPhase('新对局开始');
    setSideState('black', '待机', 'idle');
    setSideState('white', '待机', 'idle');
    updateInteractive();
    scheduleLoop();
  }

  function undo() {
    if (state.currentRequestId) window.demoAPI.gomoku.cancel(state.currentRequestId);
    clearTimeout(state.fallbackTimer);
    // 撤销的若是刚刚分出胜负的那一局，比分要跟着回退（悔棋时棋局不再结束）
    var wasScored = state.gameScored;
    var scoredInfo = currentResultInfo();
    var removed = game.undo();
    if (!removed) { UI.toast('没有可撤销的落子', 'info'); return; }
    if (wasScored) {
      state.gameScored = false;
      scoreAdjust(scoredInfo, -1);
    }
    hideBanner();
    clearError();
    state.viewingIndex = null;
    renderBoard();
    renderMoves();
    updateLastMoveChip();
    renderPanelsFromHistory();
    setPhase('已撤销第 ' + removed.index + ' 手 · 轮到' + sideName(game.turn));
    updateInteractive();
    scheduleLoop();
  }

  // ------------------------------------------------------------------ 暗码提示
  function setupLockHint(length, show) {
    var total = length || 6;
    state.showLockHint = show !== false;
    UI.clear(el.lockKeys);
    for (var i = 0; i < total; i++) el.lockKeys.appendChild(UI.el('i'));
    el.lockBadge.style.display = '';
    el.lockKeys.style.display = show === false ? 'none' : '';
    el.lockText.textContent = show === false ? '演示锁定中' : '演示锁定中 · 连续输入暗码退出';
  }

  function updateKeyProgress(length) {
    var dots = el.lockKeys.querySelectorAll('i');
    for (var i = 0; i < dots.length; i++) {
      dots[i].className = i < length ? 'on' : '';
    }
  }

  var wrongTimer = null;
  var lastWrongToastAt = 0;

  /** 暗码输错时的反馈：抖动 + 红点 + 文案 + toast，若配置了隐藏按键提示也不泄露暗码内容 */
  function flashWrongCode() {
    var badge = el.lockBadge;
    badge.classList.remove('wrong');
    void badge.offsetWidth;      // 触发重排以便重放动画
    badge.classList.add('wrong');
    var dots = el.lockKeys.querySelectorAll('i');
    for (var i = 0; i < dots.length; i++) dots[i].className = 'bad';
    if (el.lockText) el.lockText.textContent = '暗码错误 · 已重置，请重新输入';
    if (Date.now() - lastWrongToastAt > 2200) {
      lastWrongToastAt = Date.now();
      UI.toast('退出暗码输入错误，连续输入正确的暗码即可退出全屏', 'error', 2600);
    }
    clearTimeout(wrongTimer);
    wrongTimer = setTimeout(function () {
      badge.classList.remove('wrong');
      if (el.lockText) {
        el.lockText.textContent = state.showLockHint === false ? '演示锁定中' : '演示锁定中 · 连续输入暗码退出';
      }
      updateKeyProgress(0);
    }, 1700);
  }

  // ------------------------------------------------------------------ 启动 / 停止
  function start(boardId) {
    return window.demoAPI.config.get().then(function (cfg) {
      state.cfg = cfg;
      state.engines = { black: cfg.black.engine, white: cfg.white.engine };
      state.forced = { black: null, white: null };
      state.pace = cfg.demo.stepDelayMs;
      state.paused = false;
      state.humanSide = null;
      state.humanBackup = null;
      state.viewingIndex = null;
      state.active = true;
      state.score = { black: 0, white: 0, draw: 0 };
      state.gameScored = false;
      renderScore();
      state.showLockHint = !!cfg.demo.showLockHint;

      el.pause.textContent = '暂停';
      el.pause.classList.remove('on');
      el.manual.textContent = CHALLENGE_ON;
      el.manual.classList.remove('on');
      el.pace.value = String(state.pace);
      el.paceLabel.textContent = UI.fmtDuration(state.pace);
      setupLockHint(cfg.demo.exitCode.length, cfg.demo.showLockHint);
      updateKeyProgress(0);
      hideBanner();
      clearError();
      refreshEngineBadges();

      var board = (info && info.boards || []).filter(function (b) { return b.id === boardId; })[0];

      // 目前只实现了 gomoku 一个板块；目录里没有的 id 一律拒绝，不再有占位页
      if (boardId !== 'gomoku') {
        state.active = false;
        showView('settings');
        UI.toast('未知板块：' + boardId + '（当前只实现了 AI 五子棋）', 'error', 4200);
        return { ok: false, error: '未知板块：' + boardId };
      }

      state.mode = 'gomoku';
      showView('demo');
      el.title.textContent = (board && board.name) || 'AI 五子棋';
      el.subtitle.textContent = (board && board.subtitle) || 'TECH DEMO';

      game.reset();
      renderBoard();
      renderMoves();
      updateLastMoveChip();
      renderPanelsFromHistory();
      setInteractive(false);
      setPhase('准备开始');

      return new Promise(function (resolve) {
        window.requestAnimationFrame(function () {
          if (renderer) {
            renderer.resize();
            renderer.setShowNumbers(state.showNumbers);
          }
          scheduleLoop();
          resolve({ ok: true, mode: 'gomoku' });
        });
      });
    });
  }

  function stop() {
    state.active = false;
    state.paused = false;
    state.humanSide = null;
    state.humanBackup = null;
    resetStream();
    clearTimeout(state.fallbackTimer);
    clearAutoNext();
    hideBanner();
    if (state.currentRequestId) {
      window.demoAPI.gomoku.cancel(state.currentRequestId);
      state.currentRequestId = null;
    }
    updateKeyProgress(0);
    showView('settings');
    if (window.Settings && window.Settings.refreshNotes) window.Settings.refreshNotes();
  }

  // ------------------------------------------------------------------ 初始化
  function init(options) {
    info = (options && options.info) || {};
    el = {
      title: $('demo-title'),
      subtitle: $('demo-subtitle'),
      phase: $('demo-phase'),
      lastMove: $('demo-last-move'),
      hint: $('board-hint'),
      scoreBoard: $('demo-score'),
      scoreBlack: $('score-black'),
      scoreWhite: $('score-white'),
      scoreDraw: $('score-draw'),
      banner: $('board-banner'),
      bannerTitle: $('banner-title'),
      bannerSub: $('banner-sub'),
      bannerCountdown: $('banner-countdown'),
      error: $('demo-error'),
      errorText: $('demo-error-text'),
      errorActions: $('demo-error-actions'),
      moves: $('demo-moves'),
      pause: $('btn-demo-pause'),
      restart: $('btn-demo-restart'),
      undo: $('btn-demo-undo'),
      manual: $('btn-demo-manual'),
      numbers: $('btn-demo-numbers'),
      pace: $('demo-pace'),
      paceLabel: $('demo-pace-label'),
      lockBadge: $('lock-badge'),
      lockText: $('lock-text'),
      lockKeys: $('lock-keys')
    };

    $('lock-icon').innerHTML = UI.ICONS.lock;
    setupPanels();

    game = window.GomokuGame.create();
    renderer = window.BoardRenderer.mount($('gomoku-canvas'), {
      interactive: false,
      showNumbers: true,
      onCellClick: onCellClick
    });

    el.pause.addEventListener('click', function () { setPaused(!state.paused); });
    el.restart.addEventListener('click', restart);
    el.undo.addEventListener('click', undo);
    el.manual.addEventListener('click', function () { setHuman(!state.humanSide); });
    el.numbers.addEventListener('click', function () {
      state.showNumbers = !state.showNumbers;
      renderer.setShowNumbers(state.showNumbers);
      el.numbers.classList.toggle('on', state.showNumbers);
      el.numbers.textContent = state.showNumbers ? '手数标记' : '隐藏手数';
    });
    el.numbers.classList.add('on');
    el.pace.addEventListener('input', function () {
      state.pace = Number(el.pace.value) || 0;
      el.paceLabel.textContent = UI.fmtDuration(state.pace);
    });
    el.pace.addEventListener('change', function () {
      window.demoAPI.config.save({ demo: { stepDelayMs: state.pace } }).catch(function () { /* ignore */ });
    });
    $('btn-banner-new').addEventListener('click', restart);

    var resized = null;
    window.addEventListener('resize', function () {
      if (state.mode !== 'gomoku') return;
      clearTimeout(resized);
      resized = setTimeout(function () { if (renderer) renderer.resize(); }, 90);
    });

    // 主进程事件
    unsubs.push(window.demoAPI.gomoku.onDelta(function (payload) {
      if (!payload || payload.requestId !== state.currentRequestId) return;
      var key = /-white$/.test(payload.requestId) ? 'white' : 'black';
      if (payload.phase === 'attempt') {
        setSideState(key, '思考中 · 第 ' + payload.attempt + '/' + payload.maxAttempts + ' 次', 'thinking');
        setPhase(sideName(key === 'black' ? R.BLACK : R.WHITE) + '思考中 · 第 ' + payload.attempt + '/' + payload.maxAttempts + ' 次');
        if (payload.reset) { setReasoning(key, '', '正在请求模型…'); setRaw(key, '', ''); }
        return;
      }
      if (payload.phase === 'retry') {
        setSideState(key, '请求失败，重试中', 'thinking');
        setPhase('请求失败，' + payload.reason);
        return;
      }
      if (payload.phase === 'reject') {
        setSideState(key, '回复非法，纠正重试', 'thinking');
        setPhase('模型回复不合法：' + payload.reason);
        return;
      }
      if (payload.phase === 'reply') {
        setSideState(key, '回复已收到，校验中', 'thinking');
        return;
      }
      if (payload.reasoningText || payload.contentText) {
        streamPush(key, payload.reasoningText || payload.contentText || '', payload.contentText || '');
      }
    }));

    unsubs.push(window.demoAPI.demo.onStarted(function (payload) {
      start(payload && payload.boardId).catch(function (err) {
        UI.toast('进入演示失败：' + (err && err.message ? err.message : err), 'error');
      });
    }));

    unsubs.push(window.demoAPI.demo.onExited(function (payload) {
      stop();
      UI.toast('已退出演示模式' + (payload && payload.reason ? '（' + payload.reason + '）' : ''), 'info');
    }));

    unsubs.push(window.demoAPI.demo.onKeyProgress(function (payload) {
      if (!payload) return;
      updateKeyProgress(payload.length || 0);
      if (payload.wrong) flashWrongCode();
    }));

    unsubs.push(window.demoAPI.demo.onBlocked(function (payload) {
      if (payload && payload.message) UI.toast(payload.message, 'error', 4200);
    }));

    // 渲染进程内的按键也作为兜底（主进程已拦截，这里只更新进度提示以外的场景）
    window.addEventListener('keydown', function (event) {
      if (!state.active) return;
      if (event.key === 'Alt' || event.key === 'F4') event.preventDefault();
    });

    return Promise.resolve();
  }

  window.DemoView = {
    init: init,
    start: start,
    stop: stop,
    showView: showView,
    isActive: function () { return state.active; }
  };
})();

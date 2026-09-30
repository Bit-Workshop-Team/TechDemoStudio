'use strict';

/**
 * 落子仲裁：把"某一方该下哪一手"包成一个可取消的异步请求。
 * - api 引擎：构造提示词 → 调用大模型（流式）→ 解析 JSON → 合法性校验 → 失败重试
 * - local 引擎：内置启发式引擎，离线可用
 */

const rules = require('../shared/gomoku-rules.js');
const prompts = require('../shared/default-prompts.js');
const configStore = require('./config-store.js');
const llm = require('./llm-client.js');
const localEngine = require('./local-engine.js');

/** 从模型回复里提取第一个合法 JSON 对象 */
function extractJson(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = source.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch (_) { return null; }
      }
    }
  }
  return null;
}

/**
 * 解析并校验模型回复，返回 {ok, move|draw} 或 {ok:false, reason, hint}。
 * reason 只描述事实，hint 是给模型看的纠正提示（会写进重试的 user message）。
 */
function interpretReply(board, text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return {
      ok: false,
      reason: '回复为空',
      hint: '你必须给出一个 JSON 对象，形如 {"move": [row, col]}，不要返回空内容。'
    };
  }
  const obj = extractJson(raw);
  if (!obj) {
    return {
      ok: false,
      reason: '没有找到合法的 JSON 对象',
      hint: '只输出一个 JSON 对象，不要输出解释、Markdown 代码块（```）、标题或前后缀文字。正确示例：{"move": [7, 7]}'
    };
  }
  if (obj.draw === true) return { ok: true, draw: true };
  if (obj.error) {
    return {
      ok: false,
      reason: '模型自述无法理解局面：' + String(obj.error).slice(0, 120),
      hint: '不要用 error 字段；除非棋盘真的已满，否则必须给出一个落在空点上的 move。'
    };
  }
  const move = obj.move || obj.落子 || obj.position;
  if (!Array.isArray(move) || move.length < 2) {
    return {
      ok: false,
      reason: '缺少 move 字段，或 move 不是 [row, col]',
      hint: '返回格式必须是 {"move": [row, col]}，row 与 col 都是 0~14 的整数，且必须放在数组里。'
    };
  }
  const r = Number(move[0]);
  const c = Number(move[1]);
  if (!Number.isInteger(r) || !Number.isInteger(c)) {
    return {
      ok: false,
      reason: 'move 坐标不是整数：' + JSON.stringify(move),
      hint: '坐标必须是阿拉伯数字整数（不要带引号、小数、空格或中文数字）。正确示例：{"move": [7, 7]}'
    };
  }
  if (!rules.inBounds(r, c)) {
    return {
      ok: false,
      reason: '坐标越界：[' + r + ',' + c + ']，必须是 0~14 的整数',
      hint: '棋盘是 15 行 15 列，行号与列号都从 0 到 14（最上行是 0，最左列是 0）。请重新数一遍棋盘文本的行号与列号。'
    };
  }
  if (!rules.isValidMove(board, r, c)) {
    return {
      ok: false,
      reason: '目标点 [' + r + ',' + c + '] 不是空交叉点',
      hint: '该交叉点已经有棋子了，不能重复落子。棋盘文本中只有显示为 · 的位置是空点，请从这些空点里重新选一个。'
    };
  }
  return { ok: true, move: [r, c] };
}

function normalizeBoardInput(board) {
  return rules.normalizeBoard(board);
}

/**
 * 请求一手棋。
 * @param {object} payload { board, side, requestId }
 * @param {object} hooks { onDelta, cancelToken }
 * @returns {Promise<object>} 结果
 */
async function requestMove(payload, hooks) {
  const cfg = configStore.load();
  const board = normalizeBoardInput(payload && payload.board);
  const side = payload && payload.side === rules.WHITE ? rules.WHITE : rules.BLACK;
  const sideKey = side === rules.BLACK ? 'black' : 'white';
  const sideCfg = cfg[sideKey] || {};
  const onDelta = (hooks && hooks.onDelta) || function () {};
  const cancelToken = hooks && hooks.cancelToken;
  // 允许本次会话临时切换引擎（例如 API 不可用时改用本地引擎继续演示）
  const engine = (payload && payload.forceEngine) || sideCfg.engine;

  if (engine === 'local') {
    return runLocalEngine(board, side, cfg, onDelta);
  }
  return runApiEngine(board, side, sideCfg, cfg, onDelta, cancelToken);
}

async function runLocalEngine(board, side, cfg, onDelta) {
  const started = Date.now();
  const logLines = [];
  const result = localEngine.think(board, side, {
    level: cfg.local.level,
    onLog: (line) => logLines.push(line)
  });
  const reasoning = result.reasoning || logLines.join('\n');
  // 用小块流式喂给界面，模拟"思考"节奏，同时保证离线也能看到过程
  const step = Math.max(6, Math.floor(reasoning.length / 8));
  for (let i = 0; i < reasoning.length; i += step) {
    onDelta({ content: '', reasoning: reasoning.slice(i, i + step), contentText: '', reasoningText: reasoning.slice(0, i + step) });
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  return {
    ok: true,
    move: result.move,
    reasoning: reasoning,
    raw: '',
    engine: 'local',
    attempts: 1,
    elapsedMs: Date.now() - started,
    meta: result.meta
  };
}

async function runApiEngine(board, side, sideCfg, cfg, onDelta, cancelToken) {
  const started = Date.now();
  const boardText = rules.boardToText(board);
  const systemPrompt = configStore.effectiveSystemPrompt(side === rules.BLACK ? 'black' : 'white');
  const maxAttempts = cfg.move.maxAttempts;
  let feedback = null;
  let lastError = null;
  let lastRaw = '';
  let lastReasoning = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (cancelToken && cancelToken.cancelled) throw llm.CancelToken.cancelledError();
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompts.buildUserMessage(boardText, side, feedback, board) }
    ];
    onDelta({ phase: 'attempt', attempt, maxAttempts, reset: true });

    let res;
    try {
      res = await llm.chat({
        baseUrl: cfg.api.baseUrl,
        apiKey: cfg.api.apiKey,
        model: sideCfg.model,
        messages,
        maxTokens: cfg.move.maxOutputTokens,
        timeoutMs: cfg.move.timeoutMs,
        reasoningEffort: sideCfg.reasoningEffort,
        stream: true,
        cancelToken,
        onDelta
      });
    } catch (err) {
      if (err && (err.code === 'CANCELLED' || cancelToken && cancelToken.cancelled)) {
        const cancelErr = llm.CancelToken.cancelledError();
        cancelErr.attempts = attempt;
        throw cancelErr;
      }
      lastError = err;
      const message = err && err.message ? err.message : String(err);
      if (err && err.retriable && attempt < maxAttempts) {
        feedback = {
          reason: '上一次请求未成功：' + message,
          raw: '',
          hint: '网络或服务端波动与棋局无关，请重新给出这一手的 JSON。'
        };
        onDelta({ phase: 'retry', attempt, maxAttempts, reason: message });
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }
      const fatal = new Error(message);
      fatal.code = (err && err.code) || 'LLM_ERROR';
      fatal.attempts = attempt;
      fatal.elapsedMs = Date.now() - started;
      throw fatal;
    }

    lastRaw = res.content || '';
    lastReasoning = res.reasoning || '';
    const verdict = interpretReply(board, res.content);
    onDelta({ phase: 'reply', attempt, raw: lastRaw, usage: res.usage, finishReason: res.finishReason });

    if (verdict.draw) {
      return {
        ok: true,
        draw: true,
        reasoning: res.reasoning || '',
        raw: lastRaw,
        engine: 'api',
        model: sideCfg.model,
        attempts: attempt,
        elapsedMs: Date.now() - started
      };
    }

    if (verdict.ok) {
      return {
        ok: true,
        move: verdict.move,
        reasoning: res.reasoning || '',
        raw: lastRaw,
        engine: 'api',
        model: sideCfg.model,
        attempts: attempt,
        elapsedMs: Date.now() - started,
        usage: res.usage,
        finishReason: res.finishReason
      };
    }

    feedback = { reason: verdict.reason, raw: lastRaw, hint: verdict.hint };
    lastError = new Error('模型返回不合法：' + verdict.reason);
    onDelta({ phase: 'reject', attempt, maxAttempts, reason: verdict.reason, raw: lastRaw });
  }

  const err = new Error(
    '连续 ' + maxAttempts + ' 次没有拿到合法落子：' +
    (lastError && lastError.message ? lastError.message : '未知原因')
  );
  err.code = 'INVALID_MOVE';
  err.attempts = maxAttempts;
  err.elapsedMs = Date.now() - started;
  err.raw = lastRaw;
  err.reasoning = lastReasoning;
  throw err;
}

module.exports = { requestMove, interpretReply, extractJson };

'use strict';

/**
 * OpenAI 兼容协议的极简 HTTP 客户端（Node 内置 http/https，无第三方依赖）。
 * 在主进程发起请求，因此不受浏览器 CORS 限制。
 * 默认走 SSE 流式，便于把模型的思考过程实时推到界面。
 */

const http = require('http');
const https = require('https');

class LlmError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'LlmError';
    this.code = (extra && extra.code) || 'LLM_ERROR';
    this.status = extra && extra.status;
    this.body = extra && extra.body;
    this.retriable = extra && extra.retriable != null ? extra.retriable : false;
  }
}

class CancelToken {
  constructor() {
    this.cancelled = false;
    this._listeners = [];
  }
  onCancel(fn) {
    if (this.cancelled) return fn('已取消');
    this._listeners.push(fn);
  }
  cancel(reason) {
    if (this.cancelled) return;
    this.cancelled = true;
    const list = this._listeners;
    this._listeners = [];
    for (const fn of list) {
      try { fn(reason || '已取消'); } catch (_) { /* ignore */ }
    }
  }
  static cancelledError() {
    return new LlmError('已取消', { code: 'CANCELLED', retriable: false });
  }
}

function normalizeBaseUrl(baseUrl) {
  let url = String(baseUrl || '').trim();
  if (!url) url = 'https://api.deepseek.com';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url.replace(/\/+$/, '');
}

function joinUrl(base, suffix) {
  const b = normalizeBaseUrl(base);
  if (b.toLowerCase().endsWith(suffix.toLowerCase())) return b;
  return b + suffix;
}

/** 取 baseUrl 的域名（用于判断是否为 DeepSeek 官方端点） */
function hostOf(baseUrl) {
  try {
    return new URL(normalizeBaseUrl(baseUrl)).hostname;
  } catch (_) {
    return '';
  }
}

function chatCompletionsUrl(baseUrl) {
  return joinUrl(baseUrl, '/chat/completions');
}

function modelsUrl(baseUrl) {
  return joinUrl(baseUrl, '/models');
}

function isEmptyKey(apiKey) {
  return !String(apiKey || '').trim();
}

function buildHeaders(apiKey, extra) {
  const headers = Object.assign({
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'TechDemoStudio/1.0'
  }, extra || {});
  if (!isEmptyKey(apiKey)) headers.Authorization = 'Bearer ' + String(apiKey).trim();
  return headers;
}

function extractHttpErrorMessage(status, bodyText) {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = (parsed && parsed.error && (parsed.error.message || parsed.error.type)) || parsed.message || '';
  } catch (_) {
    detail = String(bodyText || '').slice(0, 300);
  }
  const hint = status === 401 || status === 403
    ? '（请检查 API Key 是否正确、是否已授权）'
    : status === 404
      ? '（请检查 Base URL 是否正确，通常应形如 https://api.deepseek.com）'
      : status === 429
        ? '（触发限流，请稍后重试）'
        : '';
  return 'HTTP ' + status + hint + (detail ? '：' + detail : '');
}

function isRetriableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function requestRaw(options, bodyText, timeoutMs, cancelToken) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const url = new URL(options.url);
    const transport = url.protocol === 'http:' ? http : https;
    const payload = bodyText == null ? null : Buffer.from(bodyText, 'utf8');

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      const err = new LlmError('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒未完成）', {
        code: 'TIMEOUT',
        retriable: true
      });
      try { if (req) req.destroy(err); } catch (_) { /* ignore */ }
      finish(reject, err);
    }, timeoutMs);

    try {
      req = transport.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: options.headers
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          finish(resolve, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
        res.on('error', (err) => finish(reject, new LlmError('响应读取失败：' + err.message, { code: 'NETWORK', retriable: true })));
      });
    } catch (err) {
      finish(reject, new LlmError('请求创建失败：' + err.message, { code: 'NETWORK', retriable: false }));
      return;
    }

    if (cancelToken) {
      cancelToken.onCancel(() => {
        const err = CancelToken.cancelledError();
        try { req.destroy(err); } catch (_) { /* ignore */ }
        finish(reject, err);
      });
    }

    req.on('error', (err) => {
      if (err instanceof LlmError) return finish(reject, err);
      finish(reject, new LlmError('网络请求失败：' + err.message, { code: 'NETWORK', retriable: true }));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 流式请求（SSE）。
 * @returns {Promise<{status:number,content:string,reasoning:string,usage:object|null,finishReason:string|null}>}
 */
function requestStream(options, bodyText, timeoutMs, cancelToken, onDelta) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const url = new URL(options.url);
    const transport = url.protocol === 'http:' ? http : https;
    const payload = Buffer.from(bodyText, 'utf8');
    let content = '';
    let reasoning = '';
    let usage = null;
    let finishReason = null;
    let status = 0;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      const err = new LlmError('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒未完成）', {
        code: 'TIMEOUT',
        retriable: true
      });
      try { if (req) req.destroy(err); } catch (_) { /* ignore */ }
      finish(reject, err);
    }, timeoutMs);

    const handleJson = (obj) => {
      if (!obj) return;
      if (obj.error) {
        throw new LlmError('服务端返回错误：' + (obj.error.message || JSON.stringify(obj.error)), {
          code: 'SERVER_ERROR',
          retriable: false
        });
      }
      if (obj.usage) usage = obj.usage;
      const choice = obj.choices && obj.choices[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || choice.message || {};
      const piece = typeof delta.content === 'string' ? delta.content : '';
      const think = typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
      if (piece) content += piece;
      if (think) reasoning += think;
      if ((piece || think) && typeof onDelta === 'function') {
        try { onDelta({ content: piece, reasoning: think, contentText: content, reasoningText: reasoning }); } catch (_) { /* ignore */ }
      }
    };

    try {
      req = transport.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method: 'POST',
        headers: options.headers
      }, (res) => {
        status = res.statusCode;
        if (status < 200 || status >= 300) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            finish(reject, new LlmError(extractHttpErrorMessage(status, body), {
              code: 'HTTP_' + status,
              status,
              body,
              retriable: isRetriableStatus(status)
            }));
          });
          res.on('error', (err) => finish(reject, new LlmError('响应读取失败：' + err.message, { code: 'NETWORK', retriable: true })));
          return;
        }

        res.setEncoding('utf8');
        let buffer = '';
        const handleLine = (line) => {
          const trimmed = line.replace(/\r$/, '').trim();
          if (!trimmed) return;
          if (trimmed.startsWith(':')) return;
          if (!trimmed.startsWith('data:')) return;
          const payloadText = trimmed.slice(5).trim();
          if (!payloadText || payloadText === '[DONE]') return;
          let obj;
          try { obj = JSON.parse(payloadText); } catch (_) { return; }
          try {
            handleJson(obj);
          } catch (err) {
            const e = err instanceof LlmError ? err : new LlmError(String(err && err.message || err), { code: 'SERVER_ERROR', retriable: false });
            try { if (req) req.destroy(e); } catch (_) { /* ignore */ }
            finish(reject, e);
          }
        };

        res.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            handleLine(line);
          }
        });
        res.on('end', () => {
          if (buffer) handleLine(buffer);
          finish(resolve, { status, content, reasoning, usage, finishReason });
        });
        res.on('error', (err) => finish(reject, new LlmError('流式响应中断：' + err.message, { code: 'NETWORK', retriable: true })));
      });
    } catch (err) {
      finish(reject, new LlmError('请求创建失败：' + err.message, { code: 'NETWORK', retriable: false }));
      return;
    }

    if (cancelToken) {
      cancelToken.onCancel(() => {
        const err = CancelToken.cancelledError();
        try { req.destroy(err); } catch (_) { /* ignore */ }
        finish(reject, err);
      });
    }

    req.on('error', (err) => {
      if (err instanceof LlmError) return finish(reject, err);
      finish(reject, new LlmError('网络请求失败：' + err.message, { code: 'NETWORK', retriable: true }));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * 组装 Chat Completions 请求体（纯函数，便于自检）。
 * DeepSeek 官方端点（V4 起默认开启思考）需要用 thinking 显式开关思考；
 * 第三方 OpenAI 兼容端点不发 thinking 字段，避免 400。
 */
function buildChatBody(opts) {
  const o = opts || {};
  const reasoningEffort = o.reasoningEffort || 'off';
  const body = {
    model: o.model,
    messages: o.messages,
    stream: !!o.stream
  };
  if (o.maxTokens) body.max_tokens = o.maxTokens;
  if (isDeepSeekHost(o.baseUrl)) {
    body.thinking = { type: reasoningEffort !== 'off' ? 'enabled' : 'disabled' };
  }
  if (reasoningEffort !== 'off') body.reasoning_effort = reasoningEffort;
  return body;
}

function isDeepSeekHost(baseUrl) {
  return /(^|\.)deepseek\.com$/i.test(hostOf(baseUrl));
}

/**
 * 发起一次对话补全。
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array}  opts.messages
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.reasoningEffort] 'off' | 'low' | 'high' | 'max'
 * @param {boolean}[opts.stream]
 * @param {CancelToken} [opts.cancelToken]
 * @param {function} [opts.onDelta]
 */
async function chat(opts) {
  const {
    baseUrl, apiKey, model, messages,
    maxTokens, timeoutMs = 300000, reasoningEffort = 'off',
    stream = true, cancelToken, onDelta
  } = opts || {};

  if (isEmptyKey(apiKey)) {
    throw new LlmError('尚未配置 API Key，请在设置界面填写后再使用 API 引擎。', {
      code: 'NO_API_KEY',
      retriable: false
    });
  }

  const body = buildChatBody({
    baseUrl, model, messages, maxTokens, stream, reasoningEffort
  });

  const url = chatCompletionsUrl(baseUrl);
  const headers = buildHeaders(apiKey, {
    'Accept': stream ? 'text/event-stream' : 'application/json'
  });

  if (stream) {
    return requestStream({ url, headers }, JSON.stringify(body), timeoutMs, cancelToken, onDelta);
  }
  const res = await requestRaw({ url, headers, method: 'POST' }, JSON.stringify(body), timeoutMs, cancelToken);
  if (res.status < 200 || res.status >= 300) {
    throw new LlmError(extractHttpErrorMessage(res.status, res.body), {
      code: 'HTTP_' + res.status,
      status: res.status,
      body: res.body,
      retriable: isRetriableStatus(res.status)
    });
  }
  let parsed;
  try { parsed = JSON.parse(res.body); } catch (err) {
    throw new LlmError('服务端返回的不是合法 JSON：' + String(res.body).slice(0, 200), {
      code: 'BAD_RESPONSE',
      retriable: true
    });
  }
  if (parsed.error) {
    throw new LlmError('服务端返回错误：' + (parsed.error.message || JSON.stringify(parsed.error)), {
      code: 'SERVER_ERROR',
      retriable: false
    });
  }
  const choice = parsed.choices && parsed.choices[0];
  const msg = (choice && choice.message) || {};
  return {
    status: res.status,
    content: typeof msg.content === 'string' ? msg.content : '',
    reasoning: msg.reasoning_content || msg.reasoning || '',
    usage: parsed.usage || null,
    finishReason: choice ? choice.finish_reason : null
  };
}

/** 拉取模型列表（部分兼容服务不支持，失败不影响使用） */
async function listModels(opts) {
  const { baseUrl, apiKey, timeoutMs = 15000 } = opts || {};
  const res = await requestRaw({
    url: modelsUrl(baseUrl),
    headers: buildHeaders(apiKey),
    method: 'GET'
  }, null, timeoutMs, null);
  if (res.status < 200 || res.status >= 300) {
    throw new LlmError(extractHttpErrorMessage(res.status, res.body), {
      code: 'HTTP_' + res.status,
      status: res.status,
      body: res.body,
      retriable: false
    });
  }
  let parsed;
  try { parsed = JSON.parse(res.body); } catch (_) { return []; }
  const data = Array.isArray(parsed.data) ? parsed.data : (Array.isArray(parsed.models) ? parsed.models : []);
  return data.map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name)) || '')).filter(Boolean);
}

/** 连通性自检：先试 /models，再退回一次最小对话请求 */
async function testConnection(opts) {
  const { baseUrl, apiKey, model } = opts || {};
  if (isEmptyKey(apiKey)) return { ok: false, error: '尚未填写 API Key。' };
  try {
    const models = await listModels({ baseUrl, apiKey, timeoutMs: 20000 });
    return { ok: true, mode: 'models', models };
  } catch (err) {
    // 忽略，继续尝试最小对话请求
  }
  try {
    const res = await chat({
      baseUrl, apiKey, model, messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 8, timeoutMs: 30000, stream: false
    });
    return { ok: true, mode: 'chat', sample: (res.content || '').slice(0, 40) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  LlmError,
  CancelToken,
  chat,
  listModels,
  testConnection,
  chatCompletionsUrl,
  modelsUrl,
  normalizeBaseUrl,
  hostOf,
  isDeepSeekHost,
  buildChatBody
};

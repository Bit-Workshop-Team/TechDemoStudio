'use strict';

/**
 * 配置存储：userData/config.json
 * API Key 在系统支持时用 Electron safeStorage（Windows 上为 DPAPI）加密后落盘。
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULT_SYSTEM_PROMPT = require('../shared/default-prompts.js').DEFAULT_SYSTEM_PROMPT;

/** 当前 DeepSeek 平台在用的模型名（旧名 deepseek-chat / deepseek-reasoner 将于 2026-07-24 停用） */
const MODEL_SUGGESTIONS = ['deepseek-flash', 'deepseek-v4-pro'];

/** 旧模型名 → 新模型名的迁移表 */
const LEGACY_MODEL_MAP = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-reasoner-lite': 'deepseek-flash',
  'deepseek-coder': 'deepseek-flash'
};

const EFFORT_LEVELS = ['off', 'low', 'high', 'max'];

const DEFAULTS = {
  version: 1,
  api: {
    baseUrl: 'https://api.deepseek.com',
    apiKey: ''
  },
  black: {
    engine: 'api',            // 'api' | 'local'
    model: 'deepseek-flash',
    reasoningEffort: 'off',   // 'off' | 'low' | 'high' | 'max'
    systemPrompt: ''          // 空 = 使用内置默认提示词
  },
  white: {
    engine: 'local',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
    systemPrompt: ''
  },
  move: {
    timeoutMs: 300000,        // 单次落子尝试的端到端超时（毫秒）
    maxOutputTokens: 8192,    // 单次落子输出 token 上限
    maxAttempts: 3            // 单次落子请求的尝试次数
  },
  demo: {
    exitCode: '114514',       // 连续键入该暗码退出全屏演示
    showLockHint: true,
    stepDelayMs: 600          // 展示模式下每一步之间的停顿，便于观看
  },
  local: {
    level: 2                  // 本地引擎棋力 1(快) ~ 3(强)
  },
  ui: {
    lastBoard: 'gomoku'
  }
};

let cache = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!isPlainObject(patch)) return out;
  for (const key of Object.keys(patch)) {
    const bv = out[key];
    const pv = patch[key];
    if (isPlainObject(bv) && isPlainObject(pv)) out[key] = merge(bv, pv);
    else if (pv !== undefined) out[key] = pv;
  }
  return out;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitize(raw) {
  const cfg = merge(DEFAULTS, raw);
  cfg.version = 1;
  cfg.api.baseUrl = String(cfg.api.baseUrl || DEFAULTS.api.baseUrl).trim() || DEFAULTS.api.baseUrl;
  cfg.api.apiKey = String(cfg.api.apiKey || '');
  for (const side of ['black', 'white']) {
    const s = cfg[side];
    s.engine = s.engine === 'local' ? 'local' : 'api';
    let model = String(s.model || DEFAULTS[side].model).trim() || DEFAULTS[side].model;
    if (LEGACY_MODEL_MAP[model]) model = LEGACY_MODEL_MAP[model];
    s.model = model;
    s.reasoningEffort = EFFORT_LEVELS.includes(s.reasoningEffort) ? s.reasoningEffort : 'off';
    s.systemPrompt = typeof s.systemPrompt === 'string' ? s.systemPrompt : '';
  }
  cfg.move.timeoutMs = clampInt(cfg.move.timeoutMs, 5000, 3600000, DEFAULTS.move.timeoutMs);
  cfg.move.maxOutputTokens = clampInt(cfg.move.maxOutputTokens, 64, 128000, DEFAULTS.move.maxOutputTokens);
  cfg.move.maxAttempts = clampInt(cfg.move.maxAttempts, 1, 6, DEFAULTS.move.maxAttempts);
  cfg.demo.exitCode = String(cfg.demo.exitCode == null ? DEFAULTS.demo.exitCode : cfg.demo.exitCode).trim() || DEFAULTS.demo.exitCode;
  cfg.demo.showLockHint = cfg.demo.showLockHint !== false;
  cfg.demo.stepDelayMs = clampInt(cfg.demo.stepDelayMs, 0, 10000, DEFAULTS.demo.stepDelayMs);
  cfg.local.level = clampInt(cfg.local.level, 1, 3, DEFAULTS.local.level);
  cfg.ui.lastBoard = String(cfg.ui.lastBoard || DEFAULTS.ui.lastBoard);
  return cfg;
}

function decryptKey(stored) {
  if (!stored) return '';
  if (!stored.encrypted) return String(stored.plain || '');
  try {
    if (!safeStorage.isEncryptionAvailable()) return '';
    const buf = Buffer.from(String(stored.cipher || ''), 'base64');
    return safeStorage.decryptString(buf);
  } catch (err) {
    console.error('[config] 解密 API Key 失败：', err && err.message);
    return '';
  }
}

function encryptKey(plain) {
  if (!plain) return { apiKeyStorage: { encrypted: false, plain: '' } };
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const cipher = safeStorage.encryptString(plain).toString('base64');
      return { apiKeyStorage: { encrypted: true, cipher } };
    }
  } catch (err) {
    console.error('[config] 加密 API Key 失败，将明文保存：', err && err.message);
  }
  return { apiKeyStorage: { encrypted: false, plain } };
}

/** 读取配置（含解密后的明文 API Key，供界面回显） */
function load(force) {
  if (cache && !force) return cache;
  let raw = null;
  try {
    const text = fs.readFileSync(configPath(), 'utf8');
    raw = JSON.parse(text);
    if (raw && raw.apiKeyStorage) {
      raw.api = raw.api || {};
      raw.api.apiKey = decryptKey(raw.apiKeyStorage);
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error('[config] 配置文件读取失败，使用默认值：', err.message);
      try {
        fs.renameSync(configPath(), configPath() + '.broken-' + Date.now());
      } catch (_) { /* ignore */ }
    }
    raw = null;
  }
  cache = sanitize(raw);
  return cache;
}

/** 保存配置（自动加密 API Key） */
function save(patch) {
  const cfg = sanitize(merge(load(true), patch));
  const plainKey = cfg.api.apiKey;
  const out = JSON.parse(JSON.stringify(cfg));
  delete out.api.apiKey;
  out.apiKeyStorage = encryptKey(plainKey).apiKeyStorage;
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(out, null, 2), 'utf8');
  } catch (err) {
    console.error('[config] 配置保存失败：', err && err.message);
    throw new Error('配置保存失败：' + (err && err.message));
  }
  cache = cfg;
  return cfg;
}

function effectiveSystemPrompt(side) {
  const cfg = load();
  const custom = (cfg[side] && cfg[side].systemPrompt || '').trim();
  return custom || DEFAULT_SYSTEM_PROMPT;
}

module.exports = {
  DEFAULTS,
  MODEL_SUGGESTIONS,
  EFFORT_LEVELS,
  configPath,
  load,
  save,
  sanitize,
  effectiveSystemPrompt,
  defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT
};

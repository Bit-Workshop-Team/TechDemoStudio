/* 技术演示台 · 设置界面 */
(function () {
  'use strict';

  var UI = window.UI;
  var boards = window.DemoBoards;

  var state = {
    info: null,
    config: null,
    defaults: null,
    defaultPrompt: '',
    baseline: '',
    onEnterDemo: null
  };

  var FIELDS = [
    'api-base-url', 'api-key',
    'black-engine', 'black-model', 'black-effort', 'black-prompt',
    'white-engine', 'white-model', 'white-effort', 'white-prompt',
    'move-timeout', 'move-maxtokens', 'move-attempts',
    'demo-exit-code', 'demo-step-delay', 'demo-show-hint', 'local-level'
  ];

  function $(id) { return document.getElementById(id); }

  // ---------------------------------------------------------------- 模型下拉
  // 当前 DeepSeek 平台在用的模型名（旧的 deepseek-chat / deepseek-reasoner 已计划停用）
  var MODEL_PRESETS = [
    { id: 'deepseek-flash', note: 'V4.1-Flash · 快，支持思考' },
    { id: 'deepseek-v4-pro', note: 'V4-Pro · 推理更强' }
  ];
  var modelCache = { black: [], white: [] };
  var comboOpen = null;

  function comboList(side) {
    var seen = Object.create(null);
    var out = [];
    MODEL_PRESETS.forEach(function (m) { seen[m.id] = 1; out.push(m); });
    (modelCache[side] || []).forEach(function (id) {
      if (seen[id]) return;
      seen[id] = 1;
      out.push({ id: id, note: '服务端返回' });
    });
    return out;
  }

  function renderCombo(side, keyword) {
    var menu = $(side + '-model-menu');
    var kw = String(keyword || '').trim().toLowerCase();
    var items = comboList(side).filter(function (m) {
      return !kw || m.id.toLowerCase().indexOf(kw) >= 0;
    });
    UI.clear(menu);
    if (!items.length) {
      menu.appendChild(UI.el('div', { class: 'combo-empty', text: '没有匹配的模型，可直接输入自定义名称' }));
      return;
    }
    items.forEach(function (m) {
      menu.appendChild(UI.el('div', {
        class: 'combo-item',
        onclick: function () { pickCombo(side, m.id); }
      }, [
        UI.el('span', { class: 'name', text: m.id }),
        UI.el('span', { class: 'tagline', text: m.note })
      ]));
    });
  }

  function openCombo(side) {
    if (comboOpen && comboOpen !== side) closeCombo();
    comboOpen = side;
    renderCombo(side, '');
    $(side + '-model-menu').classList.add('show');
  }

  function closeCombo() {
    if (!comboOpen) return;
    var menu = $(comboOpen + '-model-menu');
    if (menu) menu.classList.remove('show');
    comboOpen = null;
  }

  function pickCombo(side, id) {
    $(side + '-model').value = id;
    closeCombo();
    checkDirty();
  }

  function setupCombo(side) {
    var input = $(side + '-model');
    var arrow = $(side + '-model-arrow');
    if (!input || !arrow) return;
    arrow.addEventListener('click', function () {
      if (comboOpen === side) closeCombo(); else openCombo(side);
    });
    input.addEventListener('focus', function () { if (comboOpen !== side) openCombo(side); });
    input.addEventListener('input', function () {
      if (comboOpen !== side) openCombo(side);
      renderCombo(side, input.value);
      checkDirty();
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { closeCombo(); input.blur(); }
      else if (event.key === 'Enter' && comboOpen === side) { closeCombo(); }
    });
    input.addEventListener('blur', function () { setTimeout(closeCombo, 140); });
  }

  // ---------------------------------------------------------------- 表单读写
  function fillForm(cfg) {
    $('api-base-url').value = cfg.api.baseUrl;
    $('api-key').value = cfg.api.apiKey || '';
    ['black', 'white'].forEach(function (side) {
      $(side + '-engine').value = cfg[side].engine;
      $(side + '-model').value = cfg[side].model;
      $(side + '-effort').value = cfg[side].reasoningEffort;
      $(side + '-prompt').value = cfg[side].systemPrompt || '';
    });
    $('move-timeout').value = cfg.move.timeoutMs;
    $('move-maxtokens').value = cfg.move.maxOutputTokens;
    $('move-attempts').value = cfg.move.maxAttempts;
    $('demo-exit-code').value = cfg.demo.exitCode;
    $('demo-step-delay').value = cfg.demo.stepDelayMs;
    $('demo-show-hint').checked = cfg.demo.showLockHint !== false;
    $('local-level').value = String(cfg.local.level);
    state.baseline = JSON.stringify(collect());
    setDirty(false);
    renderEngineSummary();
  }

  function collect() {
    return {
      api: {
        baseUrl: $('api-base-url').value.trim(),
        apiKey: $('api-key').value
      },
      black: {
        engine: $('black-engine').value,
        model: $('black-model').value.trim(),
        reasoningEffort: $('black-effort').value,
        systemPrompt: $('black-prompt').value
      },
      white: {
        engine: $('white-engine').value,
        model: $('white-model').value.trim(),
        reasoningEffort: $('white-effort').value,
        systemPrompt: $('white-prompt').value
      },
      move: {
        timeoutMs: Number($('move-timeout').value),
        maxOutputTokens: Number($('move-maxtokens').value),
        maxAttempts: Number($('move-attempts').value)
      },
      demo: {
        exitCode: $('demo-exit-code').value.trim(),
        stepDelayMs: Number($('demo-step-delay').value),
        showLockHint: $('demo-show-hint').checked
      },
      local: { level: Number($('local-level').value) }
    };
  }

  function setDirty(dirty) {
    var node = $('save-state');
    node.className = 'state ' + (dirty ? 'dirty' : 'saved');
    node.textContent = dirty ? '有未保存的修改' : '设置已同步';
    $('btn-save').disabled = !dirty;
  }

  function checkDirty() {
    setDirty(JSON.stringify(collect()) !== state.baseline);
  }

  /** 模型名与引擎的即时预览（写进两侧卡片的标题点） */
  function renderEngineSummary() {
    ['black', 'white'].forEach(function (side) {
      var engine = $(side + '-engine').value;
      var dot = $(side + '-dot');
      dot.className = 'dot ' + (engine === 'local' ? 'dot-done' : 'dot-thinking');
      // 本地引擎不需要模型与思考档位，直接收起来，避免误导
      var isLocal = engine === 'local';
      $(side + '-ai-fields').classList.toggle('hidden', isLocal);
      $(side + '-local-note').classList.toggle('hidden', !isLocal);
    });
  }

  // ---------------------------------------------------------------- 保存
  function save(showToast) {
    var patch = collect();
    if (!patch.demo.exitCode) {
      UI.toast('退出暗码不能为空，已回退为默认值', 'error');
      patch.demo.exitCode = (state.defaults && state.defaults.demo.exitCode) || '114514';
      $('demo-exit-code').value = patch.demo.exitCode;
    }
    return window.demoAPI.config.save(patch).then(function (res) {
      if (!res || !res.ok) throw new Error('保存失败');
      state.config = res.config;
      state.baseline = JSON.stringify(collect());
      setDirty(false);
      if (showToast !== false) UI.toast('设置已保存', 'success');
      return res.config;
    }).catch(function (err) {
      UI.toast('保存失败：' + (err && err.message ? err.message : err), 'error');
      throw err;
    });
  }

  // ---------------------------------------------------------------- 连接测试
  function currentApi() {
    return {
      baseUrl: $('api-base-url').value.trim(),
      apiKey: $('api-key').value,
      model: $('black-model').value.trim() || 'deepseek-flash'
    };
  }

  function testConnection() {
    var out = $('test-result');
    var api = currentApi();
    if (!api.apiKey) {
      out.className = 'result-line result-err';
      out.textContent = '请先填写 API Key。';
      return;
    }
    out.className = 'result-line result-busy';
    out.textContent = '正在测试…';
    $('btn-test').disabled = true;
    window.demoAPI.llm.test(api).then(function (res) {
      if (res && res.ok) {
        out.className = 'result-line result-ok';
        out.textContent = '连接成功：' + (res.detail || '服务可用');
        UI.toast('模型服务连接成功', 'success');
      } else {
        out.className = 'result-line result-err';
        out.textContent = '连接失败：' + ((res && res.error) || '未知错误');
      }
    }).catch(function (err) {
      out.className = 'result-line result-err';
      out.textContent = '连接失败：' + (err && err.message ? err.message : err);
    }).then(function () {
      $('btn-test').disabled = false;
    });
  }

  function loadModels() {
    var out = $('test-result');
    var api = currentApi();
    if (!api.apiKey) {
      out.className = 'result-line result-err';
      out.textContent = '请先填写 API Key。';
      return;
    }
    out.className = 'result-line result-busy';
    out.textContent = '正在拉取模型列表…';
    $('btn-models').disabled = true;
    window.demoAPI.llm.models(api).then(function (res) {
      var list = (res && res.models) || [];
      modelCache.black = list;
      modelCache.white = list;
      renderCombo('black', $('black-model').value);
      renderCombo('white', $('white-model').value);
      if (res && res.ok && list.length) {
        out.className = 'result-line result-ok';
        out.textContent = '已获取 ' + list.length + ' 个模型：' + list.slice(0, 4).join('、') + (list.length > 4 ? ' 等' : '');
      } else {
        out.className = 'result-line result-err';
        out.textContent = '获取失败：' + ((res && res.error) || '服务未返回模型列表');
      }
    }).catch(function (err) {
      out.className = 'result-line result-err';
      out.textContent = '获取失败：' + (err && err.message ? err.message : err);
    }).then(function () {
      $('btn-models').disabled = false;
    });
  }

  // ---------------------------------------------------------------- 板块卡片
  function renderBoards() {
    var host = $('board-list');
    UI.clear(host);
    var list = (state.info && state.info.boards) || boards.list();
    var lastBoard = (state.info && state.info.defaultBoardId) || 'gomoku';
    list.forEach(function (board) {
      var card = UI.el('div', { class: 'board-card' }, [
        UI.el('div', { class: 'board-top' }, [
          UI.el('div', {}, [
            UI.el('div', { class: 'board-name', text: board.name }),
            UI.el('div', { class: 'board-sub', text: (board.subtitle || board.id) })
          ]),
          UI.el('span', { class: 'badge badge-ready', text: '可演示' })
        ]),
        UI.el('div', { class: 'board-summary', text: board.summary || '' }),
        UI.el('ul', { class: 'highlights' }, (board.highlights || []).map(function (h) {
          return UI.el('li', { text: h });
        })),
        UI.el('div', { class: 'board-actions' }, [
          UI.el('button', {
            class: 'btn btn-primary',
            type: 'button',
            onclick: function () { enterDemo(board.id); }
          }, [UI.icon('play'), UI.el('span', { text: '进入演示模式' })]),
          lastBoard === board.id ? UI.el('span', { class: 'badge', text: '上次使用' }) : null
        ])
      ]);
      host.appendChild(card);
    });
  }

  function enterDemo(boardId) {
    var status = collect();
    // 会调用大模型的板块必须先有 API Key（否则让该方改用内置本地引擎）
    var needApi = status.black.engine === 'api' || status.white.engine === 'api';
    if (needApi && !status.api.apiKey) {
      UI.toast('当前有对弈方使用「大模型 API」，请先填写 API Key；或把该方改为「内置本地引擎」。', 'error', 5200);
      return;
    }
    save(false).then(function () {
      if (state.onEnterDemo) state.onEnterDemo(boardId);
    }).catch(function () { /* 保存失败已提示 */ });
  }

  // ---------------------------------------------------------------- 说明
  function renderNotes() {
    var host = $('notes');
    UI.clear(host);
    var info = state.info || {};
    var exitCode = $('demo-exit-code').value || '114514';
    var lines = [
      UI.el('div', {}, [UI.el('b', { text: '退出演示：' }), UI.el('span', { text: '在演示画面中依次键入 ' }), UI.el('code', { text: exitCode }), UI.el('span', { text: '（不含引号）即可解锁全屏。中途输错会有红色提示，继续输入正确的暗码即可。' })]),
      UI.el('div', { style: { marginTop: '8px' } }, [UI.el('b', { text: '被屏蔽的按键：' }), UI.el('span', { text: 'F5 / F11 / F12 / Esc / Tab / Alt+F4 / Alt+Tab / Ctrl+W、R、Shift+I 等开发者与窗口快捷键，以及数字键。' })]),
      UI.el('div', { style: { marginTop: '8px' } }, [UI.el('b', { text: '无法屏蔽：' }), UI.el('span', { text: 'Ctrl+Alt+Del 与 Win+L 属于系统安全序列，任何用户态程序都无法拦截（紧急时可用任务管理器结束进程）。' })]),
      UI.el('div', { style: { marginTop: '8px' } }, [UI.el('b', { text: '推荐组合：' }), UI.el('span', { text: '黑方 deepseek-flash + Off（出招快），白方 deepseek-flash + High（展示中文思考过程）；想拉开差距可把一方换成 deepseek-v4-pro + Max。没有 API Key 时可把两方都设为「内置本地引擎」离线演示。' })]),
      UI.el('div', { style: { marginTop: '8px' } }, [UI.el('b', { text: '人机对战：' }), UI.el('span', { text: '演示中点击棋盘下方的「我要挑战deepseek！」即可接管正在使用本地引擎的一方，亲手与大模型对弈；再次点击交还引擎。' })]),
      UI.el('div', { style: { marginTop: '8px' } }, [UI.el('b', { text: '思考过程：' }), UI.el('span', { text: '大模型一方的思考过程在左右两侧面板实时流式显示；点击底部手数标签可回看该手的完整思考。' })]),
      UI.el('div', { style: { marginTop: '8px' } }, [UI.el('b', { text: '运行环境：' }), UI.el('span', { text: 'Electron ' + (info.electron || '22') + ' · Chromium ' + (info.chrome || '108') + ' · ' + (info.platform || 'win32') + ' ' + (info.arch || '') + ' · 系统 ' + (info.windowsVersion || '-') })])
    ];
    lines.forEach(function (n) { host.appendChild(n); });
    if (info.encryptionAvailable === false) {
      host.appendChild(UI.el('div', { style: { marginTop: '8px', color: '#ffb3b3' } }, [
        UI.el('span', { text: '注意：当前系统不支持配置加密（可能是精简版系统缺少 DPAPI），API Key 将以明文形式保存于本机配置文件。' })
      ]));
    }
    host.appendChild(UI.el('div', { style: { marginTop: '8px' } }, [
      UI.el('b', { text: '配置文件：' }),
      UI.el('code', { text: info.configPath || '-' })
    ]));
  }

  // ---------------------------------------------------------------- 头部信息
  function renderHeader() {
    var info = state.info || {};
    var host = $('header-meta');
    UI.clear(host);
    [
      'v' + (info.version || '1.0.0'),
      'Electron ' + (info.electron || '-'),
      (info.windowsVersion ? 'Windows ' + info.windowsVersion : (info.platform || '')),
      info.packaged ? '已安装版' : '开发模式'
    ].forEach(function (text) {
      host.appendChild(UI.el('span', { class: 'chip', text: text }));
    });
  }

  // ---------------------------------------------------------------- 绑定
  function bind() {
    FIELDS.forEach(function (id) {
      var node = $(id);
      if (!node) return;
      node.addEventListener('input', checkDirty);
      node.addEventListener('change', function () {
        checkDirty();
        renderEngineSummary();
        if (id === 'demo-exit-code') renderNotes();
      });
    });

    $('btn-toggle-key').addEventListener('click', function () {
      var input = $('api-key');
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      $('btn-toggle-key').textContent = show ? '隐藏' : '显示';
    });

    $('btn-test').addEventListener('click', testConnection);
    $('btn-models').addEventListener('click', loadModels);
    $('btn-save').addEventListener('click', function () { save(true); });
    $('btn-open-config').addEventListener('click', function () {
      window.demoAPI.app.showConfigFile();
    });
    $('btn-reset-all').addEventListener('click', function () {
      if (!window.confirm('恢复所有设置为默认值？（API Key 会一并清空）')) return;
      var defs = state.defaults || (state.config || {});
      fillForm(defs);
      UI.toast('已填入默认值，点击「保存设置」后生效', 'info', 4200);
    });

    ['black', 'white'].forEach(function (side) {
      setupCombo(side);
      $('btn-reset-' + side + '-prompt').addEventListener('click', function () {
        $(side + '-prompt').value = state.defaultPrompt;
        checkDirty();
        UI.toast('已填入内置默认提示词，可直接编辑', 'info');
      });
      $('btn-view-' + side + '-prompt').addEventListener('click', function () {
        var box = $(side + '-prompt');
        var details = box.closest('details');
        if (details) details.open = true;
        box.value = state.defaultPrompt;
        box.focus();
        box.setSelectionRange(0, 0);
        checkDirty();
        UI.toast('下方文本框内即为内置默认提示词（保存后生效）', 'info', 3600);
      });
      $(side + '-model').addEventListener('input', renderEngineSummary);
    });

    document.addEventListener('click', function (event) {
      var target = event.target;
      if (target && target.closest && target.closest('.combo')) return;
      closeCombo();
    });

    window.addEventListener('beforeunload', function () {
      // 设置界面刷新时不做拦截，避免影响正常关闭
    });
  }

  // ---------------------------------------------------------------- 对外
  function init(options) {
    state.info = (options && options.info) || {};
    state.onEnterDemo = options && options.onEnterDemo;

    $('brand-logo').innerHTML = UI.ICONS.logo;
    $('lock-icon').innerHTML = UI.ICONS.lock;

    return Promise.all([
      window.demoAPI.config.get(),
      window.demoAPI.config.defaults()
    ]).then(function (res) {
      state.config = res[0];
      state.defaults = res[1].defaults;
      state.defaultPrompt = res[1].systemPrompt;
      fillForm(state.config);
      renderHeader();
      renderBoards();
      renderNotes();
      bind();
      return state.config;
    });
  }

  window.Settings = {
    init: init,
    getConfig: function () { return state.config; },
    refreshNotes: renderNotes,
    enterDemo: enterDemo
  };
})();

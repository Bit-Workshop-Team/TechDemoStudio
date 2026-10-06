/**
 * 技术板块目录。设置界面右侧的板块卡片就是按这里的顺序渲染的。
 *
 * 目前只有一个板块（gomoku）。要新增板块：在这里追加一项，并把 status 设为 'ready'，
 * 同时在 src/renderer 里实现对应的演示视图（见 README 第 7 节）。
 * 未知 id 会被 DemoView.start() 拒绝，因此这里列出的必须是真正实现过的板块。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DemoBoards = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BOARDS = [
    {
      id: 'gomoku',
      name: 'AI 五子棋 · 双 AI 对弈',
      subtitle: 'AI vs AI Gomoku',
      tag: '大模型推理',
      status: 'ready',
      order: 1,
      summary: '两个大模型在 15×15 棋盘上轮流落子，每一步都由模型自主推理决定。',
      highlights: [
        '黑 / 白双方可分别配置模型与思考档位',
        '思考过程分侧实时流式展示',
        '非法落子由服务端拒绝并要求模型重选',
        '无 API Key 时可切到内置本地引擎，离线也能演示'
      ]
    }
  ];

  function list() {
    return BOARDS.slice().sort(function (a, b) { return a.order - b.order; });
  }

  function get(id) {
    for (var i = 0; i < BOARDS.length; i++) if (BOARDS[i].id === id) return BOARDS[i];
    return null;
  }

  return { list: list, get: get };
});

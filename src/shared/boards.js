/**
 * 技术板块目录。除 gomoku 外的板块目前留空（status: planned），
 * 进入后展示"待开发"占位演示页，用于验证板块框架。
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
    },
    {
      id: 'vision',
      name: '视觉识别与实时追踪',
      subtitle: 'Realtime Vision',
      tag: '计算机视觉',
      status: 'planned',
      order: 2,
      summary: '摄像头/视频流的实时目标检测与追踪演示。',
      highlights: ['板块内容待补充']
    },
    {
      id: 'speech',
      name: '实时语音合成与克隆',
      subtitle: 'Realtime TTS',
      tag: '语音技术',
      status: 'planned',
      order: 3,
      summary: '文本到语音的实时流式合成与音色克隆演示。',
      highlights: ['板块内容待补充']
    },
    {
      id: 'agent',
      name: '多智能体协作编排',
      subtitle: 'Multi-Agent Orchestration',
      tag: 'Agent',
      status: 'planned',
      order: 4,
      summary: '多个 Agent 分工协作完成复杂任务的编排演示。',
      highlights: ['板块内容待补充']
    },
    {
      id: 'rag',
      name: '知识库检索增强（RAG）',
      subtitle: 'Retrieval Augmented Generation',
      tag: '检索增强',
      status: 'planned',
      order: 5,
      summary: '文档向量化、检索与溯源的端到端演示。',
      highlights: ['板块内容待补充']
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

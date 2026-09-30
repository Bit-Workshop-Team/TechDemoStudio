/* 技术演示台 · 渲染层入口 */
(function () {
  'use strict';

  var UI = window.UI;
  var api = window.demoAPI;

  function reportError(kind, err) {
    var message = err && err.message ? err.message : String(err);
    try { api.app.reportError({ kind: kind, message: message, stack: err && err.stack }); } catch (_) { /* ignore */ }
    UI.toast(kind + '：' + message, 'error', 6000);
  }

  function boot() {
    if (!api) {
      document.body.innerHTML = '<div style="padding:40px;color:#ffb3b3;font-family:sans-serif">预加载脚本未能注入（demoAPI 不存在），请重新安装程序。</div>';
      return;
    }

    return api.app.info().then(function (info) {
      return window.DemoView.init({ info: info }).then(function () {
        return window.Settings.init({
          info: info,
          onEnterDemo: function (boardId) { return api.demo.start(boardId); }
        });
      });
    }).then(function () {
      // 首屏聚焦第一个可交互元素，方便键盘操作（演示机常常只接键盘）
      var first = document.querySelector('#view-settings .input');
      if (first) first.focus();
    }).catch(function (err) {
      console.error('[boot]', err);
      reportError('初始化失败', err);
    });
  }

  // ------------------------------------------------------------------ 环境限制
  // 禁用文件拖入（避免拖入文件导致页面跳转）
  ['dragover', 'drop'].forEach(function (type) {
    window.addEventListener(type, function (event) { event.preventDefault(); }, false);
  });

  // 禁用 Ctrl+滚轮 / Ctrl+加减号缩放，保持演示画面比例稳定
  window.addEventListener('wheel', function (event) {
    if (event.ctrlKey) event.preventDefault();
  }, { passive: false });

  window.addEventListener('keydown', function (event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    var key = event.key;
    if (key === '+' || key === '=' || key === '-' || key === '_' || key === '0') event.preventDefault();
    if (key === 'p' || key === 'P' || key === 's' || key === 'S' || key === 'o' || key === 'O' || key === 'u' || key === 'U') {
      event.preventDefault();
    }
  }, false);

  window.addEventListener('error', function (event) {
    if (event && event.error) reportError('运行时错误', event.error);
  });

  window.addEventListener('unhandledrejection', function (event) {
    if (event && event.reason) reportError('未处理的异步错误', event.reason);
  });

  document.addEventListener('DOMContentLoaded', boot);
})();

/* 技术演示台 · 渲染层通用小工具 */
(function () {
  'use strict';

  function append(parent, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) {
      child.forEach(function (c) { append(parent, c); });
      return;
    }
    if (child instanceof Node) { parent.appendChild(child); return; }
    parent.appendChild(document.createTextNode(String(child)));
  }

  /**
   * 创建元素。约定：
   *  - class / text / html / style{} / dataset{} / on*
   *  - 其余字符串按属性处理
   */
  function el(tag, opts, children) {
    var node = document.createElement(tag);
    if (opts) {
      Object.keys(opts).forEach(function (key) {
        var value = opts[key];
        if (value == null || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
        else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
        else if (key.slice(0, 2) === 'on' && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else node.setAttribute(key, value === true ? '' : String(value));
      });
    }
    append(node, children);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  var ICONS = {
    logo: '<svg viewBox="0 0 48 48" width="26" height="26" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f0d089"/><stop offset="1" stop-color="#c9963f"/></linearGradient></defs><rect x="4" y="4" width="40" height="40" rx="10" fill="url(#lg)" opacity="0.16"/><rect x="4.5" y="4.5" width="39" height="39" rx="9.5" fill="none" stroke="#d8ae62" stroke-opacity="0.65"/><g stroke="#d8ae62" stroke-opacity="0.5" stroke-width="1"><path d="M14 8v32M24 8v32M34 8v32M8 14h32M8 24h32M8 34h32"/></g><circle cx="17" cy="20" r="5" fill="#12161d" stroke="#8d939d"/><circle cx="30" cy="29" r="5" fill="#f4f1ea" stroke="#b9b3a7"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13l11-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
    restart: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>',
    hand: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" d="M8 11V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5V4.8a1.5 1.5 0 0 1 3 0V11m0-1.2V6.3a1.5 1.5 0 0 1 3 0V13c0 3.9-2.6 7-6.5 7S8 17.4 8 13.5V11"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3z"/></svg>',
    key: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M14 2a8 8 0 0 0-7.6 10.5L2 17v5h5l1-2h2v-2h2l1.2-1.2A8 8 0 1 0 14 2zm3 6a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" d="M4 12.5l5 5L20 6.5"/></svg>',
    warn: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 2 1 21h22zm0 6 6.5 11h-13zM11 10h2v5h-2zm0 6h2v2h-2z"/></svg>',
    cpu: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M7 7h10v10H7zM4 9h3M4 12h3M4 15h3M17 9h3M17 12h3M17 15h3M9 4v3M12 4v3M15 4v3M9 17v3M12 17v3M15 17v3"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.2 9.5 3.75 3.75 0 0 0 7 18z"/></svg>'
  };

  function icon(name) {
    var span = document.createElement('span');
    span.className = 'ico';
    span.innerHTML = ICONS[name] || '';
    return span;
  }

  var toastHost = null;
  function toast(message, kind, timeout) {
    if (!toastHost) toastHost = document.getElementById('toast-host');
    if (!toastHost) return;
    var node = el('div', { class: 'toast toast-' + (kind || 'info') }, [
      icon(kind === 'error' ? 'warn' : kind === 'success' ? 'check' : 'cpu'),
      el('span', { text: String(message) })
    ]);
    toastHost.appendChild(node);
    requestAnimationFrame(function () { node.classList.add('show'); });
    setTimeout(function () {
      node.classList.remove('show');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 320);
    }, timeout || 3600);
    return node;
  }

  function fmtDuration(ms) {
    var n = Number(ms) || 0;
    if (n < 1000) return n + 'ms';
    if (n < 60000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 's';
    return Math.floor(n / 60000) + 'm' + Math.round((n % 60000) / 1000) + 's';
  }

  function fmtClock(date) {
    var d = date || new Date();
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, ms || 0)); });
  }

  function coordLabel(move) {
    if (!move || move.length < 2) return '--';
    return '(' + move[0] + ',' + move[1] + ')';
  }

  window.UI = {
    el: el,
    clear: clear,
    icon: icon,
    toast: toast,
    fmtDuration: fmtDuration,
    fmtClock: fmtClock,
    delay: delay,
    coordLabel: coordLabel,
    ICONS: ICONS
  };
})();

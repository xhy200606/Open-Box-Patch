/*!
 * Open-Box 多后端管理补丁 · 前端注入脚本
 * ---------------------------------------------------------------
 * 在面板左下角「运行时长」下方加入一个「后端」管理区：
 *   · 添加 / 删除后端（名称 + 地址，保存在浏览器 localStorage）
 *   · 每 15 秒探测在线 / 离线（GET /api/health，no-cors 可达性探测）
 *   · 点击后端在新标签页打开对应面板
 * 自包含、零第三方依赖。由 apply.sh 幂等注入 index.html。
 *
 * 设计约束（为什么这样做）：
 *   · 面板前端是 Vue3 + Vite 构建的 SPA，入口脚本名带版本 hash，
 *     直接改 bundle 不可持续；改为在 index.html 追加本脚本，跨版本稳定。
 *   · 面板 API 是同源 + Cookie 会话，且未配置 CORS，因此跨后端读取状态
 *     会受浏览器同源策略限制；在线状态改用 no-cors 可达性探测（不读响应体）。
 *   · 后端列表存 localStorage，与面板文件、上游升级完全隔离。
 */
(function () {
  'use strict';
  if (window.__obMultiBackend) return;
  window.__obMultiBackend = true;

  var STORAGE_KEY = 'openbox.multiBackend.v1';
  var WIDGET_ID = 'ob-multi-backend';
  // 「运行时长」在三种语言下的文案，用于锚定插入点
  var UPTIME_LABELS = ['运行时长', '運行時長', 'Uptime'];
  var POLL_MS = 15000;
  var PROBE_TIMEOUT = 5000;

  var backends = load();
  var statusMap = {};
  var widgetEl = null;
  var formEl = null;

  /* ---------- 存储 ---------- */
  function load() {
    try {
      var arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(backends)); } catch (e) {}
  }
  function uid() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function normalizeUrl(u) {
    var s = String(u || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s.replace(/\/+$/, '');
  }

  /* ---------- 在线探测 ---------- */
  function probe(url) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, PROBE_TIMEOUT);
    return fetch(url + '/api/health', { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
      .then(function () { clearTimeout(timer); return true; })
      .catch(function () { clearTimeout(timer); return false; });
  }
  function refreshStatus() {
    backends.forEach(function (b) {
      var u = normalizeUrl(b.url);
      if (!u) { statusMap[b.id] = 'offline'; return; }
      statusMap[b.id] = 'checking';
      probe(u).then(function (ok) {
        if (statusMap[b.id] === 'checking') statusMap[b.id] = ok ? 'online' : 'offline';
        renderList();
      });
    });
    renderList();
  }

  /* ---------- DOM 工具 ---------- */
  function mk(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (k === 'style' && v && typeof v === 'object') {
          var str = '';
          Object.keys(v).forEach(function (p) { str += p + ':' + v[p] + ';'; });
          n.setAttribute('style', str);
        } else if (k === 'text') {
          n.textContent = v;
        } else if (k === 'class') {
          n.className = v;
        } else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          n.addEventListener(k.slice(2), v);
        } else if (v != null) {
          n.setAttribute(k, v);
        }
      });
    }
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  var S = {
    text: { 'color': 'var(--color-base-content)', 'font-size': '13px', 'line-height': '1.4' },
    muted: { 'color': 'var(--color-base-content)', 'opacity': '0.55', 'font-size': '12px' },
    dot: function (status) {
      var color = status === 'online' ? '#22c55e' : (status === 'checking' ? '#d9a406' : '#9ca3af');
      return {
        'width': '8px', 'height': '8px', 'border-radius': '9999px', 'background': color,
        'flex': '0 0 auto', 'margin-top': '4px'
      };
    }
  };

  function dot(status) {
    return mk('span', { style: S.dot(status) });
  }

  /* ---------- 列表渲染 ---------- */
  function renderList() {
    if (!widgetEl) return;
    var listEl = widgetEl.querySelector('[data-role="list"]');
    if (!listEl) return;

    var frag = document.createDocumentFragment();

    if (!backends.length) {
      frag.appendChild(mk('div', {
        style: S.muted, text: '暂无后端，点右上角 + 添加'
      }));
    } else {
      backends.forEach(function (b) {
        var st = statusMap[b.id] || 'checking';
        var nameEl = mk('span', {
          style: S.text,
          title: b.name + '\n' + normalizeUrl(b.url)
        });
        nameEl.textContent = b.name || normalizeUrl(b.url) || '(未命名)';
        nameEl.style.overflow = 'hidden';
        nameEl.style.textOverflow = 'ellipsis';
        nameEl.style.whiteSpace = 'nowrap';
        nameEl.style.flex = '1 1 auto';
        nameEl.style.minWidth = '0';

        var delEl = mk('span', {
          style: {
            'color': 'var(--color-base-content)', 'opacity': '0', 'cursor': 'pointer',
            'flex': '0 0 auto', 'font-size': '14px', 'line-height': '1',
            'transition': 'opacity .15s', 'padding': '0 2px'
          },
          text: '×',
          title: '删除 ' + b.name
        });
        delEl.addEventListener('click', function (e) {
          e.stopPropagation();
          removeBackend(b.id);
        });

        var row = mk('div', {
          'data-id': b.id,
          style: {
            'display': 'flex', 'align-items': 'center', 'gap': '8px',
            'padding': '6px 8px', 'border-radius': '8px', 'cursor': 'pointer'
          },
          onmouseover: function () {
            row.style.background = 'var(--color-base-200, rgba(128,128,128,.08))';
            delEl.style.opacity = '0.7';
          },
          onmouseout: function () {
            row.style.background = '';
            delEl.style.opacity = '0';
          },
          onclick: function () {
            var u = normalizeUrl(b.url);
            if (u) window.open(u, '_blank', 'noopener,noreferrer');
          }
        }, [dot(st), nameEl, delEl]);

        frag.appendChild(row);
      });
    }

    listEl.innerHTML = '';
    listEl.appendChild(frag);
  }

  function removeBackend(id) {
    backends = backends.filter(function (b) { return b.id !== id; });
    delete statusMap[id];
    save();
    renderList();
  }

  /* ---------- 添加表单 ---------- */
  function toggleForm(show) {
    if (!formEl) return;
    formEl.style.display = show ? 'block' : 'none';
    if (show) {
      var nameInput = formEl.querySelector('[data-role="name"]');
      if (nameInput) nameInput.focus();
    }
  }

  function buildForm() {
    var nameInput = mk('input', {
      'data-role': 'name', placeholder: '名称（如：家里路由器）', type: 'text',
      style: {
        'width': '100%', 'box-sizing': 'border-box', 'padding': '6px 8px',
        'border-radius': '8px', 'border': '1px solid var(--color-base-300, rgba(128,128,128,.25))',
        'background': 'transparent', 'color': 'var(--color-base-content)', 'font-size': '13px', 'margin-bottom': '6px'
      }
    });
    var urlInput = mk('input', {
      'data-role': 'url', placeholder: '地址（如：192.168.1.2:3036）', type: 'text',
      style: {
        'width': '100%', 'box-sizing': 'border-box', 'padding': '6px 8px',
        'border-radius': '8px', 'border': '1px solid var(--color-base-300, rgba(128,128,128,.25))',
        'background': 'transparent', 'color': 'var(--color-base-content)', 'font-size': '13px', 'margin-bottom': '8px'
      }
    });

    function submit() {
      var name = nameInput.value.trim();
      var url = normalizeUrl(urlInput.value);
      if (!url) { urlInput.focus(); return; }
      backends.push({ id: uid(), name: name || url.replace(/^https?:\/\//, ''), url: url });
      save();
      renderList();
      refreshStatus();
      toggleForm(false);
      nameInput.value = '';
      urlInput.value = '';
    }

    var saveBtn = mk('button', {
      type: 'button', text: '保存',
      style: {
        'cursor': 'pointer', 'padding': '4px 12px', 'border-radius': '8px',
        'border': '1px solid var(--color-base-300, rgba(128,128,128,.25))',
        'background': 'transparent', 'color': 'var(--color-base-content)', 'font-size': '13px'
      }
    });
    saveBtn.addEventListener('click', submit);

    var cancelBtn = mk('button', {
      type: 'button', text: '取消',
      style: {
        'cursor': 'pointer', 'padding': '4px 12px', 'border-radius': '8px',
        'border': 'none', 'background': 'transparent', 'color': 'var(--color-base-content)',
        'opacity': '.6', 'font-size': '13px', 'margin-left': '4px'
      }
    });
    cancelBtn.addEventListener('click', function () { toggleForm(false); });

    function onKey(e) { if (e.key === 'Enter') submit(); }
    nameInput.addEventListener('keydown', onKey);
    urlInput.addEventListener('keydown', onKey);

    return mk('div', { 'data-role': 'form', style: { 'margin-top': '6px' } },
      [nameInput, urlInput, saveBtn, cancelBtn]);
  }

  /* ---------- 整体组件 ---------- */
  function buildWidget() {
    var titleEl = mk('span', { style: S.text, text: '后端' });
    titleEl.style.fontWeight = '600';

    var addBtn = mk('span', {
      text: '+', title: '添加后端',
      style: {
        'cursor': 'pointer', 'font-size': '16px', 'line-height': '1',
        'color': 'var(--color-base-content)', 'opacity': '.7', 'padding': '0 4px'
      }
    });
    addBtn.addEventListener('click', function () {
      toggleForm(formEl.style.display === 'none');
    });

    var head = mk('div', {
      style: { 'display': 'flex', 'align-items': 'center', 'justify-content': 'space-between' }
    }, [titleEl, addBtn]);

    var listEl = mk('div', { 'data-role': 'list' });
    formEl = buildForm();
    formEl.style.display = 'none';

    var box = mk('div', { id: WIDGET_ID }, [head, listEl, formEl]);
    box.style.cssText = [
      'padding: 10px 12px',
      'border: 1px solid var(--color-base-300, rgba(128,128,128,.25))',
      'border-radius: 12px',
      'background: var(--color-base-100, transparent)',
      'font-family: inherit'
    ].join(';');

    return box;
  }

  /* ---------- 锚定与挂载 ---------- */
  function findUptimeRow() {
    var nodes = document.querySelectorAll('span');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.children.length !== 0) continue; // 只看叶子节点
      var t = (n.textContent || '').trim();
      if (UPTIME_LABELS.indexOf(t) !== -1) {
        // n = 标签 span → 父级(纵向容器) → 祖父级(运行时长整行)
        return n.parentElement ? n.parentElement.parentElement : null;
      }
    }
    return null;
  }

  function mount() {
    if (!widgetEl) {
      widgetEl = buildWidget();
      renderList();
      refreshStatus();
    }
    if (!widgetEl.parentElement) {
      var row = findUptimeRow();
      if (row && row.parentElement) {
        row.parentElement.insertBefore(widgetEl, row.nextSibling);
      }
    }
  }

  function start() {
    mount();
    // SPA 重渲染或路由切换可能移除注入节点，用 MutationObserver 兜底重挂
    var obs = new MutationObserver(function () {
      if (widgetEl && !widgetEl.parentElement) mount();
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // 定期刷新在线状态
    setInterval(refreshStatus, POLL_MS);

    // 首次 DOM 尚未就绪时稍后重试
    if (!widgetEl.parentElement) {
      var retries = 0;
      var timer = setInterval(function () {
        retries++;
        if (widgetEl.parentElement || retries > 40) clearInterval(timer);
        else mount();
      }, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

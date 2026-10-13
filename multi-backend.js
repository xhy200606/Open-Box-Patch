/*!
 * Open-Box 多后端管理补丁 · 前端注入脚本
 * ---------------------------------------------------------------
 * 在面板左下角「运行时长」下方加入「后端」管理区，对齐 zashboard 的多后端模型：
 *   · 数据模型与 zashboard 一致：{ uuid, protocol, host, port, secondaryPath, label, password }
 *   · 自动识别当前面板，作为默认后端（首位、标记「当前」、不可删除）
 *   · 每个后端各自一个密码；切换需经服务端代理用密码真认证（POST /api/auth/login）
 *   · 在线 / 版本 / 内核运行时长由代理聚合；代理不可用时回退为 no-cors 可达性探测
 *   · 点击后端**在当前页面原地显示**：代理把目标面板反向代理到自身根路径，用一个
 *     铺满视口的 iframe 呈现，顶层网页地址保持不变（不跳转、不开新标签）
 *
 * 为什么需要服务端代理：Open-Box 面板只认 Cookie 会话、未开 CORS，浏览器既无法跨域
 * 认证到另一台面板；跨站 iframe 里 SameSite=Lax 的会话 Cookie 也不会随请求发出。
 * 由同机的 openbox-mb-proxy 在服务端登录目标面板并反向代理，两个问题一起解决。
 *
 * 自包含、零第三方依赖。由 apply.sh 幂等注入 index.html。
 */
(function () {
  'use strict'
  if (window.__obMultiBackend) return
  window.__obMultiBackend = true

  /* ================= 常量与状态 ================= */
  var STORAGE_KEY = 'openbox.mb.backends.v2'
  var LEGACY_KEY = 'openbox.multiBackend.v1'
  var PROXY_KEY = 'openbox.mb.proxy.v2'
  var COPY_KEY = 'openbox.mb.copy.v2'
  var ACTIVE_KEY = 'openbox.mb.active.v2'
  var WIDGET_ID = 'ob-multi-backend'
  var MODAL_ID = 'ob-multi-backend-modal'
  var VIEW_ID = 'ob-multi-backend-view'
  var UPTIME_LABELS = ['运行时长', '運行時長', 'Uptime']
  var SELF_UUID = 'self'
  var DEFAULT_PROXY_PORT = 3037
  var STATUS_INTERVAL = 30000
  var REQUEST_TIMEOUT = 8000

  var backends = []
  var proxyBase = ''
  var copyOnSwitch = false
  var statusMap = {} // uuid -> { online, authenticated, version, uptimeSeconds, coreRunning }
  var widgetEl = null
  var modalEl = null
  var modalView = 'list'
  var editingUuid = null

  // 原地显示（覆盖层）状态
  var viewEl = null
  var viewFrame = null
  var viewMask = null
  var viewDotEl = null
  var viewLabelEl = null
  var viewSelectEl = null
  var activeUuid = null
  var legacyMigrated = false
  var nativeFetch = window.fetch.bind(window)

  // Route the panel's API traffic through the authenticated backend session while
  // keeping the original panel DOM and shell in place.
  function routeApiUrl(input) {
    if (!activeUuid || activeUuid === SELF_UUID) return null
    var b = find(activeUuid)
    if (!b) return null
    var raw = typeof input === 'string' ? input : input && input.url
    if (!raw) return null
    var u
    try { u = new URL(raw, location.href) } catch (e) { return null }
    if (!/^\/api\/(?!mb\/)/.test(u.pathname)) return null
    return proxyBase.replace(/\/+$/, '') + '/__mb/target/' + b64uEncode(baseUrlOf(b)) + u.pathname + u.search
  }

  window.fetch = function (input, init) {
    var routed = routeApiUrl(input)
    if (!routed) return nativeFetch(input, init)
    if (typeof input !== 'string' && !(input instanceof URL)) {
      try { input = new Request(routed, input) } catch (e) { input = routed }
    } else input = routed
    return nativeFetch(input, init)
  }

  var NativeXHR = window.XMLHttpRequest
  if (NativeXHR) {
    var nativeOpen = NativeXHR.prototype.open
    NativeXHR.prototype.open = function (method, url) {
      var routed = routeApiUrl(String(url))
      arguments[1] = routed || url
      return nativeOpen.apply(this, arguments)
    }
  }

  var NativeWebSocket = window.WebSocket
  if (NativeWebSocket) window.WebSocket = function (url, protocols) {
    try {
      var u = new URL(url, location.href)
      if (activeUuid && activeUuid !== SELF_UUID && /^\/api\//.test(u.pathname)) {
        var b = find(activeUuid)
        if (b) {
          var p = new URL(proxyBase)
          u.protocol = p.protocol === 'https:' ? 'wss:' : 'ws:'
          u.host = p.host
          u.pathname = '/__mb/target/' + b64uEncode(baseUrlOf(b)) + u.pathname
          url = u.href
        }
      }
    } catch (e) {}
    return protocols ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url)
  }
  if (NativeWebSocket) window.WebSocket.prototype = NativeWebSocket.prototype

  /* ================= 工具 ================= */
  function uid() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  }

  // 规范化任意输入为 'proto://host:port/path'；非法返回 ''
  function normalizeBase(raw) {
    var s = String(raw || '').trim()
    if (!s) return ''
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s
    try {
      var u = new URL(s)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
      var path = u.pathname.replace(/\/+$/, '')
      return u.protocol + '//' + u.host + path
    } catch (e) {
      return ''
    }
  }

  function baseUrlOf(b) {
    return b.protocol + '://' + b.host + ':' + b.port + (b.secondaryPath || '')
  }

  function fmtUptime(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return ''
    var d = Math.floor(sec / 86400)
    var h = Math.floor((sec % 86400) / 3600)
    var m = Math.floor((sec % 3600) / 60)
    if (d > 0) return d + '天' + h + '小时'
    if (h > 0) return h + '小时' + m + '分'
    return m + '分钟'
  }

  // 极简 DOM 构造：style 传对象、text 传文本、on* 传函数、其余 setAttribute
  function mk(tag, attrs, children) {
    var n = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k]
        if (k === 'style' && v && typeof v === 'object') {
          var str = ''
          Object.keys(v).forEach(function (p) {
            str += p + ':' + v[p] + ';'
          })
          n.setAttribute('style', str)
        } else if (k === 'text') {
          n.textContent = v
        } else if (k === 'class') {
          n.className = v
        } else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          n.addEventListener(k.slice(2), v)
        } else if (v != null) {
          n.setAttribute(k, v)
        }
      })
    }
    ;(children || []).forEach(function (c) {
      if (c) n.appendChild(c)
    })
    return n
  }

  var CLR = {
    text: 'var(--color-base-content)',
    border: '1px solid var(--color-base-300, rgba(128,128,128,.25))',
    card: 'var(--color-base-100, transparent)',
    hover: 'var(--color-base-200, rgba(128,128,128,.08))',
  }

  function dotColor(status) {
    if (!status) return '#9ca3af'
    if (status.online === false) return '#9ca3af'
    if (status.authenticated === false) return '#d9a406' // 可达但未认证
    return '#22c55e'
  }

  function statusDot(status) {
    return mk('span', {
      style: {
        width: '8px',
        height: '8px',
        'border-radius': '9999px',
        background: dotColor(status),
        flex: '0 0 auto',
        'margin-top': '5px',
      },
    })
  }

  /* ================= 存储 ================= */
  function detectSelf() {
    var protocol = (location.protocol || 'http:').replace(':', '')
    var host = location.hostname || '127.0.0.1'
    var port = location.port || (protocol === 'https' ? '443' : '80')
    return {
      uuid: SELF_UUID,
      protocol: protocol,
      host: host,
      port: String(port),
      secondaryPath: '',
      label: '本机（当前面板）',
      password: '',
      isSelf: true,
    }
  }

  function load() {
    var list = []
    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
      if (Array.isArray(raw)) list = raw
    } catch (e) {}
    // 迁移旧版简单模型 {id,name,url}
    if (!list.length) {
      try {
        var legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]')
        if (Array.isArray(legacy)) {
          list = legacy
            .map(function (o) {
              var base = normalizeBase(o.url || '')
              if (!base) return null
              var u = new URL(base)
              return {
                uuid: uid(),
                protocol: u.protocol.replace(':', ''),
                host: u.hostname,
                port: u.port || (u.protocol === 'https:' ? '443' : '80'),
                secondaryPath: u.pathname.replace(/\/+$/, ''),
                label: o.name || o.label || u.hostname,
                password: o.password || '',
              }
            })
            .filter(Boolean)
          if (list.length) legacyMigrated = true
        }
      } catch (e) {}
    }
    // 过滤非法项 + 去重 self
    list = list.filter(function (b) {
      return b && b.uuid && b.host && b.port && b.uuid !== SELF_UUID
    })
    return list
  }

  function save() {
    try {
      var raw = backends.filter(function (b) {
        return b.uuid !== SELF_UUID
      })
      localStorage.setItem(STORAGE_KEY, JSON.stringify(raw))
    } catch (e) {}
  }

  function ensureSelf() {
    var self = detectSelf()
    backends = backends.filter(function (b) {
      return b.uuid !== SELF_UUID
    })
    backends.unshift(self)
    return self
  }

  function loadProxy() {
    try {
      var v = localStorage.getItem(PROXY_KEY)
      if (v) return v
    } catch (e) {}
    var proto = location.protocol === 'https:' ? 'https' : 'http'
    return proto + '://' + (location.hostname || '127.0.0.1') + ':' + DEFAULT_PROXY_PORT
  }

  function saveProxy() {
    try {
      localStorage.setItem(PROXY_KEY, proxyBase)
      localStorage.setItem(COPY_KEY, copyOnSwitch ? '1' : '0')
    } catch (e) {}
  }

  function find(uuid) {
    for (var i = 0; i < backends.length; i++) if (backends[i].uuid === uuid) return backends[i]
    return null
  }

  /* ================= 状态获取 ================= */
  function fetchTimeout(url, opts, ms) {
    var ctrl = new AbortController()
    var t = setTimeout(function () {
      ctrl.abort()
    }, ms || REQUEST_TIMEOUT)
    return fetch(url, Object.assign({ signal: ctrl.signal }, opts || {})).finally(function () {
      clearTimeout(t)
    })
  }

  // 当前面板：同源直读（携带 Cookie）
  function fetchSelfStatus() {
    var p = Promise.all([
      fetchTimeout('/api/openbox/update/status', { credentials: 'same-origin' }).then(function (r) {
        return r.ok ? r.json() : null
      }).catch(function () {
        return null
      }),
      fetchTimeout('/api/openbox/service/status', { credentials: 'same-origin' }).then(function (r) {
        return r.ok ? r.json() : null
      }).catch(function () {
        return null
      }),
    ])
    return p.then(function (arr) {
      var upd = arr[0]
      var svc = arr[1]
      var out = { online: true, authenticated: true }
      if (upd) {
        out.version = upd.version || ''
      }
      if (svc && svc.core) {
        out.coreRunning = Boolean(svc.core.running)
        out.uptimeSeconds = Number.isFinite(svc.core.uptimeSeconds) ? svc.core.uptimeSeconds : null
      }
      return out
    }).catch(function () {
      return { online: true, authenticated: true }
    })
  }

  // 其它后端：经代理认证并聚合
  function fetchProxyStatus(b) {
    return fetchTimeout(proxyBase + '/api/mb/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: baseUrlOf(b), password: b.password || '' }),
    })
      .then(function (r) {
        return r.ok ? r.json() : null
      })
      .then(function (j) {
        if (j && typeof j === 'object') return j
        return proxyPing(b)
      })
      .catch(function () {
        return proxyPing(b)
      })
  }

  // 代理不可用时：no-cors 可达性探测（不读响应体，规避 CORS）
  function proxyPing(b) {
    var ctrl = new AbortController()
    var t = setTimeout(function () {
      ctrl.abort()
    }, 5000)
    return fetch(baseUrlOf(b) + '/api/health', { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
      .then(function () {
        return { online: true, authenticated: null }
      })
      .catch(function () {
        return { online: false }
      })
      .finally(function () {
        clearTimeout(t)
      })
  }

  function refreshAll() {
    var tasks = backends.map(function (b) {
      var get = b.uuid === SELF_UUID ? fetchSelfStatus() : fetchProxyStatus(b)
      return get.then(function (st) {
        statusMap[b.uuid] = st
      })
    })
    Promise.all(tasks).then(function () {
      renderWidget()
      if (modalView === 'list') renderModal()
    })
  }

  function proxyHealth() {
    return fetchTimeout(proxyBase + '/api/mb/health', {}, 4000)
      .then(function (r) {
        return r.ok ? r.json() : null
      })
      .catch(function () {
        return null
      })
  }

  /* ================= 原地显示（iframe 覆盖层） ================= */
  function b64uEncode(str) {
    try {
      var bin = ''
      if (typeof TextEncoder !== 'undefined') {
        var bytes = new TextEncoder().encode(str)
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
      } else {
        bin = unescape(encodeURIComponent(str))
      }
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    } catch (e) {
      return ''
    }
  }

  function barBtn(label, title, primary, onClick) {
    var e = mk('button', { type: 'button', text: label, title: title || label })
    e.style.cssText =
      'cursor:pointer;flex:0 0 auto;padding:4px 11px;border-radius:8px;font-size:12px;line-height:1.5;border:' +
      (primary ? 'none' : CLR.border) +
      ';background:' +
      (primary ? 'var(--color-primary, #2563eb)' : 'transparent') +
      ';color:' +
      (primary ? '#fff' : CLR.text) +
      ';'
    e.addEventListener('click', onClick)
    return e
  }

  function buildView() {
    viewDotEl = mk('span', { style: { width: '8px', height: '8px', 'border-radius': '9999px', background: '#9ca3af', flex: '0 0 auto' } })
    viewLabelEl = mk('span', { text: '' })
    viewLabelEl.style.cssText = 'font-size:13px;font-weight:600;color:' + CLR.text + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34vw;'

    viewSelectEl = mk('select')
    viewSelectEl.style.cssText =
      'flex:0 0 auto;max-width:180px;padding:4px 8px;border-radius:8px;border:1px solid var(--color-base-300, rgba(128,128,128,.25));background:transparent;color:' +
      CLR.text +
      ';font-size:12px;'
    viewSelectEl.addEventListener('change', function () {
      var v = viewSelectEl.value
      if (v && v !== activeUuid) switchTo(v)
      else viewSelectEl.value = activeUuid || SELF_UUID
    })

    var spacer = mk('span', { style: { flex: '1 1 auto' } })

    var bar = mk('div', null, [
      barBtn('← 返回本机', '关闭覆盖层，回到本机面板（Esc）', true, function () { closeView() }),
      viewDotEl,
      viewLabelEl,
      viewSelectEl,
      spacer,
      barBtn('↻ 刷新', '重新载入当前后端', false, function () { reloadView() }),
      barBtn('在新标签打开', '用独立标签页打开目标面板', false, function () {
        var b = find(activeUuid)
        if (b) window.open(baseUrlOf(b), '_blank', 'noopener,noreferrer')
      }),
    ])
    bar.style.cssText = [
      'flex: 0 0 auto',
      'display: flex',
      'align-items: center',
      'gap: 9px',
      'min-height: 46px',
      'padding: 0 12px',
      'box-sizing: border-box',
      'border-bottom: ' + CLR.border,
      'background: var(--color-base-100, #fff)',
      'font-family: inherit',
    ].join(';')

    viewFrame = mk('iframe', {
      title: 'Open-Box 后端面板',
      allow: 'clipboard-read; clipboard-write; fullscreen; autoplay',
      allowfullscreen: 'true',
    })
    viewFrame.style.cssText = 'flex:1 1 auto;width:100%;border:0;display:block;background:#fff;'

    viewMask = mk('div', { text: '正在载入后端面板…' })
    viewMask.style.cssText = [
      'position: absolute',
      'inset: 46px 0 0 0',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'font-size: 13px',
      'color: ' + CLR.text,
      'background: var(--color-base-100, #fff)',
    ].join(';')

    var box = mk('div', null, [bar, viewFrame, viewMask])
    box.style.cssText = [
      'position: fixed',
      'inset: 0',
      'z-index: 100000',
      'display: flex',
      'flex-direction: column',
      'background: var(--color-base-100, #fff)',
    ].join(';')
    viewEl = mk('div', { id: VIEW_ID }, [box])
    viewFrame.addEventListener('load', function () {
      if (viewMask) viewMask.style.display = 'none'
    })
    return viewEl
  }

  function syncView() {
    if (!viewEl || !activeUuid) return
    var b = find(activeUuid)
    // 顶部下拉：本机 + 所有后端
    if (viewSelectEl) {
      viewSelectEl.innerHTML = ''
      backends.forEach(function (x) {
        var o = mk('option', { value: x.uuid, text: x.uuid === SELF_UUID ? '本机（当前面板）' : x.label || x.host + ':' + x.port })
        if (x.uuid === activeUuid) o.selected = true
        viewSelectEl.appendChild(o)
      })
    }
    if (viewLabelEl) viewLabelEl.textContent = b ? (b.uuid === SELF_UUID ? '本机（当前面板）' : b.label || baseUrlOf(b)) : ''
    if (viewDotEl) viewDotEl.style.background = dotColor(statusMap[activeUuid])
  }

  function reloadView() {
    if (!viewFrame || !activeUuid) return
    var b = find(activeUuid)
    if (!b || b.uuid === SELF_UUID) return
    if (viewMask) viewMask.style.display = ''
    // 换一次 query 迫使 iframe 真正重新导航（同 URL 赋 src 不会重载）
    viewFrame.src = proxyBase + '/__mb/open?t=' + b64uEncode(baseUrlOf(b)) + '&r=' + Date.now()
  }

  /** 在当前页面原地展示某个后端（顶层地址不变） */
  function openView(b) {
    activeUuid = b.uuid
    try {
      sessionStorage.setItem(ACTIVE_KEY, b.uuid)
    } catch (e) {}
    if (!viewEl) buildView()
    if (!viewEl.parentElement) document.body.appendChild(viewEl)
    document.body.style.overflow = 'hidden'
    syncView()
    if (viewMask) viewMask.style.display = ''
    viewFrame.src = proxyBase + '/__mb/open?t=' + b64uEncode(baseUrlOf(b)) + '&r=' + Date.now()
    closeModal()
    renderWidget()
    // 代理与面板不同主机时，iframe 处于跨站上下文，SameSite=Lax 的绑定 Cookie 不会被发出，
    // 原地显示会停在提示页。默认部署两者同主机（只差端口）不受影响，这里给一次可见提示。
    try {
      var ph = new URL(proxyBase).hostname
      if (ph && location.hostname && ph !== location.hostname) {
        notify('提示：代理与面板不在同一主机，若覆盖层空白请把代理地址改成 ' + location.hostname)
      }
    } catch (e) {}
  }

  function closeView() {
    activeUuid = null
    try {
      sessionStorage.removeItem(ACTIVE_KEY)
    } catch (e) {}
    if (viewEl) {
      if (viewFrame) viewFrame.src = 'about:blank'
      viewEl.remove()
    }
    document.body.style.overflow = ''
    renderWidget()
  }

  /* ================= 切换 ================= */
  function switchTo(uuid) {
    var b = find(uuid)
    if (!b) return
    if (b.uuid === SELF_UUID) {
      closeView()
      activeUuid = SELF_UUID
      try { sessionStorage.removeItem(ACTIVE_KEY) } catch (e) {}
      renderWidget()
      notify('已返回本机面板')
      return
    }
    // 原地显示必须经代理反向代理；先把目标后端的认证会话在服务端建立好
    var clip = copyOnSwitch && b.password ? copyToClipboard(b.password) : Promise.resolve()

    fetchProxyStatus(b).then(function (st) {
      statusMap[b.uuid] = st
      renderWidget()
      syncView()

      if (st && st.authenticated) {
        if (copyOnSwitch && b.password) {
          clip.then(function () {
            notify('已复制密码，若目标面板要求登录可直接粘贴')
          })
        }
        closeView()
        activeUuid = b.uuid
        try { sessionStorage.setItem(ACTIVE_KEY, b.uuid) } catch (e) {}
        renderWidget()
        notify('已切换数据后端：' + (b.label || b.host))
        return
      }
      if (st && st.authenticated === false) {
        notify('密码校验未通过，请重新输入', true)
        return
      }
      if (st && st.online) {
        // 代理服务不可用：无法原地显示，退化为新标签打开，保证仍能到达该后端
        notify('代理服务不可用，已改为在新标签打开', true)
        window.open(baseUrlOf(b), '_blank', 'noopener,noreferrer')
        return
      }
      notify('后端不可达：' + baseUrlOf(b), true)
    })
  }

  /* ================= 轻提示 ================= */
  function notify(msg, isError) {
    try {
      var el = mk('div', {
        text: msg,
        style: {
          position: 'fixed',
          left: '50%',
          bottom: '32px',
          transform: 'translateX(-50%)',
          padding: '8px 16px',
          'border-radius': '10px',
          'font-size': '13px',
          'z-index': '100002',
          color: '#fff',
          background: isError ? '#dc2626' : '#111827',
          'box-shadow': '0 6px 24px rgba(0,0,0,.25)',
        },
      })
      document.body.appendChild(el)
      setTimeout(function () {
        el.remove()
      }, 2600)
    } catch (e) {}
  }

  function copyToClipboard(text) {
    // 在用户手势内同步创建 ClipboardItem，避免 await 后手势失效
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        return navigator.clipboard.write([
          new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }) }),
        ])
      }
      if (navigator.clipboard) return navigator.clipboard.writeText(text)
    } catch (e) {}
    return Promise.resolve()
  }

  /* ================= 注入点 ================= */
  function findUptimeRow() {
    var nodes = document.querySelectorAll('span')
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      if (n.children.length !== 0) continue
      var t = (n.textContent || '').trim()
      if (UPTIME_LABELS.indexOf(t) !== -1) {
        return n.parentElement ? n.parentElement.parentElement : null
      }
    }
    return null
  }

  /* ================= 侧栏小组件 ================= */
  function renderWidget() {
    if (!widgetEl) return
    var listEl = widgetEl.querySelector('[data-role="list"]')
    if (!listEl) return
    listEl.innerHTML = ''

    backends.forEach(function (b) {
      var st = statusMap[b.uuid]
      var right = ''
      if (st && st.online !== false) {
        if (st.uptimeSeconds) right = fmtUptime(st.uptimeSeconds)
        else if (st.version) right = st.version.replace(/^v/, '')
        else if (st.authenticated === false) right = '待认证'
      } else if (st && st.online === false) {
        right = '离线'
      }

      var nameEl = mk('span', { text: b.uuid === SELF_UUID ? b.label : b.label || b.host + ':' + b.port })
      nameEl.style.cssText =
        'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' +
        CLR.text +
        ';font-size:13px;'

      var isActive = b.uuid === activeUuid
      var row = mk(
        'div',
        {
          title: baseUrlOf(b),
          style: {
            display: 'flex',
            'align-items': 'flex-start',
            gap: '7px',
            padding: '4px 6px',
            'border-radius': '7px',
            background: isActive ? 'var(--color-base-200, rgba(128,128,128,.12))' : '',
            cursor: b.uuid === SELF_UUID ? 'default' : 'pointer',
          },
          onmouseover: function () {
            if (b.uuid !== SELF_UUID) row.style.background = CLR.hover
          },
          onmouseout: function () {
            row.style.background = ''
          },
          onclick: function () {
            switchTo(b.uuid)
          },
        },
        [
          statusDot(st),
          nameEl,
          right
            ? mk('span', {
                text: right,
                style: {
                  flex: '0 0 auto',
                  'font-size': '11px',
                  color: CLR.text,
                  opacity: '0.5',
                  'font-variant-numeric': 'tabular-nums',
                },
              })
            : null,
        ],
      )
      listEl.appendChild(row)
    })
  }

  function buildWidget() {
    var title = mk('span', { text: '后端' })
    title.style.cssText = 'color:' + CLR.text + ';font-weight:600;font-size:13px;'

    var gear = mk('span', { text: '⚙', title: '管理后端' })
    gear.style.cssText = 'cursor:pointer;font-size:14px;line-height:1;color:' + CLR.text + ';opacity:.7;padding:0 2px;'
    gear.addEventListener('click', function () {
      openModal('list')
    })

    var head = mk('div', { style: { display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' } }, [title, gear])
    var list = mk('div', { 'data-role': 'list', style: { 'margin-top': '4px' } })

    var box = mk('div', { id: WIDGET_ID }, [head, list])
    box.style.cssText = [
      'padding: 9px 11px',
      CLR.border.replace('1px solid', 'border:1px solid'),
      'border-radius: 12px',
      'background: ' + CLR.card,
      'font-family: inherit',
    ].join(';')
    return box
  }

  /* ================= 管理弹窗 ================= */
  function field(labelText, input) {
    var l = mk('label', { text: labelText })
    l.style.cssText = 'font-size:12px;color:' + CLR.text + ';opacity:.7;'
    return mk('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '3px' } }, [l, input])
  }

  function textInput(value, placeholder, type) {
    var i = mk('input', {
      type: type || 'text',
      value: value == null ? '' : value,
      placeholder: placeholder || '',
      autocomplete: type === 'password' ? 'current-password' : 'off',
    })
    i.style.cssText =
      'width:100%;box-sizing:border-box;padding:6px 8px;border-radius:8px;border:1px solid var(--color-base-300, rgba(128,128,128,.25));background:transparent;color:' +
      CLR.text +
      ';font-size:13px;'
    return i
  }

  function btn(label, primary, onClick) {
    var b = mk('button', { type: 'button', text: label })
    b.style.cssText =
      'cursor:pointer;padding:5px 12px;border-radius:8px;font-size:13px;border:' +
      (primary ? 'none' : CLR.border) +
      ';background:' +
      (primary ? 'var(--color-primary, #2563eb)' : 'transparent') +
      ';color:' +
      (primary ? '#fff' : CLR.text) +
      ';'
    b.addEventListener('click', onClick)
    return b
  }

  function closeModal() {
    if (modalEl) {
      modalEl.remove()
      modalEl = null
    }
  }

  function openModal(view, uuid) {
    modalView = view || 'list'
    if (uuid) editingUuid = uuid
    closeModal()
    renderModal()
  }

  function renderModal() {
    if (modalEl) modalEl.remove()
    var shell = mk('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '12px', 'min-width': '0' } })

    var title = mk('div', { style: { display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' } }, [
      mk('span', { text: modalView === 'form' ? (editingUuid ? '编辑后端' : '添加后端') : modalView === 'proxy' ? '代理服务设置' : '后端管理' }),
    ])
    title.firstChild.style.cssText = 'font-size:15px;font-weight:600;color:' + CLR.text + ';'
    var close = mk('span', { text: '×', title: '关闭' })
    close.style.cssText = 'cursor:pointer;font-size:20px;line-height:1;color:' + CLR.text + ';opacity:.6;'
    close.addEventListener('click', closeModal)
    title.appendChild(close)
    shell.appendChild(title)

    if (modalView === 'list') shell.appendChild(buildListView())
    else if (modalView === 'form') shell.appendChild(buildFormView())
    else shell.appendChild(buildProxyView())

    var box = mk('div', null, [shell])
    box.style.cssText = [
      'width: min(760px, calc(100vw - 32px))',
      'max-height: 80vh',
      'overflow: auto',
      'padding: 16px 18px',
      'border-radius: 14px',
      'background: var(--color-base-100, #fff)',
      'border: ' + CLR.border,
      'box-shadow: 0 18px 50px rgba(0,0,0,.28)',
    ].join(';')
    box.addEventListener('click', function (e) {
      e.stopPropagation()
    })

    modalEl = mk('div', { id: MODAL_ID }, [box])
    modalEl.style.cssText =
      'position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);'
    modalEl.addEventListener('click', closeModal)
    document.body.appendChild(modalEl)
  }

  function buildListView() {
    var wrap = mk('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '6px' } })

    backends.forEach(function (b) {
      var st = statusMap[b.uuid]
      var sub = baseUrlOf(b)
      if (st && st.authenticated === false) sub += '  · 密码未通过'
      else if (st && st.online === false) sub += '  · 离线'
      else if (st && st.uptimeSeconds) sub += '  · 已运行 ' + fmtUptime(st.uptimeSeconds)
      else if (st && st.version) sub += '  · ' + st.version

      var info = mk('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '2px', flex: '1 1 auto', minWidth: '0' } }, [
        mk('span', { text: b.label || b.host + ':' + b.port }),
        mk('span', { text: sub }),
      ])
      info.children[0].style.cssText = 'font-size:13px;color:' + CLR.text + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
      info.children[1].style.cssText = 'font-size:11px;color:' + CLR.text + ';opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'

      var actions = mk('div', { style: { display: 'flex', gap: '4px', flex: '0 1 auto', 'flex-wrap': 'wrap', 'justify-content': 'flex-end' } })
      if (b.uuid === SELF_UUID) {
        var cur = mk('span', { text: '当前' })
        cur.style.cssText = 'font-size:11px;color:' + CLR.text + ';opacity:.6;align-self:center;'
        actions.appendChild(cur)
      } else {
        actions.appendChild(btn('↑', false, function () { moveBackend(b.uuid, -1) }))
        actions.appendChild(btn('↓', false, function () { moveBackend(b.uuid, 1) }))
        actions.appendChild(btn('切换', false, function () { switchTo(b.uuid) }))
        actions.appendChild(btn('编辑', false, function () { editingUuid = b.uuid; openModal('form') }))
        actions.appendChild(btn('删除', false, function () {
          backends = backends.filter(function (x) { return x.uuid !== b.uuid })
          delete statusMap[b.uuid]
          if (activeUuid === b.uuid) closeView()
          save()
          renderWidget()
          renderModal()
          syncView()
        }))
      }

      var row = mk('div', { style: { display: 'flex', 'flex-wrap': 'wrap', 'align-items': 'center', gap: '8px', padding: '8px', 'border-radius': '10px', border: CLR.border } }, [
        statusDot(st),
        info,
        actions,
      ])
      wrap.appendChild(row)
    })

    var footer = mk('div', { style: { display: 'flex', 'justify-content': 'space-between', 'margin-top': '4px' } }, [
      btn('＋ 添加后端', true, function () { editingUuid = null; openModal('form') }),
      btn('代理设置', false, function () { openModal('proxy') }),
    ])
    wrap.appendChild(footer)
    return wrap
  }

  function moveBackend(uuid, delta) {
    var i = backends.findIndex(function (x) { return x.uuid === uuid })
    var j = i + delta
    if (i <= 0 || j <= 0 || j >= backends.length) return
    var item = backends.splice(i, 1)[0]
    backends.splice(j, 0, item)
    save()
    renderWidget()
    renderModal()
    syncView()
  }

  function buildFormView() {
    var b = editingUuid ? find(editingUuid) : null
    var isEdit = Boolean(b)
    var model = isEdit
      ? JSON.parse(JSON.stringify(b))
      : { uuid: uid(), protocol: 'http', host: '', port: '3036', secondaryPath: '', label: '', password: '' }

    var proto = mk('select')
    ;['http', 'https'].forEach(function (p) {
      var o = mk('option', { value: p, text: p.toUpperCase() })
      if (model.protocol === p) o.selected = true
      proto.appendChild(o)
    })
    proto.style.cssText = 'padding:6px 8px;border-radius:8px;border:1px solid var(--color-base-300, rgba(128,128,128,.25));background:transparent;color:' + CLR.text + ';font-size:13px;'
    var host = textInput(model.host, '192.168.1.2')
    var port = textInput(model.port, '3036')
    var path = textInput(model.secondaryPath, '（可选，如 /openbox）')
    var label = textInput(model.label, '如：家里路由器')
    var pass = textInput(model.password, '面板登录密码', 'password')

    var hostRow = mk('div', { style: { display: 'flex', gap: '8px' } }, [
      mk('div', { style: { flex: '0 0 92px' } }, [field('协议', proto)]),
      mk('div', { style: { flex: '1 1 auto', 'min-width': '0' } }, [field('主机 / IP', host)]),
      mk('div', { style: { flex: '0 0 84px' } }, [field('端口', port)]),
    ])

    var status = mk('div', { text: '' })
    status.style.cssText = 'font-size:12px;color:' + CLR.text + ';opacity:.7;min-height:16px;'

    function collect() {
      model.protocol = proto.value
      model.host = host.value.trim()
      model.port = String(port.value || '').trim()
      model.secondaryPath = path.value.trim().replace(/\/+$/, '')
      model.label = label.value.trim()
      model.password = pass.value
      return model
    }

    function valid() {
      var m = collect()
      return m.host && /^\d+$/.test(m.port) && Number(m.port) > 0 && Number(m.port) < 65536 && m.password
    }

    var testBtn = btn('测试连接', false, function () {
      var m = collect()
      if (!m.host || !m.port) { status.textContent = '请先填写主机与端口'; return }
      testBtn.disabled = true
      status.textContent = '测试中…'
      fetchTimeout(proxyBase + '/api/mb/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: baseUrlOf(m), password: m.password }),
      })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (j) {
          if (!j) { status.textContent = '代理服务不可用（' + proxyBase + '）'; return }
          if (j.online === false) { status.textContent = '不可达：' + baseUrlOf(m); return }
          if (j.authenticated) status.textContent = '连接成功' + (j.version ? '，版本 ' + j.version : '')
          else status.textContent = '可达，但密码校验未通过'
        })
        .catch(function () { status.textContent = '代理服务不可用（' + proxyBase + '）' })
        .finally(function () { testBtn.disabled = false })
    })

    var saveBtn = btn('保存', true, function () {
      if (!valid()) { status.textContent = '主机、端口、密码为必填'; return }
      var m = collect()
      if (isEdit) {
        var i = backends.indexOf(b)
        backends[i] = Object.assign({}, b, m)
      } else {
        backends.push(m)
      }
      save()
      editingUuid = m.uuid
      openModal('list')
      syncView()
      refreshAll()
    })

    var cancelBtn = btn('取消', false, function () { openModal('list') })

    var wrap = mk('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } }, [
      hostRow,
      field('路径前缀（可选）', path),
      field('名称', label),
      field('密码', pass),
      status,
      mk('div', { style: { display: 'flex', gap: '8px', 'justify-content': 'flex-end', 'margin-top': '2px' } }, [testBtn, cancelBtn, saveBtn]),
    ])
    return wrap
  }

  function buildProxyView() {
    var input = textInput(proxyBase, 'http://主机:3037')
    var status = mk('div', { text: '' })
    status.style.cssText = 'font-size:12px;color:' + CLR.text + ';opacity:.7;min-height:16px;'

    var check = mk('input', { type: 'checkbox' })
    if (copyOnSwitch) check.checked = true
    var checkRow = mk('label', { style: { display: 'flex', 'align-items': 'center', gap: '6px', 'font-size': '12px', color: CLR.text, opacity: '.8' } }, [
      check,
      mk('span', { text: '切换时也把密码复制到剪贴板（兜底：目标面板偶发要求重新登录时可直接粘贴）' }),
    ])

    var testBtn = btn('测试', false, function () {
      proxyBase = input.value.trim().replace(/\/+$/, '')
      status.textContent = '测试中…'
      proxyHealth().then(function (j) {
        status.textContent = j && j.ok ? '代理服务正常（' + (j.version || '') + '）' : '代理服务不可用'
      })
    })

    var saveBtn = btn('保存', true, function () {
      proxyBase = input.value.trim().replace(/\/+$/, '')
      copyOnSwitch = check.checked
      saveProxy()
      openModal('list')
      refreshAll()
    })

    return mk('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } }, [
      field('代理服务地址', input),
      mk('div', { style: { 'font-size': '11px', color: CLR.text, opacity: '.5', 'line-height': '1.5' } }, [
        mk('span', { text: '默认 http://<本机>:3037，由 openbox-mb-proxy 提供。它两件事都做：在服务端用密码登录其它后端（真认证 + 状态聚合），并把目标面板反向代理出来供本页原地显示。' }),
      ]),
      checkRow,
      status,
      mk('div', { style: { display: 'flex', gap: '8px', 'justify-content': 'flex-end' } }, [testBtn, saveBtn]),
    ])
  }

  /* ================= 挂载 ================= */
  function mountWidget() {
    if (!widgetEl) widgetEl = buildWidget()
    if (!widgetEl.parentElement) {
      var row = findUptimeRow()
      if (row && row.parentElement) row.parentElement.insertBefore(widgetEl, row.nextSibling)
    }
  }

  function start() {
    backends = load()
    ensureSelf()
    proxyBase = loadProxy()
    try {
      copyOnSwitch = localStorage.getItem(COPY_KEY) === '1' // 默认关：原地显示已由代理完成认证
    } catch (e) {}

    // 旧版模型迁移只做一次：落盘到新键并清掉旧键，免得每次启动重复迁移
    if (legacyMigrated) {
      save()
      try {
        localStorage.removeItem(LEGACY_KEY)
      } catch (e) {}
    }

    mountWidget()
    renderWidget()
    refreshAll()

    // Esc 关闭原地显示，回到本机面板
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && activeUuid) closeView()
    })

    // 刷新页面后恢复上一次正在查看的后端（同一标签页内有效）
    try {
      var last = sessionStorage.getItem(ACTIVE_KEY)
      if (last && find(last)) switchTo(last)
    } catch (e) {}

    var obs = new MutationObserver(function () {
      if (widgetEl && !widgetEl.parentElement) mountWidget()
    })
    obs.observe(document.body, { childList: true, subtree: true })

    setInterval(function () {
      if (!widgetEl || !widgetEl.parentElement) mountWidget()
      else refreshAll()
      syncView()
    }, STATUS_INTERVAL)

    if (!widgetEl.parentElement) {
      var n = 0
      var timer = setInterval(function () {
        n++
        if ((widgetEl && widgetEl.parentElement) || n > 40) clearInterval(timer)
        else mountWidget()
      }, 500)
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()

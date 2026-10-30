/*!
 * Open-Box 多后端管理补丁 · 前端注入脚本
 * ---------------------------------------------------------------
 * 在面板左下角「运行时长」下方加入「后端」管理区，对齐 zashboard 的多后端模型：
 *   · 数据模型与 zashboard 一致：{ uuid, protocol, host, port, secondaryPath, label, password }
 *   · 自动识别当前面板，作为默认后端（首位、标记「当前」、不可删除）
 *   · 每个后端各自一个密码；切换需经服务端代理用密码真认证（POST /api/auth/login）
 *   · 在线 / 版本 / 内核运行时长由代理聚合；代理不可用时回退为 no-cors 可达性探测
 *   · 保留本机前端，切换后重新加载同一页面，API 和 WebSocket 由代理转发到所选后端
 *   · 统一显示各服务器 OpenBox / Patch 版本，支持检查版本和单台、批量更新
 *
 * 为什么需要服务端代理：Open-Box 面板只认 Cookie 会话、未开 CORS，浏览器既无法跨域
 * 认证到另一台面板。
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
  var TOKEN_KEY = 'openbox.mb.proxyToken.v1'
  var COPY_KEY = 'openbox.mb.copy.v2'
  var ACTIVE_KEY = 'openbox.mb.active.v2'
  var WIDGET_ID = 'ob-multi-backend'
  var MODAL_ID = 'ob-multi-backend-modal'
  var UPTIME_LABELS = ['运行时长', '運行時長', 'Uptime']
  var SELF_UUID = 'self'
  var DEFAULT_PROXY_PORT = 3037
  var STATUS_INTERVAL = 30000
  var REQUEST_TIMEOUT = 8000

  var backends = []
  var proxyBase = ''
  var proxyToken = ''
  var serverMap = {}
  var selectedServers = {}
  var serverBusy = {}
  var settingsCard = null
  var egressCard = null
  var egressBackend = null
  var egressMenu = null
  var egressPage = null
  var egressHiddenContent = null
  var refreshingServers = false
  var switchSequence = 0
  var sorting = null
  var actionResults = {}
  var copyOnSwitch = false
  var statusMap = {} // uuid -> { online, authenticated, version, uptimeSeconds, coreRunning }
  var widgetEl = null
  var modalEl = null
  var modalView = 'list'
  var editingUuid = null

  var activeUuid = null
  var legacyMigrated = false
  var nativeFetch = window.fetch.bind(window)
  var routingReady = Promise.resolve()

  // Route the panel's API traffic through the authenticated backend session while
  // keeping the original panel DOM and shell in place.
  function routeApiUrl(input) {
    if (!activeUuid || activeUuid === SELF_UUID) return null
    var b = find(activeUuid)
    if (!b) return null
    var raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url
    if (!raw) return null
    var u
    try { u = new URL(raw, location.href) } catch (e) { return null }
    if (u.origin !== location.origin || !/^\/api\/(?!mb\/|auth\/|storage(?:\/|$)|background-image(?:\/|$))/.test(u.pathname)) return null
    return proxyBase.replace(/\/+$/, '') + '/__mb/target/' + b64uEncode(baseUrlOf(b)) + u.pathname + u.search
  }

  window.fetch = function (input, init) {
    // Connections and the route origin must come from the same backend. The
    // map normally calls our local IP proxy; have that proxy query the selected
    // server's agent instead of reporting the frontend host's egress address.
    var mapUrl
    try { mapUrl = new URL(typeof input === 'string' ? input : input.url || input.href, location.href) } catch (e) {}
    var globeRequest = proxyBase && mapUrl && [proxyBase.replace(/\/+$/, '') + '/api/mb/globe/public-ip', proxyBase.replace(/\/+$/, '') + '/api/mb/globe/relays'].indexOf(mapUrl.href.split('?')[0]) !== -1
    if (globeRequest) {
      var source = find(activeUuid || SELF_UUID)
      if (source) return nativeFetch(proxyBase + '/api/mb/server', Object.assign({}, init || {}, {
        method: 'POST', credentials: 'include',
        headers: Object.assign({}, init && init.headers || {}, { 'Content-Type': 'application/json' }, proxyToken ? { 'X-MB-Token': proxyToken } : {}),
        body: JSON.stringify({ action: mapUrl.pathname.endsWith('/relays') ? 'relayInfo' : 'publicIp', api: mapUrl.searchParams.get('api') || 'ip.sb', isSelf: source.uuid === SELF_UUID,
          url: baseUrlOf(source), password: source.password || '', agentUrl: source.uuid === SELF_UUID ? proxyBase : source.agentUrl || '', agentToken: source.agentToken || '' }),
      }))
    }
    var routed = routeApiUrl(input)
    if (!routed) return nativeFetch(input, init)
    if (typeof input !== 'string' && !(input instanceof URL)) {
      try { input = new Request(routed, input) } catch (e) { input = routed }
    } else input = routed
    return routingReady.then(function () { return nativeFetch(input, init) })
  }

  var NativeXHR = window.XMLHttpRequest
  if (NativeXHR) {
    var nativeOpen = NativeXHR.prototype.open
    var nativeSend = NativeXHR.prototype.send
    var nativeAbort = NativeXHR.prototype.abort
    NativeXHR.prototype.open = function (method, url) {
      var routed = routeApiUrl(String(url))
      this.__obRoute = Boolean(routed) && arguments[2] !== false
      this.__obGeneration = (this.__obGeneration || 0) + 1
      arguments[1] = routed || url
      return nativeOpen.apply(this, arguments)
    }
    NativeXHR.prototype.send = function (body) {
      if (!this.__obRoute) return nativeSend.call(this, body)
      var xhr = this
      var generation = xhr.__obGeneration
      routingReady.then(function () {
        if (generation === xhr.__obGeneration) nativeSend.call(xhr, body)
      }).catch(function () { xhr.dispatchEvent(new Event('error')); xhr.dispatchEvent(new Event('loadend')) })
    }
    NativeXHR.prototype.abort = function () {
      this.__obGeneration = (this.__obGeneration || 0) + 1
      return nativeAbort.call(this)
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
  if (NativeWebSocket) Object.setPrototypeOf(window.WebSocket, NativeWebSocket)

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
      label: '本机（主面板）',
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
      localStorage.setItem(TOKEN_KEY, proxyToken)
      localStorage.setItem(COPY_KEY, copyOnSwitch ? '1' : '0')
    } catch (e) {}
  }

  function find(uuid) {
    for (var i = 0; i < backends.length; i++) if (backends[i].uuid === uuid) return backends[i]
    return null
  }

  /* ================= 状态获取 ================= */
  function fetchTimeout(url, opts, ms, useNative) {
    if (proxyBase && url.indexOf(proxyBase + '/api/mb/') === 0) {
      opts = Object.assign({}, opts || {}, { credentials: 'include', headers: Object.assign({}, opts && opts.headers || {}, proxyToken ? { 'X-MB-Token': proxyToken } : {}) })
    }
    var ctrl = new AbortController()
    var t = setTimeout(function () {
      ctrl.abort()
    }, ms || REQUEST_TIMEOUT)
    return (useNative ? nativeFetch : fetch)(url, Object.assign({ signal: ctrl.signal }, opts || {})).finally(function () {
      clearTimeout(t)
    })
  }

  // 当前面板：同源直读（携带 Cookie）
  function fetchSelfStatus() {
    var p = Promise.all([
      fetchTimeout('/api/openbox/update/status', { credentials: 'same-origin' }, REQUEST_TIMEOUT, true).then(function (r) {
        return r.ok ? r.json() : null
      }).catch(function () {
        return null
      }),
      fetchTimeout('/api/openbox/service/status', { credentials: 'same-origin' }, REQUEST_TIMEOUT, true).then(function (r) {
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
      if (modalEl && modalView === 'list') renderModal()
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

  /* ================= 请求目标编码 ================= */
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

  function syncView() {
    renderSettingsCard()
    mountEgressNavigation()
  }

  function closeView() {
    activeUuid = null
    try { sessionStorage.removeItem(ACTIVE_KEY) } catch (e) {}
    renderWidget()
  }

  /* ================= 切换 ================= */
  function switchTo(uuid) {
    var b = find(uuid)
    if (!b) return
    var sequence = ++switchSequence
    if (b.uuid === SELF_UUID) {
      closeView()
      activeUuid = SELF_UUID
      try { sessionStorage.removeItem(ACTIVE_KEY) } catch (e) {}
      renderWidget()
      notify('已返回本机面板')
      location.reload()
      return
    }
    // 原地显示必须经代理反向代理；先把目标后端的认证会话在服务端建立好
    var clip = copyOnSwitch && b.password ? copyToClipboard(b.password) : Promise.resolve()

    fetchProxyStatus(b).then(function (st) {
      if (sequence !== switchSequence) return
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
        location.reload()
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
    var current = find(activeUuid || SELF_UUID)
    if (!widgetEl) return
    var currentLabel = widgetEl.querySelector('[data-role="current"]')
    if (currentLabel) {
      currentLabel.textContent = '当前：' + (current && (current.label || current.host) || '本机')
      currentLabel.title = currentLabel.textContent
    }
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

      var isActive = b.uuid === (activeUuid || SELF_UUID)
      if (isActive) {
        nameEl.style.color = 'var(--color-primary-content, #fff)'
      }
      var row = mk(
        'div',
        {
          title: baseUrlOf(b),
          class: 'proxy-node-card' + (isActive ? ' bg-primary text-primary-content' : ''),
          'data-backend-uuid': b.uuid,
          'aria-current': isActive ? 'true' : 'false',
          style: {
            display: 'flex',
            'align-items': 'flex-start',
            gap: '7px',
            padding: '4px 6px',
            'border-radius': 'var(--app-radius-panel, var(--radius-box, 1rem))',
            border: isActive ? '1px solid color-mix(in srgb, var(--color-base-content) 16%, transparent)' : '1px solid transparent',
            cursor: isActive ? 'default' : 'pointer',
          },
          onmouseover: function () {
            if (!isActive) row.style.background = CLR.hover
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
                  color: isActive ? 'var(--color-primary-content, #fff)' : CLR.text,
                  opacity: '0.6',
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
    var current = mk('div', { 'data-role': 'current', style: { 'font-size': '12px', 'margin-top': '5px', color: 'var(--color-primary, #2563eb)', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis' } })

    var box = mk('div', { id: WIDGET_ID, class: 'card bg-base-100 border-base-300/60 border' }, [head, current, list])
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
    var b = mk('button', { type: 'button', text: label, class: 'btn btn-sm' + (primary ? ' btn-primary' : '') })
    b.style.cssText =
      'cursor:pointer;padding:5px 12px;border-radius:8px;font-size:13px;border:' +
      (primary ? 'none' : CLR.border) +
      ';background:' +
      (primary ? 'var(--color-primary, #2563eb)' : 'var(--color-base-200, rgba(128,128,128,.08))') +
      ';color:' +
      (primary ? 'var(--color-primary-content, #fff)' : CLR.text) +
      ';'
    b.addEventListener('click', onClick)
    return b
  }

  function closeModal() {
    sorting = null
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
    if (modalView === 'list') refreshServers()
  }

  function renderModal() {
    if (sorting) return
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
      'box-sizing: border-box',
      'overflow-x: hidden',
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
    var toolbar = mk('div', { style: { display: 'flex', 'flex-wrap': 'wrap', gap: '6px' } }, [
      btn('刷新版本', false, refreshServers),
      btn('批量更新 OpenBox', false, function () { updateSelected('updateOpenbox') }),
      btn('批量更新 Patch', false, function () { updateSelected('updatePatch') }),
      btn('批量重启 OpenBox', false, function () { updateSelected('restartOpenbox') }),
    ])
    wrap.appendChild(toolbar)
    wrap.appendChild(mk('div', { text: '拖动 ⠿ 调整后端顺序；本机前端固定首位。', style: { 'font-size': '12px', color: CLR.text, opacity: '.6' } }))

    backends.forEach(function (b) {
      var st = statusMap[b.uuid]
      var sub = baseUrlOf(b)
      if (st && st.authenticated === false) sub += '  · 密码未通过'
      else if (st && st.online === false) sub += '  · 离线'
      else if (st && st.uptimeSeconds) sub += '  · 已运行 ' + fmtUptime(st.uptimeSeconds)
      else if (st && st.version) sub += '  · ' + st.version

      var info = mk('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '2px', flex: '1 1 auto', 'min-width': '0' } }, [
        mk('span', { text: b.label || b.host + ':' + b.port }),
        mk('span', { text: sub }),
      ])
      info.children[0].style.cssText = 'font-size:13px;color:' + CLR.text + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
      info.children[1].style.cssText = 'font-size:11px;color:' + CLR.text + ';opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
      var checkbox = mk('input', { type: 'checkbox', class: 'checkbox checkbox-sm', 'aria-label': '选择 ' + (b.label || b.host) })
      checkbox.checked = Boolean(selectedServers[b.uuid])
      checkbox.addEventListener('change', function () { selectedServers[b.uuid] = checkbox.checked })

      var actions = mk('div', { style: { display: 'flex', gap: '4px', flex: '0 1 auto', 'flex-wrap': 'wrap', 'justify-content': 'flex-end' } })
      if (b.uuid === SELF_UUID) {
        var cur = mk('span', { text: (activeUuid || SELF_UUID) === SELF_UUID ? '当前' : '本机前端' })
        cur.style.cssText = 'font-size:11px;color:' + CLR.text + ';opacity:.6;align-self:center;'
        actions.appendChild(cur)
        if (activeUuid && activeUuid !== SELF_UUID) actions.appendChild(btn('切换', false, function () { switchTo(SELF_UUID) }))
      } else {
        actions.appendChild(btn('切换', false, function () { switchTo(b.uuid) }))
        actions.appendChild(btn('编辑', false, function () { editingUuid = b.uuid; openModal('form') }))
        actions.appendChild(btn('删除', false, function () {
          var wasActive = activeUuid === b.uuid
          backends = backends.filter(function (x) { return x.uuid !== b.uuid })
          delete statusMap[b.uuid]
          if (activeUuid === b.uuid) closeView()
          save()
          renderWidget()
          renderModal()
          syncView()
          if (wasActive) location.reload()
        }))
      }

      var row = mk('div', { 'data-backend-uuid': b.uuid, style: { display: 'flex', 'flex-wrap': 'wrap', 'align-items': 'center', gap: '8px', padding: '8px', 'border-radius': '10px', border: CLR.border } }, [
        checkbox,
        statusDot(st),
        info,
        actions,
      ])
      if (b.uuid !== SELF_UUID) row.insertBefore(sortHandle(b, row, wrap), checkbox)
      row.appendChild(buildVersionControls(b))
      wrap.appendChild(row)
    })

    var footer = mk('div', { style: { display: 'flex', 'justify-content': 'space-between', 'margin-top': '4px' } }, [
      btn('＋ 添加后端', true, function () { editingUuid = null; openModal('form') }),
      btn('代理设置', false, function () { openModal('proxy') }),
    ])
    wrap.appendChild(footer)
    return wrap
  }

  function serverRequest(b, action, extra) {
    return fetchTimeout(proxyBase + '/api/mb/server', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, extra || {}, { isSelf: b.uuid === SELF_UUID, url: baseUrlOf(b), password: b.password || '',
        agentUrl: b.uuid === SELF_UUID ? proxyBase : b.agentUrl || '', agentToken: b.agentToken || '', action: action, channel: 'mirror' })),
    }, action === 'egressApply' ? 305000 : action === 'restartOpenbox' ? 65000 : 40000).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.ok === false) throw new Error(j.error || j.message || j.stderr || j.reason || '服务器请求失败')
        return j
      })
    })
  }

  function refreshServers() {
    if (refreshingServers) return Promise.resolve()
    refreshingServers = true
    return Promise.all(backends.map(function (b) {
      return serverRequest(b, 'status').then(function (j) {
        serverMap[b.uuid] = Object.assign({}, serverMap[b.uuid], j, { error: '' })
      }).catch(function (error) {
        serverMap[b.uuid] = Object.assign({}, serverMap[b.uuid], { error: error.message })
      })
    })).finally(function () {
      refreshingServers = false
      if (modalEl && modalView === 'list') renderModal()
      renderSettingsCard()
    })
  }

  function versionText(b) {
    var s = serverMap[b.uuid] || {}
    var openbox = s.openbox && s.openbox.version || statusMap[b.uuid] && statusMap[b.uuid].version || '—'
    var patch = s.patch && s.patch.patchVersion || (s.agentAvailable === false ? '代理未升级 / 不可达' : '—')
    return 'OpenBox ' + openbox + (s.latestOpenbox ? '（最新 ' + s.latestOpenbox + '）' : '') +
      ' · Patch ' + patch + (s.latestPatch ? '（最新 ' + s.latestPatch + '）' : '')
  }

  function buildVersionControls(b) {
    var s = serverMap[b.uuid] || {}
    var wrap = mk('div', { style: { flex: '1 0 100%', 'min-width': '0', display: 'flex', 'flex-direction': 'column', gap: '6px' } })
    wrap.appendChild(mk('div', { text: versionText(b), style: { 'font-size': '12px', color: CLR.text, 'overflow-wrap': 'anywhere' } }))
    var progress = s.patch && s.patch.update
    var ob = s.openbox && s.openbox.status
    var message = s.error || (serverBusy[b.uuid] ? '正在执行操作…' : actionResults[b.uuid] || '')
    if (progress && progress.state !== 'idle') message += ' Patch：' + ({ queued: '等待更新', downloading: '下载中', installing: '安装中', succeeded: '更新完成', failed: '更新失败，请查看服务器更新日志', interrupted: '更新中断' }[progress.state] || progress.state)
    if (ob && ob.running) message += ' OpenBox：' + (ob.message || ob.stage || '更新中')
    if (message) wrap.appendChild(mk('div', { text: message, style: { 'font-size': '12px', color: CLR.text, opacity: '.7' } }))
    var controls = mk('div', { style: { display: 'flex', 'flex-wrap': 'wrap', gap: '6px' } })
    controls.appendChild(btn('检查版本', false, function () {
      serverRequest(b, 'check').then(function (j) {
        serverMap[b.uuid] = Object.assign({}, serverMap[b.uuid], j)
        if (modalEl && modalView === 'list') renderModal()
        renderSettingsCard()
      }).catch(function (error) { notify(error.message, true) })
    }))
    var updateOb = btn('更新 OpenBox', false, function () { updateServers([b], 'updateOpenbox') })
    var updatePatch = btn('更新 Patch', false, function () { updateServers([b], 'updatePatch') })
    updateOb.disabled = Boolean(serverBusy[b.uuid] || ob && ob.running || progress && progress.running)
    updatePatch.disabled = updateOb.disabled || s.agentAvailable !== true
    controls.appendChild(updateOb)
    controls.appendChild(updatePatch)
    wrap.appendChild(controls)
    return wrap
  }

  function updateSelected(action) {
    var selected = backends.filter(function (b) { return selectedServers[b.uuid] })
    if (!selected.length) { notify('请先勾选要操作的服务器'); return }
    updateServers(selected, action)
  }

  function updateServers(list, action) {
    list = list.filter(function (b) {
      if (serverBusy[b.uuid]) return false
      var state = serverMap[b.uuid] || {}
      if (state.openbox && state.openbox.status && state.openbox.status.running || state.patch && state.patch.update && state.patch.update.running) {
        notify((b.label || b.host) + '：更新进行中，请等待完成', true)
        return false
      }
      if (action === 'updatePatch' && !(serverMap[b.uuid] && serverMap[b.uuid].agentAvailable)) {
        notify((b.label || b.host) + '：请先在该服务器安装新版 Patch 管理代理', true)
        return false
      }
      return true
    })
    if (!list.length) return
    var component = action === 'updatePatch' ? 'OpenBox Patch' : 'OpenBox'
    var verb = action === 'restartOpenbox' ? '重启' : '更新'
    if (!window.confirm(verb + '以下服务器的 ' + component + (action === 'restartOpenbox' ? ' 内核' : '') + '？\n' + list.map(function (b) { return b.label || b.host }).join('\n') + '\n操作期间服务可能暂时中断。')) return
    list.forEach(function (b) {
      if (serverBusy[b.uuid]) return
      serverBusy[b.uuid] = true
      delete actionResults[b.uuid]
      serverRequest(b, action).then(function () {
        actionResults[b.uuid] = action === 'restartOpenbox' ? 'OpenBox 内核重启成功' : '已提交 ' + component + ' 更新'
        notify((b.label || b.host) + '：' + actionResults[b.uuid])
      }).catch(function (error) {
        actionResults[b.uuid] = verb + '失败：' + error.message
        notify((b.label || b.host) + '：' + error.message, true)
      }).finally(function () {
        delete serverBusy[b.uuid]
        if (modalEl && modalView === 'list') renderModal()
        renderSettingsCard()
        refreshServers()
      })
    })
    if (modalEl && modalView === 'list') renderModal()
    renderSettingsCard()
  }

  function mountSettingsCard() {
    var links = document.querySelectorAll('a[href="https://github.com/liandu2024/Open-Box"]')
    var anchor = null
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('aria-label') === 'Open-Box GitHub') { anchor = links[i].closest('.card'); if (anchor) break }
    }
    if (!anchor) { if (settingsCard && settingsCard.isConnected) settingsCard.remove(); return }
    if (!settingsCard) {
      settingsCard = mk('section', { id: 'ob-patch-settings', class: 'card bg-base-100 border-base-300/60 border' })
      settingsCard.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:8px;color:' + CLR.text + ';'
    }
    if (!settingsCard.isConnected || settingsCard.previousElementSibling !== anchor) {
      anchor.after(settingsCard)
      renderSettingsCard()
      refreshServers()
    }
  }

  function renderSettingsCard() {
    if (!settingsCard || !settingsCard.isConnected) return
    var b = find(activeUuid || SELF_UUID)
    if (!b) return
    settingsCard.replaceChildren(
      mk('h2', { text: 'OpenBox Patch', style: { 'font-size': '16px', 'font-weight': '600' } }),
      mk('div', { text: '当前后端：' + (b.label || b.host), style: { 'font-size': '12px', opacity: '.7' } }),
      buildVersionControls(b),
      btn('管理所有服务器', false, function () { openModal('list') })
    )
  }

  function isEgressRoute() {
    try {
      var route = new URL(location.hash.slice(1) || '/', location.origin)
      return /\/settings\/?$/.test(route.pathname) && route.searchParams.get('tab') === 'egress'
    } catch (e) { return false }
  }

  function closeEgressPage() {
    if (egressHiddenContent) {
      egressHiddenContent.style.display = egressHiddenContent.getAttribute('data-ob-egress-display') || ''
      egressHiddenContent.removeAttribute('data-ob-egress-display')
      egressHiddenContent = null
    }
    document.querySelectorAll('[data-ob-egress-was-active]').forEach(function (button) {
      button.classList.add('menu-active')
      button.removeAttribute('data-ob-egress-was-active')
    })
    if (egressPage) { egressPage.remove(); egressPage = null }
    if (egressMenu) {
      var button = egressMenu.querySelector('button')
      if (button.classList.contains('menu-active')) button.classList.remove('menu-active')
      if (button.hasAttribute('aria-current')) button.removeAttribute('aria-current')
    }
  }

  function mountEgressNavigation() {
    var anchorButton = document.getElementById('menu-item-kernel')
    var header = anchorButton && anchorButton.closest('.settings-menu')
    if (!header) {
      // 面板版本不同时菜单项 id 可能变化：按结构兜底，找到设置菜单容器即可
      var firstButton = document.querySelector('.settings-menu .settings-menu-btn')
      header = firstButton && firstButton.closest('.settings-menu')
    }
    if (!header || !header.parentElement) {
      closeEgressPage()
      if (egressMenu) { egressMenu.remove(); egressMenu = null }
      return
    }
    // 排到「后端设置」之后；找不到该菜单项时排到最后一项之后
    var buttons = Array.prototype.slice.call(header.querySelectorAll('.settings-menu-btn'))
    var slotButton = (anchorButton && header.contains(anchorButton)) ? anchorButton : buttons[buttons.length - 1]
    var backendSlot = slotButton && slotButton.closest('li')
    if (!backendSlot) return
    if (!egressMenu || !egressMenu.isConnected || egressMenu.parentElement !== backendSlot.parentElement) {
      if (egressMenu) egressMenu.remove()
      egressMenu = mk('li', { class: backendSlot.className })
      var button = mk('button', { type: 'button', id: 'menu-item-egress', 'data-key': 'egress',
        class: 'settings-menu-btn w-full', title: '出口分流', 'aria-label': '出口分流' })
      var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      ;[['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'], ['class', 'h-5 w-5 shrink-0'], ['aria-hidden', 'true']].forEach(function (a) { icon.setAttribute(a[0], a[1]) })
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4')
      icon.appendChild(path); button.appendChild(icon)
      button.appendChild(mk('span', { text: '出口分流', class: 'hidden truncate text-sm md:block' }))
      button.addEventListener('click', function () {
        var route = new URL(location.hash.slice(1) || '/settings', location.origin)
        route.searchParams.set('tab', 'egress')
        location.hash = route.pathname + route.search
        mountEgressNavigation()
      })
      egressMenu.appendChild(button)
      backendSlot.after(egressMenu)
    }
    if (!isEgressRoute()) { closeEgressPage(); return }
    var root = header.parentElement
    var content = Array.from(root.children).find(function (child) { return child !== header && child !== egressPage })
    if (!content) return
    if (egressHiddenContent !== content) {
      if (egressHiddenContent) {
        egressHiddenContent.style.display = egressHiddenContent.getAttribute('data-ob-egress-display') || ''
        egressHiddenContent.removeAttribute('data-ob-egress-display')
      }
      egressHiddenContent = content
      content.setAttribute('data-ob-egress-display', content.style.display || '')
    }
    if (content.style.display !== 'none') content.style.display = 'none'
    header.querySelectorAll('.settings-menu-btn.menu-active').forEach(function (button) {
      if (button.id !== 'menu-item-egress') {
        button.setAttribute('data-ob-egress-was-active', '')
        button.classList.remove('menu-active')
      }
    })
    var selected = egressMenu.querySelector('button')
    if (!selected.classList.contains('menu-active')) selected.classList.add('menu-active')
    if (selected.getAttribute('aria-current') !== 'page') {
      selected.setAttribute('aria-current', 'page')
      if (selected.scrollIntoView) selected.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    if (!egressPage || !egressPage.isConnected || egressPage.parentElement !== root) {
      if (egressPage) egressPage.remove()
      egressPage = mk('div', { id: 'ob-egress-page', class: 'min-h-0 flex-1 overflow-y-auto px-2 py-2' })
      root.appendChild(egressPage)
    }
    var b = find(activeUuid || SELF_UUID)
    if (b) mountEgressCard(b, egressPage)
  }

  function mountEgressCard(b, container) {
    if (egressCard && egressCard.isConnected && egressCard.parentElement === container && egressBackend === b.uuid) return
    if (egressCard) egressCard.remove()
    var card = mk('section', { id: 'ob-egress-settings', class: 'card bg-base-100 border-base-300/60 border' })
    card.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:12px;'
    egressCard = card
    egressBackend = b.uuid
    container.appendChild(card)
    card.appendChild(mk('h2', { text: '出口分流', style: { 'font-size': '16px', 'font-weight': '600' } }))
    card.appendChild(mk('p', { text: '当前后端：' + (b.label || b.host) + '。代理出口 → Wan1，直连出口 → Wan2：可选两个独立网口，也可在同一网桥（如 br-lan）上启用「同网桥双网关」并填写两个不同的上游网关。同网桥模式会在该网桥挂两个辅助源地址（默认 .221 代理 / .222 直连）来区分出口，不改动主路由表。', class: 'text-sm opacity-70' }))
    var stateBox = mk('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '4px', padding: '10px 12px', 'border-radius': '10px', border: '1px solid ' + CLR.border } })
    var status = mk('p', { text: '正在读取网口与配置…', class: 'text-sm', role: 'status' })
    var form = mk('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '12px' } })
    card.appendChild(stateBox); card.appendChild(status); card.appendChild(form)
    function current() { return egressCard === card && egressBackend === b.uuid }

    function stateRow(label, value, color) {
      return mk('div', { style: { display: 'flex', gap: '8px', 'font-size': '12px', 'line-height': '1.55' } }, [
        mk('span', { text: label + '：', style: { color: CLR.text, opacity: '.6', flex: 'none' } }),
        mk('span', { text: String(value || '—'), style: color ? { color: color } : { 'word-break': 'break-all' } }),
      ])
    }

    // 面板只显示"应用成功"是不够的：这里把「运行配置是否通过校验」和
    // 「内核进程是否真的跑在这份配置上」都摊开，避免再次出现"显示成功却没分流"。
    function renderState(j) {
      var active = j.active || {}
      var detail = j.summary || null
      var verify = detail && detail.verify
      var runtime = j.runtime || {}
      var ok = Boolean(j.splitActive)
      var color = ok ? '#16a34a' : active.enabled ? '#d97706' : 'rgba(127,127,127,.65)'
      var title = ok ? '分流已生效' : active.enabled ? '已启用，但分流未生效' : '未启用出口分流'
      var lines = [
        mk('div', { style: { display: 'flex', 'align-items': 'center', gap: '8px', 'font-weight': '600' } }, [
          mk('span', { style: { width: '9px', height: '9px', 'border-radius': '9999px', background: color, flex: 'none' } }),
          mk('span', { text: title }),
        ]),
      ]
      if (active.enabled) {
        var plans = (j.routing && j.routing.plans) || []
        function srcOf(role) {
          var p = plans.filter(function (x) { return x.role === role })[0]
          return p && p.source && p.source.ip ? '（源 ' + p.source.ip + '）' : ''
        }
        lines.push(stateRow('代理出口 Wan1', (active.proxyInterface || '未选择') + srcOf('proxy') + (active.routing && active.routing.proxyGateway4 ? ' → ' + active.routing.proxyGateway4 : '') + (detail && detail.proxyOutbounds ? '（' + detail.proxyOutbounds.length + ' 个出站已绑定）' : '')))
        lines.push(stateRow('直连出口 Wan2', (active.directInterface || '未选择') + srcOf('direct') + (active.routing && active.routing.directGateway4 ? ' → ' + active.routing.directGateway4 : '') + (detail && detail.directOutbounds ? '（' + detail.directOutbounds.length + ' 个出站已绑定）' : '')))
        if (plans.some(function (p) { return p.source })) {
          var dropped = j.routing && j.routing.degraded
          lines.push(stateRow('直连出口回退', j.routing.fallbackEnabled === false ? '已关闭（直连不通时不做回退）' : dropped ? '上游不通，已临时把直连流量切到代理出口' : '正常（探测通过，无需回退）', dropped ? '#d97706' : j.routing.fallbackEnabled === false ? 'rgba(127,127,127,.65)' : '#16a34a'))
        }
        if (detail && detail.defaultInterface) lines.push(stateRow('默认出口', detail.defaultInterface))
        lines.push(stateRow('内核进程', runtime.active ? ('PID ' + runtime.pid + ' 正在使用分流配置') : runtime.supported === false ? '当前平台无法检查进程' : '没有运行在分流配置上', runtime.active ? '#16a34a' : '#d97706'))
        if (verify && !verify.ok) (verify.problems || []).forEach(function (problem) { lines.push(stateRow('校验问题', problem, '#dc2626')) })
        var routes = j.routing || {}
        lines.push(stateRow('路由管理', active.routing && active.routing.automatic ? (routes.healthy ? '专用路由表与策略规则已校验' : routes.error || routes.planError || '路由尚未就绪') : '手动管理系统路由'))
        ;(routes.plans || []).forEach(function (plan) {
          var paths = (plan.families || []).map(function (f) { return 'IPv' + f.family + (f.blocked ? ' 无上游，阻止回退' : ' → ' + (f.gateway || '点对点出口')) }).join('；')
          lines.push(stateRow(plan.label + ' 表 ' + plan.table, plan.dev + ' · ' + paths))
        })
        if (j.startupError && j.startupError.message) lines.push(stateRow('启动被拒绝', j.startupError.message, '#dc2626'))
      }
      // 旧记录可能与当前状态矛盾（例如启用后还留着上次"已停用"的文案），
      // 只在语义一致时显示，避免同屏出现"已生效"和"已停用"。
      var lastMsg = j.lastApply && j.lastApply.message
      if (lastMsg && !(ok && /停用/.test(lastMsg)) && !(!active.enabled && /已应用|已启用/.test(lastMsg))) {
        lines.push(stateRow('最近一次应用', lastMsg))
      }
      stateBox.replaceChildren()
      lines.forEach(function (node) { stateBox.appendChild(node) })
    }

    function refresh(message) {
      serverRequest(b, 'egressStatus').then(function (j) {
        if (!current()) return
        renderState(j)
        var draft = j.draft || {}
        var enabled = mk('input', { type: 'checkbox', class: 'checkbox checkbox-primary checkbox-sm', 'aria-label': '启用出口分流' })
        enabled.checked = Boolean(draft.enabled)
        function label(text, input) {
          var l = mk('label', { class: 'flex items-center gap-2 text-sm' })
          l.appendChild(input); l.appendChild(mk('span', { text: text })); return l
        }
        function choose(text, value) {
          var select = mk('select', { class: 'select select-bordered w-full', 'aria-label': text })
          select.appendChild(mk('option', { value: '', text: '选择实际网口' }))
          var items = (j.interfaces || []).slice()
          if (value && !items.some(function (i) { return i.name === value })) items.push({ name: value, addresses: [], state: '未接入' })
          items.forEach(function (i) { select.appendChild(mk('option', { value: i.name, text: i.name + ' · ' + i.state + ' · ' + (i.addresses.join(', ') || '无地址') })) })
          select.value = value || ''
          var l = mk('label', { class: 'flex flex-col gap-2 text-sm' })
          l.appendChild(mk('span', { text: text })); l.appendChild(select); form.appendChild(l)
          return select
        }
        form.replaceChildren(label('启用出口分流', enabled))
        var shared = mk('input', { type: 'checkbox', class: 'checkbox checkbox-primary checkbox-sm', 'aria-label': '同网桥双网关分流' })
        shared.checked = draft.routing && draft.routing.mode === 'shared-gateway'
        form.appendChild(label('同网桥双网关分流（同一网段）', shared))
        var proxy = choose('代理出口 / Wan1', draft.proxyInterface)
        var direct = choose('直连出口 / Wan2', draft.directInterface)
        var automatic = mk('input', { type: 'checkbox', class: 'checkbox checkbox-primary checkbox-sm', 'aria-label': '自动配置路由表' })
        automatic.checked = !draft.routing || draft.routing.automatic !== false
        form.appendChild(label('自动配置路由表与策略规则（推荐）', automatic))
        var routingOptions = draft.routing || {}
        var advanced = mk('details', { class: 'text-sm' })
        advanced.open = shared.checked
        advanced.appendChild(mk('summary', { text: '上游网关（同网桥模式必须填写两个不同的 IPv4 网关）', class: 'cursor-pointer' }))
        var gateways = {}
        ;[['proxy', 'Wan1'], ['direct', 'Wan2']].forEach(function (role) {
          ;[4, 6].forEach(function (family) {
            var key = role[0] + 'Gateway' + family
            var dev = role[0] === 'proxy' ? proxy.value : direct.value
            var up = (j.routing && j.routing.uplinks || []).filter(function (u) { return u.dev === dev })[0] || {}
            // 同网桥模式下两个出口共用一块网卡，从系统只能读到主表网关，
            // 用它给 Wan2 做"自动识别"提示会误导，因此该模式不显示自动值。
            var auto = shared.checked ? '' : ((family === 4 ? up.gateway4 : up.gateway6) || '')
            var hint = shared.checked ? '同网桥模式必须填写（例：192.168.100.4）' : (auto ? ('自动识别：' + auto) : '留空自动识别')
            var input = mk('input', { type: 'text', class: 'input input-bordered w-full', value: routingOptions[key] || '', placeholder: hint, 'aria-label': role[1] + ' IPv' + family + ' 网关' })
            gateways[key] = input
            advanced.appendChild(label(role[1] + ' IPv' + family + ' 网关', input))
          })
        })
        var fallbackBox = mk('input', { type: 'checkbox', class: 'checkbox checkbox-primary checkbox-sm', 'aria-label': '直连出口不通时回退' })
        fallbackBox.checked = !draft.routing || draft.routing.directFallback !== false
        advanced.appendChild(label('直连出口不通时自动回退到代理出口', fallbackBox))
        form.appendChild(advanced)
        var routePreview = mk('p', { class: 'text-sm opacity-70', role: 'status' })
        form.appendChild(routePreview)
        function previewRoutes() {
          if (!automatic.checked) { routePreview.textContent = '仅绑定出口网口；系统路由表由你自行管理。'; return }
          var available = j.routing && j.routing.uplinks || []
          routePreview.textContent = [['Wan1', proxy.value, 'proxy', 22031], ['Wan2', direct.value, 'direct', 22032]].map(function (r) {
            var upstream = available.find(function (u) { return u.dev === r[1] }) || {}
            var gateway = gateways[r[2] + 'Gateway4'].value || upstream.gateway4
            return r[0] + ' → 表 ' + r[3] + ' → ' + (r[1] || '待选择网口') + ' / ' + (gateway || '网关待自动识别') + (shared.checked ? '（源 .22' + (r[2] === 'proxy' ? '1' : '2') + '）' : '')
          }).join('；')
        }
        automatic.addEventListener('change', previewRoutes)
        Object.keys(gateways).forEach(function (key) { gateways[key].addEventListener('input', previewRoutes) })
        proxy.addEventListener('change', previewRoutes); direct.addEventListener('change', previewRoutes)
        previewRoutes()
        var guard = mk('p', { class: 'text-sm', style: { color: '#dc2626' } })
        form.appendChild(guard)
        form.appendChild(mk('p', { text: '保存草稿不改变网络。自动路由只管理所选出口的专用表与规则，保留主路由表、管理 LAN 和其他 VPN 路由。网关续租后自动同步；停用时移除本补丁创建的规则。IPv6 无可用上游时阻止跨出口回退。应用会重启内核并关闭原生“直连绕过”，请先关闭终端和端口绕过。', class: 'text-sm opacity-70' }))
        var actions = mk('div', { class: 'flex flex-wrap gap-2' })
        var applyButton = null
        function syncGuard() {
          var same = Boolean(proxy.value) && proxy.value === direct.value
          var invalid = shared.checked ? (!same || !automatic.checked || !gateways.proxyGateway4.value.trim() || !gateways.directGateway4.value.trim() || gateways.proxyGateway4.value.trim() === gateways.directGateway4.value.trim()) : same
          guard.textContent = invalid ? (shared.checked ? '同网桥模式需选择相同网桥、启用自动路由，并填写两个不同的 IPv4 上游网关。' : 'Wan1 与 Wan2 不能是同一个网口；同网段请启用同网桥双网关分流。') : ''
          if (applyButton) applyButton.disabled = enabled.checked && invalid
        }
        function submit(action) {
          if (!current()) return
          var value = { enabled: enabled.checked, proxyInterface: proxy.value, directInterface: direct.value, routing: { automatic: automatic.checked, mode: shared.checked ? 'shared-gateway' : 'interfaces', directFallback: fallbackBox.checked } }
          Object.keys(gateways).forEach(function (key) { value.routing[key] = gateways[key].value.trim() })
          syncGuard()
          if (action === 'egressApply' && value.enabled && guard.textContent) return
          if (action === 'egressApply' && !confirm('应用到「' + (b.label || b.host) + '」并重新部署 OpenBox 内核？' + (value.enabled ? '\n直连绕过将关闭；' + (value.routing.automatic ? '将自动管理独立路由表与策略规则，保留主路由表；' : '') + '分流校验不通过时内核不会启动。' : ''))) return
          var controls = form.querySelectorAll('input,select,button')
          controls.forEach(function (el) { el.disabled = true })
          status.textContent = action === 'egressApply' ? '正在验证并应用，请等待…（会重启内核并校验分流）' : '正在保存草稿…'
          serverRequest(b, action, { settings: value }).then(function (result) {
            if (!current()) return
            refresh(result.message || '操作完成')
          }).catch(function (error) { if (current()) status.textContent = error.message }).finally(function () { controls.forEach(function (el) { el.disabled = false }) })
        }
        actions.appendChild(btn('保存草稿', false, function () { submit('egressSave') }))
        applyButton = btn('应用并重启内核', true, function () { submit('egressApply') })
        actions.appendChild(applyButton)
        actions.appendChild(btn('重新检测', false, refresh))
        form.appendChild(actions)
        proxy.addEventListener('change', syncGuard)
        direct.addEventListener('change', syncGuard)
        enabled.addEventListener('change', syncGuard)
        automatic.addEventListener('change', syncGuard)
        shared.addEventListener('change', function () { advanced.open = shared.checked; syncGuard() })
        Object.keys(gateways).forEach(function (key) { gateways[key].addEventListener('input', syncGuard) })
        syncGuard()
        status.textContent = message || (j.lastApply && j.lastApply.message ? j.lastApply.message : '')
      }).catch(function (error) { if (current()) status.textContent = '无法读取出口分流：' + error.message + '。请确认此后端已安装新版 Patch。' })
    }
    refresh()
  }

  /* ================= 连接列表的「出口」列 ================= */

  // 连接页是 tanstack <table>（名称/进站/出站/总流量/占比）。
  // 只对当前有活跃连接的条目能判断出口，因此用 localStorage 缓存最近 30 分钟
  // 见过的 host→出口，避免列表里大片空白。
  var exitSeen = {}
  var exitMapAt = 0
  var exitTimer = null
  var EXIT_CACHE_KEY = 'ob-exit-cache'
  try { exitSeen = JSON.parse(localStorage.getItem(EXIT_CACHE_KEY) || '{}') || {} } catch (e) { exitSeen = {} }

  function collectExitMap() {
    return fetch('/api/controller/connections', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) {
        var list = (j && j.connections) || []
        var now = Date.now()
        list.forEach(function (c) {
          var meta = c.metadata || {}
          var host = meta.host || meta.destinationIP || ''
          if (!host) return
          var chains = c.chains || []
          // chains 末尾是选择器组名（AI / 国内），chains[0] 才是真实出站
          var tag = chains.length ? chains[0] : '直连'
          exitSeen[host] = { tag: tag, direct: !chains.length || tag === '直连' || tag === 'DIRECT', at: now }
        })
        var kept = {}
        for (var k in exitSeen) if (now - (exitSeen[k].at || 0) < 21600000) kept[k] = exitSeen[k]
        exitSeen = kept
        try { localStorage.setItem(EXIT_CACHE_KEY, JSON.stringify(kept)) } catch (e) {}
        return kept
      })
      .catch(function () { return null })
  }

  // 精确命中不到时按父域名回填，例如 ab.chatgpt.com ← chatgpt.com
  function lookupExit(host) {
    if (!host) return null
    if (exitSeen[host]) return exitSeen[host]
    var parts = host.split('.')
    for (var i = 1; i < parts.length - 1; i++) {
      var parent = parts.slice(i).join('.')
      if (exitSeen[parent]) return exitSeen[parent]
    }
    return null
  }

  // 出口的本地源地址与网关取自出口分流配置（同网桥模式 .221 代理 / .222 直连）
  var sharedSrc = null
  var sharedSrcAt = 0
  function loadSharedSrc() {
    if (Date.now() - sharedSrcAt < 60000) return
    sharedSrcAt = Date.now()
    try {
      var b = find(activeUuid || SELF_UUID)
      if (!b) return
      serverRequest(b, 'egressStatus').then(function (j) {
        var plans = (j && j.routing && j.routing.plans) || []
        function pick(role) {
          var x = plans.filter(function (y) { return y.role === role })[0]
          if (!x || !x.source || !x.source.ip) return null
          var f4 = (x.families || []).filter(function (f) { return f.family === 4 })[0] || {}
          return { ip: x.source.ip, gw: f4.gateway || '' }
        }
        var pr = pick('proxy'), di = pick('direct')
        sharedSrc = (pr && di) ? { proxy: pr, direct: di } : null
      }).catch(function () {})
    } catch (e) {}
  }

  function fillExitCell(td, info) {
    td.style.cssText = 'white-space:nowrap;font-size:12px;font-weight:500;'
    td.style.color = info ? (info.direct ? '#f59e0b' : '#06b6d4') : 'rgba(127,127,127,.5)'
    var label = info ? (info.direct ? '直连' : info.tag) : '—'
    var side = info ? (info.direct ? (sharedSrc && sharedSrc.direct) : (sharedSrc && sharedSrc.proxy)) : null
    if (side) label += '（.' + (side.gw || side.ip).split('.').pop() + ' 出口）'
    if (td.textContent !== label) td.textContent = label
    td.title = (info && side)
      ? '本地出口地址 ' + side.ip + '，经 ' + (side.gw || '上游网关') + ' 出网'
      : info ? '出口：' + (info.direct ? '直连（Wan2）' : info.tag + '（经代理，Wan1）')
             : '最近 6 小时内没有该目标的活跃连接，无法判断出口'
  }

  // 列标题可能是中文（进站/出站）或英文（Inbound/Outbound）
  function hasInOut(head) {
    var t = head.textContent || ''
    return (/进站/.test(t) && /出站/.test(t)) || (/Inbound/i.test(t) && /Outbound/i.test(t))
  }

  function paintExitTable() {
    var tables = document.querySelectorAll('table.table')
    var table = null
    for (var i = 0; i < tables.length; i++) {
      var h = tables[i].querySelector('thead')
      if (h && hasInOut(h)) { table = tables[i]; break }
    }
    if (!table) return false
    var headTr = table.querySelector('thead tr')
    if (headTr && !headTr.querySelector('[data-ob-exit]')) {
      var th = mk('th', { text: '出口' })
      th.setAttribute('data-ob-exit', '')
      th.style.cssText = 'white-space:nowrap;'
      headTr.appendChild(th)
    }
    var rows = table.querySelectorAll('tbody tr')
    var added = 0
    for (var r = 0; r < rows.length; r++) {
      var tr = rows[r]
      var tds = tr.querySelectorAll('td')
      if (!tds.length) continue
      var host = (tds[0].textContent || '').trim()
      var cell = tr.querySelector('[data-ob-exit]')
      if (!cell) {
        cell = mk('td')
        cell.setAttribute('data-ob-exit', '')
        tr.appendChild(cell)
        added++
      }
      fillExitCell(cell, lookupExit(host))
    }
    if (added) { try { console.info('[openbox-patch] 出口列已注入 ' + added + ' 行，已知出口 ' + Object.keys(exitSeen).length + ' 个目标') } catch (e) {} }
    return true
  }

  // 活跃连接卡片里的出口链（「🇬🇧 国内 ● 直连」这类）：补上本地出口
  function paintChainExit() {
    if (!sharedSrc) return
    var spans = document.querySelectorAll('span.flex.w-80.grow.items-center.gap-1')
    for (var i = 0; i < spans.length; i++) {
      var span = spans[i]
      var text = (span.textContent || '').trim()
      if (!text) continue
      var direct = text.indexOf('直连') !== -1
      var side = direct ? sharedSrc.direct : sharedSrc.proxy
      if (!side) continue
      var label = '（.' + (side.gw || side.ip).split('.').pop() + ' 出口）'
      var badge = span.querySelector('[data-ob-chain-exit]')
      if (!badge) {
        badge = mk('span')
        badge.setAttribute('data-ob-chain-exit', '')
        badge.style.cssText = 'flex:none;font-size:11px;opacity:.75;'
        span.appendChild(badge)
      }
      if (badge.textContent !== label) badge.textContent = label
    }
  }

  function exitTick() {
    try {
      loadSharedSrc()
      paintChainExit()
      var painted = paintExitTable()
      if (!painted) return
      if (Date.now() - exitMapAt < 2500) return
      exitMapAt = Date.now()
      collectExitMap().then(function () { paintExitTable() })
    } catch (e) {}
  }

  function syncExitColumn() {
    try {
      var tables = document.querySelectorAll('table.table')
      var present = false
      for (var i = 0; i < tables.length; i++) {
        var h = tables[i].querySelector('thead')
        if (h && hasInOut(h)) { present = true; break }
      }
      if (present) {
        if (!exitTimer) exitTimer = setInterval(exitTick, 3000)
        exitTick()
      } else if (exitTimer) { clearInterval(exitTimer); exitTimer = null }
    } catch (e) {}
  }

  /* ================= 连接页：活跃 / 历史 视图切换 ================= */

  var connMode = 'active'
  var connExpanded = false
  var connPanel = null
  var connSwitch = null

  // 连接页的子 tab 行（终端设备 / 出站节点 / 访问目标）。
  // 实际结构：div[role=tablist].tabs-box.tabs.seg（daisyUI + 自定义 seg）。
  // 注意每个 tablist 都有一份 `seg-copy` 视觉副本，必须跳过，否则会重复插入；
  // 按钮也绝不能插进 tablist 内部，那里的滑动指示条是绝对定位的。
  function connTabRow() {
    try {
      var lists = document.querySelectorAll('[role="tablist"]')
      for (var i = 0; i < lists.length; i++) {
        var el = lists[i]
        if ((el.className || '').indexOf('seg-copy') !== -1) continue
        var t = el.textContent || ''
        if (t.indexOf('终端设备') !== -1 && t.indexOf('访问目标') !== -1) return el
      }
    } catch (e) {}
    return null
  }

  // tab 行容器之后的兄弟节点就是列表区域
  function connListSiblings() {
    var row = connTabRow()
    var start = row && row.parentElement
    if (!start) return []
    var out = [], sib = start.nextElementSibling
    while (sib) { out.push(sib); sib = sib.nextElementSibling }
    return out
  }

  function buildConnSwitch() {
    var box = mk('div', { id: 'ob-conn-mode' })
    box.style.cssText = 'display:inline-flex;align-items:center;gap:2px;margin-left:12px;padding:2px;border-radius:8px;background:rgba(127,127,127,.14);font-size:12px;'
    function pill(text, mode) {
      var b = mk('button', { type: 'button', text: text })
      b.style.cssText = 'padding:2px 10px;border-radius:6px;border:0;cursor:pointer;font-size:12px;'
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); setConnMode(mode) })
      b._mode = mode
      box.appendChild(b)
      return b
    }
    pill('历史', 'history')
    pill('活跃', 'active')
    return box
  }

  function paintConnSwitch() {
    if (!connSwitch) return
    var btns = connSwitch.querySelectorAll('button')
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i]._mode === connMode
      btns[i].style.background = on ? 'rgba(99,102,241,.9)' : 'transparent'
      btns[i].style.color = on ? '#fff' : 'inherit'
    }
  }

  // 原生列表容器：历史模式下要隐藏它
  function nativeConnList() {
    var table = null, tables = document.querySelectorAll('table.table')
    for (var i = 0; i < tables.length; i++) {
      var h = tables[i].querySelector('thead')
      if (h && hasInOut(h)) { table = tables[i]; break }
    }
    if (table) return table.closest('.virtual-scroller, .overflow-auto, .overflow-y-auto') || table.parentElement
    var row = connTabRow()
    if (row) { var p = row.parentElement; if (p && p.nextElementSibling) return p.nextElementSibling }
    return null
  }

  function buildConnPanel() {
    // 页面背景带 blur-intensity，任何半透明容器都会让内容发虚。
    // 这里必须给不透明底色（table-glass 本身是玻璃层，不能用）。
    var wrap = mk('div', { id: 'ob-active-conns' })
    wrap.style.cssText = 'max-height:70vh;overflow:auto;background:var(--color-base-100,#16181d);border-radius:8px;'
    var table = mk('table', { class: 'table' })
    var thead = mk('thead', { class: 'border-base-300/60 border-b' })
    thead.style.cssText = 'position:sticky;top:0;z-index:10;background:var(--color-base-100,#16181d);'
    var htr = mk('tr')
    ;['目标', '出口', '来源', '进站', '出站', '时长'].forEach(function (h) { htr.appendChild(mk('th', { text: h })) })
    thead.appendChild(htr)
    table.appendChild(thead)
    var tbody = mk('tbody')
    table.appendChild(tbody)
    wrap.appendChild(table)
    var more = mk('div')
    more.style.cssText = 'padding:10px 12px;text-align:center;'
    wrap.appendChild(more)
    wrap._body = tbody
    wrap._more = more
    return wrap
  }

  function agoText(iso) {
    var t = iso ? new Date(iso).getTime() : 0
    if (!t) return ''
    var s = Math.max(0, Math.round((Date.now() - t) / 1000))
    if (s < 60) return s + ' 秒前'
    if (s < 3600) return Math.round(s / 60) + ' 分钟前'
    return Math.round(s / 3600) + ' 小时前'
  }

  function renderConnPanel() {
    if (!connPanel || !connPanel._body) return
    fetch('/api/controller/connections', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) {
        if (!connPanel) return
        var list = (j && j.connections) || []
        list = list.slice().sort(function (a, b) { return String(b.start || '').localeCompare(String(a.start || '')) })
        var body = connPanel._body
        body.replaceChildren()
        var limit = connExpanded ? list.length : Math.min(20, list.length)
        for (var i = 0; i < limit; i++) {
          var c = list[i], meta = c.metadata || {}
          var chains = c.chains || []
          var tag = chains.length ? chains[0] : '直连'
          var direct = !chains.length || tag === '直连' || tag === 'DIRECT'
          var side = direct ? (sharedSrc && sharedSrc.direct) : (sharedSrc && sharedSrc.proxy)
          var tr = mk('tr')
          var nameTd = mk('td', { text: (meta.host || meta.destinationIP || '?') + (meta.destinationPort ? ':' + meta.destinationPort : '') })
          nameTd.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:360px;'
          tr.appendChild(nameTd)
          var exitTd = mk('td', { text: (direct ? '直连' : tag) + (side ? '（.' + (side.gw || side.ip).split('.').pop() + ' 出口）' : '') })
          exitTd.style.cssText = 'white-space:nowrap;min-width:150px;'
          exitTd.style.color = direct ? '#f59e0b' : '#06b6d4'
          tr.appendChild(exitTd)
          var srcTd = mk('td', { text: meta.sourceIP || '' })
          srcTd.style.cssText = 'white-space:nowrap;'
          tr.appendChild(srcTd)
          ;[bytesText(c.download), bytesText(c.upload), agoText(c.start)].forEach(function (v) {
            var td = mk('td', { text: v })
            td.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;'
            tr.appendChild(td)
          })
          body.appendChild(tr)
        }
        if (!list.length) {
          var empty = mk('tr')
          var td = mk('td', { text: '当前没有活跃连接' })
          td.colSpan = 6
          empty.appendChild(td)
          body.appendChild(empty)
        }
        connPanel._more.replaceChildren()
        if (list.length > 20) {
          var b = mk('button', { type: 'button', class: 'btn btn-xs btn-ghost' })
          b.textContent = connExpanded ? '收起' : ('展开全部（剩余 ' + (list.length - 20) + ' 条）')
          b.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation()
            connExpanded = !connExpanded
            renderConnPanel()
          })
          connPanel._more.appendChild(b)
        }
      })
      .catch(function () {})
  }

  function setConnMode(mode) {
    connMode = mode
    paintConnSwitch()
    var row = connTabRow()
    var anchor = row && row.parentElement
    var sibs = connListSiblings()
    if (mode === 'active') {
      if (!connPanel) connPanel = buildConnPanel()
      if (anchor) anchor.after(connPanel)
      else document.body.appendChild(connPanel)
      for (var i = 0; i < sibs.length; i++) {
        if (sibs[i] === connPanel || sibs[i].contains(connPanel)) continue
        if (!sibs[i].hasAttribute('data-ob-hidden')) {
          sibs[i].setAttribute('data-ob-hidden', sibs[i].style.display || '')
          sibs[i].style.display = 'none'
        }
      }
      renderConnPanel()
    } else {
      for (var j = 0; j < sibs.length; j++) {
        if (sibs[j].hasAttribute('data-ob-hidden')) {
          sibs[j].style.display = sibs[j].getAttribute('data-ob-hidden') || ''
          sibs[j].removeAttribute('data-ob-hidden')
        }
      }
      if (connPanel) { connPanel.remove(); connPanel = null }
    }
  }

  function syncConnSwitch() {
    try {
      var row = connTabRow()
      if (!row) { if (connSwitch) { connSwitch.remove(); connSwitch = null } return }
      if (!connSwitch) connSwitch = buildConnSwitch()
      if (connSwitch.previousElementSibling !== row) { row.after(connSwitch); paintConnSwitch() }
      // 页面重渲染后恢复活跃模式
      if (connMode === 'active') {
        if (!connPanel) connPanel = buildConnPanel()
        var sibs = connListSiblings()
        for (var i = 0; i < sibs.length; i++) {
          if (sibs[i] === connPanel || sibs[i].contains(connPanel)) continue
          if (!sibs[i].hasAttribute('data-ob-hidden')) {
            sibs[i].setAttribute('data-ob-hidden', sibs[i].style.display || '')
            sibs[i].style.display = 'none'
          }
        }
        if (connPanel && !connPanel.isConnected && row.parentElement) { row.parentElement.after(connPanel); renderConnPanel() }
      }
    } catch (e) {}
  }

  /* ================= 概览页底部的出口分流卡片 ================= */

  var homeEgressCard = null
  var homeEgressAt = 0
  var homeEgressBusy = false

  function isOverviewRoute() {
    try {
      var route = new URL(location.hash.slice(1) || '/', location.origin)
      return route.pathname === '/' || route.pathname === '/overview'
    } catch (e) { return false }
  }

  /** 概览页的卡片容器：以「域名过滤 / 流量洞察 / 面板概览」任一卡片反查父容器 */
  function overviewContainer() {
    var labels = ['域名过滤', '流量洞察', '面板概览']
    var cards = document.querySelectorAll('section.card, div.card')
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].id === 'ob-home-egress') continue
      var text = cards[i].textContent || ''
      for (var j = 0; j < labels.length; j++) {
        if (text.indexOf(labels[j]) !== -1 && cards[i].parentElement) return cards[i].parentElement
      }
    }
    return null
  }

  function rateText(value) {
    var n = Number(value) || 0
    var units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
    var i = 0
    while (n >= 1024 && i < units.length - 1) { n = n / 1024; i++ }
    return (i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i]
  }

  function bytesText(value) {
    var n = Number(value) || 0
    var units = ['B', 'KB', 'MB', 'GB', 'TB']
    var i = 0
    while (n >= 1024 && i < units.length - 1) { n = n / 1024; i++ }
    return (i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i]
  }

  function buildHomeEgressCard() {
    var card = mk('section', { id: 'ob-home-egress', class: 'card bg-base-100 border-base-300/60 border' })
    card.style.cssText = 'padding:12px 16px;display:flex;flex-direction:column;gap:8px;'
    var head = mk('div', { style: { display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '8px' } })
    head.appendChild(mk('h2', { text: '出口分流', style: { 'font-size': '16px', 'font-weight': '600' } }))
    var badge = mk('span', { text: '读取中…', style: { 'font-size': '12px', opacity: '.7' } })
    head.appendChild(badge)
    var exits = mk('div', { style: { display: 'flex', 'flex-wrap': 'wrap', gap: '4px 20px', 'font-size': '12px' } })
    var share = mk('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '6px' } })
    var foot = mk('div', { style: { 'font-size': '11px', opacity: '.6', 'line-height': '1.5' } })
    card.appendChild(head); card.appendChild(exits); card.appendChild(share); card.appendChild(foot)
    card.__ob = { badge: badge, exits: exits, share: share, foot: foot, rendered: false }
    return card
  }

  function egressExitLine(label, iface, extra) {
    return mk('span', {}, [
      mk('span', { text: label + '：', style: { opacity: '.6' } }),
      mk('span', { text: iface || '未选择', style: { 'font-family': 'ui-monospace,SFMono-Regular,Menlo,monospace' } }),
      mk('span', { text: extra || '', style: { opacity: '.6' } }),
    ])
  }

  function shareRow(label, bucket, totalBytes, color) {
    var pct = totalBytes > 0 ? Math.round((bucket.bytes / totalBytes) * 100) : 0
    var row = mk('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '3px' } })
    row.appendChild(mk('div', { style: { display: 'flex', 'justify-content': 'space-between', gap: '8px', 'font-size': '12px' } }, [
      mk('span', { text: label }),
      mk('span', { text: pct + '% · ' + bucket.count + ' 连接 · ↓' + rateText(bucket.down) + ' ↑' + rateText(bucket.up) + ' · 累计 ' + bytesText(bucket.bytes) }),
    ]))
    var bar = mk('div', { style: { height: '5px', 'border-radius': '9999px', background: 'rgba(127,127,127,.18)', overflow: 'hidden' } })
    bar.appendChild(mk('div', { style: { height: '100%', width: pct + '%', background: color } }))
    row.appendChild(bar)
    return row
  }

  function renderHomeEgress(status, traffic) {
    if (!homeEgressCard || !homeEgressCard.__ob) return
    var dom = homeEgressCard.__ob
    var error = status && status.error
    var active = (status && status.active) || {}
    var detail = (status && status.summary) || null
    var ok = Boolean(status && status.splitActive)
    var badgeText = error ? '读取失败' : ok ? '分流已生效' : active.enabled ? '分流未生效' : '未启用'
    var badgeColor = error ? '#dc2626' : ok ? '#16a34a' : active.enabled ? '#d97706' : 'currentColor'
    dom.badge.textContent = badgeText
    dom.badge.style.color = badgeColor

    dom.exits.replaceChildren()
    if (active.enabled) {
      var ifaces = (status.interfaces || [])
      var describe = function (name) {
        var hit = null
        for (var i = 0; i < ifaces.length; i++) if (ifaces[i].name === name) hit = ifaces[i]
        return hit ? ' · ' + (hit.addresses.join(', ') || '无地址') + ' · ' + hit.state : ''
      }
      dom.exits.appendChild(egressExitLine('直连 Wan2', active.directInterface, describe(active.directInterface)))
      dom.exits.appendChild(egressExitLine('代理 Wan1', active.proxyInterface, describe(active.proxyInterface)))
    } else {
      dom.exits.appendChild(mk('span', { text: '未启用：全部流量按 OpenBox 自身规则出网。', style: { opacity: '.7' } }))
    }

    dom.share.replaceChildren()
    if (traffic) {
      var total = traffic.direct.bytes + traffic.proxy.bytes
      dom.share.appendChild(shareRow('直连', traffic.direct, total, '#ff9f43'))
      dom.share.appendChild(shareRow('代理', traffic.proxy, total, '#79d8ff'))
    } else {
      dom.share.appendChild(mk('div', { text: '暂无法读取连接表', style: { 'font-size': '12px', opacity: '.6' } }))
    }

    var footParts = []
    if (error) footParts.push('读取出口分流失败：' + error)
    else if (active.enabled && detail && detail.verify && !detail.verify.ok) footParts.push('校验未通过：' + detail.verify.problems.join('；'))
    else if (active.enabled && status.runtime && status.runtime.supported !== false && !status.runtime.active) footParts.push('内核未运行在分流配置上')
    if (status && status.lastApply && status.lastApply.message) footParts.push(status.lastApply.message)
    footParts.push('更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }))
    dom.foot.textContent = footParts.join(' · ')
    dom.rendered = true
  }

  function fetchTrafficShare() {
    return Promise.all([
      fetch('/api/controller/connections', { credentials: 'include', cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null }).catch(function () { return null }),
      fetch('/api/controller/proxies', { credentials: 'include', cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null }).catch(function () { return null }),
    ]).then(function (result) {
      var connections = (result[0] && result[0].connections) || []
      var proxies = (result[1] && result[1].proxies) || {}
      var directTypes = ['Direct', 'Reject', 'Compatible', 'Pass']
      var buckets = { direct: { count: 0, up: 0, down: 0, bytes: 0 }, proxy: { count: 0, up: 0, down: 0, bytes: 0 } }
      for (var i = 0; i < connections.length; i++) {
        var item = connections[i] || {}
        var chain = (item.chains || [])[0]
        var type = proxies[chain] && proxies[chain].type
        var bucket = directTypes.indexOf(type) !== -1 ? buckets.direct : buckets.proxy
        bucket.count += 1
        bucket.up += Number(item.uploadSpeed) || 0
        bucket.down += Number(item.downloadSpeed) || 0
        bucket.bytes += (Number(item.upload) || 0) + (Number(item.download) || 0)
      }
      return buckets
    }).catch(function () { return null })
  }

  function refreshHomeEgress(force) {
    if (!homeEgressCard || !homeEgressCard.isConnected) return
    if (homeEgressBusy) return
    var now = Date.now()
    if (!force && now - homeEgressAt < 5000) return
    homeEgressAt = now
    homeEgressBusy = true
    var b = find(activeUuid || SELF_UUID)
    var statusPromise = b
      ? serverRequest(b, 'egressStatus').catch(function (error) { return { error: error.message } })
      : Promise.resolve({ error: '未选择后端' })
    Promise.all([statusPromise, fetchTrafficShare()]).then(function (result) {
      homeEgressBusy = false
      if (!homeEgressCard || !homeEgressCard.isConnected) return
      renderHomeEgress(result[0] || {}, result[1] || null)
    }).catch(function () { homeEgressBusy = false })
  }

  /** 挂在概览页卡片容器的最末尾（地址栏不变，随 SPA 路由自动出现/移除） */
  function mountHomeEgress() {
    if (!isOverviewRoute()) {
      if (homeEgressCard) { homeEgressCard.remove(); homeEgressCard = null }
      return
    }
    var container = overviewContainer()
    if (!container) {
      if (homeEgressCard && !homeEgressCard.isConnected) homeEgressCard = null
      return
    }
    if (!homeEgressCard) homeEgressCard = buildHomeEgressCard()
    if (homeEgressCard.parentElement !== container || container.lastElementChild !== homeEgressCard) container.appendChild(homeEgressCard)
    if (!homeEgressCard.__ob.rendered) refreshHomeEgress(true)
  }

  function sortHandle(b, row, wrap) {
    var handle = mk('button', { type: 'button', text: '⠿', title: '拖动调整后端顺序', 'aria-label': '拖动排序 ' + (b.label || b.host), 'aria-description': '拖动调整顺序，也可按上下方向键排序' })
    handle.style.cssText = 'cursor:grab;touch-action:none;user-select:none;border:0;background:transparent;color:' + CLR.text + ';font-size:22px;padding:0 4px;line-height:1;'
    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || sorting) return
      e.preventDefault()
      sorting = { uuid: b.uuid, pointer: e.pointerId }
      row.style.opacity = '.65'
      handle.style.cursor = 'grabbing'
      if (handle.setPointerCapture) handle.setPointerCapture(e.pointerId)
    })
    handle.addEventListener('pointermove', function (e) {
      if (!sorting || sorting.uuid !== b.uuid || sorting.pointer !== e.pointerId) return
      var hit = document.elementFromPoint(e.clientX, e.clientY)
      var target = hit && hit.closest('[data-backend-uuid]')
      if (target && target !== row && target.parentElement === wrap && target.getAttribute('data-backend-uuid') !== SELF_UUID) {
        var bounds = target.getBoundingClientRect()
        wrap.insertBefore(row, e.clientY < bounds.top + bounds.height / 2 ? target : target.nextSibling)
      }
      var box = modalEl && modalEl.firstElementChild
      if (box) {
        var rect = box.getBoundingClientRect()
        if (e.clientY < rect.top + 48) box.scrollTop -= 16
        else if (e.clientY > rect.bottom - 48) box.scrollTop += 16
      }
    })
    function finish(e, cancelled) {
      if (!sorting || sorting.uuid !== b.uuid || sorting.pointer !== e.pointerId) return
      sorting = null
      row.style.opacity = ''
      handle.style.cursor = 'grab'
      if (!cancelled) {
        var ids = Array.from(wrap.querySelectorAll('[data-backend-uuid]')).map(function (node) { return node.getAttribute('data-backend-uuid') })
        if (ids.length === backends.length && new Set(ids).size === ids.length && ids[0] === SELF_UUID && ids.every(find)) {
          backends = ids.map(find)
          save()
          renderWidget()
        }
      }
      if (handle.hasPointerCapture && handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId)
      if (modalEl && modalView === 'list') renderModal()
      syncView()
    }
    handle.addEventListener('pointerup', function (e) { finish(e, false) })
    handle.addEventListener('pointercancel', function (e) { finish(e, true) })
    handle.addEventListener('lostpointercapture', function (e) { finish(e, true) })
    handle.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      moveBackend(b.uuid, e.key === 'ArrowUp' ? -1 : 1)
    })
    return handle
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
    var agentUrl = textInput(model.agentUrl || '', '默认 http(s)://本服务器:3037')
    var agentToken = textInput(model.agentToken || '', '代理配置了口令时填写', 'password')

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
      model.agentUrl = normalizeBase(agentUrl.value)
      model.agentToken = agentToken.value
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
      field('Patch 管理代理地址（可选）', agentUrl),
      field('Patch 管理代理口令（可选）', agentToken),
      status,
      mk('div', { style: { display: 'flex', gap: '8px', 'justify-content': 'flex-end', 'margin-top': '2px' } }, [testBtn, cancelBtn, saveBtn]),
    ])
    return wrap
  }

  function buildProxyView() {
    var input = textInput(proxyBase, 'http://主机:3037')
    var tokenInput = textInput(proxyToken, '代理配置了口令时填写', 'password')
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
      proxyToken = tokenInput.value
      status.textContent = '测试中…'
      proxyHealth().then(function (j) {
        status.textContent = j && j.ok ? '代理服务正常（' + (j.version || '') + '）' : '代理服务不可用'
      })
    })

    var saveBtn = btn('保存', true, function () {
      proxyBase = input.value.trim().replace(/\/+$/, '')
      proxyToken = tokenInput.value
      copyOnSwitch = check.checked
      saveProxy()
      openModal('list')
      refreshAll()
    })

    return mk('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '10px' } }, [
      field('代理服务地址', input),
      field('代理访问口令（可选）', tokenInput),
      mk('div', { style: { 'font-size': '11px', color: CLR.text, opacity: '.5', 'line-height': '1.5' } }, [
        mk('span', { text: '默认 http://<本机>:3037。代理负责后端认证、面板数据转发与服务器版本管理；前端页面保持在本机。远程 Patch 代理地址和口令可在各后端的编辑页配置。' }),
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
    try { proxyToken = localStorage.getItem(TOKEN_KEY) || '' } catch (e) {}
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
    mountEgressNavigation()
    mountSettingsCard()
    mountHomeEgress()
    renderWidget()
    refreshAll()

    window.addEventListener('hashchange', mountEgressNavigation)
    window.addEventListener('hashchange', mountHomeEgress)
    window.addEventListener('popstate', mountEgressNavigation)
    document.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('.settings-menu-btn')
      if (!button || button.id === 'menu-item-egress') return
      if (isEgressRoute()) {
        var route = new URL(location.hash.slice(1), location.origin)
        route.searchParams.delete('tab')
        history.replaceState(history.state, '', location.pathname + location.search + '#' + route.pathname + route.search)
      }
      closeEgressPage()
    }, true)

    // Esc 只关闭管理弹窗，不改变当前数据后端。
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modalEl) closeModal()
    })

    // 刷新页面后恢复上一次正在查看的后端（同一标签页内有效）
    try {
      var last = sessionStorage.getItem(ACTIVE_KEY)
      if (last && find(last)) activeUuid = last
    } catch (e) {}

    var obs = new MutationObserver(function () {
      if (widgetEl && !widgetEl.parentElement) mountWidget()
      mountEgressNavigation()
      mountSettingsCard()
      mountHomeEgress()
      syncExitColumn()
      syncConnSwitch()
    })
    obs.observe(document.body, { childList: true, subtree: true })

    // 概览页底部的出口分流卡片：5 秒刷新一次实时占比
    setInterval(function () {
      if (!isOverviewRoute()) return
      mountHomeEgress()
      refreshHomeEgress()
    }, 5000)

    // 活跃连接面板每 2 秒刷新
    setInterval(function () {
      if (connMode === 'active' && connPanel && connPanel.isConnected) renderConnPanel()
    }, 2000)

    setInterval(function () {
      if (!widgetEl || !widgetEl.parentElement) mountWidget()
      else refreshAll()
      syncView()
    }, STATUS_INTERVAL)
    setInterval(function () {
      if (modalEl && modalView === 'list' || settingsCard && settingsCard.isConnected) refreshServers()
    }, 5000)

    if (!widgetEl.parentElement) {
      var n = 0
      var timer = setInterval(function () {
        n++
        if ((widgetEl && widgetEl.parentElement) || n > 40) clearInterval(timer)
        else mountWidget()
      }, 500)
    }
  }

  // This injected classic script runs before the upstream deferred modules.
  // Restore the target synchronously so their initial requests use the right backend.
  backends = load()
  ensureSelf()
  proxyBase = loadProxy()
  try {
    proxyToken = localStorage.getItem(TOKEN_KEY) || ''
    var restored = sessionStorage.getItem(ACTIVE_KEY)
    if (restored && find(restored)) activeUuid = restored
  } catch (e) {}
  if (activeUuid && activeUuid !== SELF_UUID) {
    var restoredBackend = find(activeUuid)
    routingReady = fetchProxyStatus(restoredBackend).then(function (st) {
      if (!st || !st.authenticated) throw new Error('当前后端认证失败，请在后端管理中检查密码和代理设置')
    })
    // Attach a handler even if the upstream app has not requested data yet.
    routingReady.catch(function (error) { setTimeout(function () { notify(error.message, true) }, 0) })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()

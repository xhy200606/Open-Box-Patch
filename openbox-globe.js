/**
 * Open-Box Patch · 「全球连接」地球仪注入脚本
 *
 * 作用：在面板「概览」页的「域名过滤」卡片下方插入一张「全球连接」卡片，
 * 并在卡片首次进入视口时按需加载 `globe.bundle.js`（含 three.js，体积较大）。
 *
 * 与其他补丁资产一样：
 *   · 只往 index.html 末尾追加一个 <script> 标签，不改上游任何源码/二进制；
 *   · 资产放在 panel/dist/ 下（由 apply.sh 复制），补丁源文件放在 data/multi-backend/；
 *   · 所有 URL 按本脚本自身的 src 解析，兼容面板被挂在子路径下的情况。
 */
(function () {
  'use strict'

  var SCRIPT = document.currentScript
  if (!SCRIPT || !SCRIPT.src) return

  // 默认关闭，仅显式 opt-in 时才加载地图、数据库和 WebGL 资源。
  var ENABLED_KEY = 'openbox.globe.enabled'
  try {
    if (localStorage.getItem(ENABLED_KEY) !== '1') return
  } catch (e) { return }

  var VERSION = (function () {
    try {
      return new URL(SCRIPT.src).searchParams.get('v') || ''
    } catch (e) {
      return ''
    }
  })()

  var assetBase = new URL('.', SCRIPT.src).href
  var assetQuery = VERSION ? '?v=' + encodeURIComponent(VERSION) : ''
  var bundleUrl = new URL('globe.bundle.js' + assetQuery, assetBase).href
  var workerUrl = new URL('globe.worker.js' + assetQuery, assetBase).href

  var DOMAIN_FILTER_LABELS = ['域名过滤', '網域過濾', 'Domain filter', 'Domain Filter', '域名過濾']
  var OVERVIEW_LABELS = [/面板概览/, /面板概覽/, /Dashboard overview/i, /Overview/i]
  var PROXY_KEY = 'openbox.mb.proxy.v2'
  var DEFAULT_PROXY_PORT = 3037
  var CARD_SELECTOR = '[data-role="openbox-globe"]'
  var MAX_WAIT = 60000

  var card = null
  var placeholder = null
  var bundlePromise = null
  var retryTimer = null
  var startedAt = Date.now()

  /* ---------------- 代理地址 ---------------- */

  function resolveProxyBase() {
    try {
      var stored = localStorage.getItem(PROXY_KEY)
      if (stored) return String(stored).replace(/\/+$/, '')
    } catch (e) {}

    var proto = location.protocol === 'https:' ? 'https' : 'http'
    var host = location.hostname || '127.0.0.1'
    return proto + '://' + host + ':' + DEFAULT_PROXY_PORT
  }

  /* ---------------- 挂载点定位 ---------------- */

  function findByHeading(labels) {
    var headings = document.querySelectorAll('h1, h2, h3')
    for (var i = 0; i < headings.length; i++) {
      var text = (headings[i].textContent || '').trim()
      if (labels.indexOf(text) === -1) continue
      var section = headings[i].closest('section')
      var container = section && section.parentElement
      if (container) return { container: container, after: section }
    }
    return null
  }

  function findOverviewContainer() {
    var hit = findByHeading(DOMAIN_FILTER_LABELS)
    if (hit) return hit

    // 域名过滤被关掉时它不会渲染，退回「概览卡片」所在的同一个容器
    var cards = document.querySelectorAll('div.card')
    for (var i = 0; i < cards.length; i++) {
      var text = cards[i].textContent || ''
      for (var j = 0; j < OVERVIEW_LABELS.length; j++) {
        if (!OVERVIEW_LABELS[j].test(text)) continue
        var container = cards[i].parentElement
        if (container) return { container: container, after: null }
      }
    }
    return null
  }

  function findDomainFilterSection() {
    var headings = document.querySelectorAll('h1, h2, h3')
    for (var i = 0; i < headings.length; i++) {
      if (DOMAIN_FILTER_LABELS.indexOf((headings[i].textContent || '').trim()) === -1) continue
      var section = headings[i].closest('section')
      if (section && section.parentElement) return section
    }
    return null
  }

  /**
   * 把卡片摆到「域名过滤」正下方。
   * 概览页的卡片是异步逐张渲染的（面板概览 → 域名过滤 → 流量洞察 …），首次插入时
   * 域名过滤未必已存在，所以每次维护都要校正一次位置；域名过滤关闭（不渲染）时保持
   * 追加在容器末尾。仅在位置不对时才移动，避免反复改 DOM。
   */
  function placeCard(node) {
    var anchor = findDomainFilterSection()
    if (anchor) {
      if (node.previousElementSibling !== anchor) {
        anchor.parentElement.insertBefore(node, anchor.nextSibling)
      }
      return true
    }
    return false
  }

  /* ---------------- 占位元素 ---------------- */

  function createPlaceholder() {
    var node = document.createElement('section')
    node.className = 'card bg-base-100 border-base-300/60 border p-4 max-md:p-3'
    node.setAttribute('data-role', 'openbox-globe')
    node.setAttribute('data-state', 'loading')
    node.innerHTML =
      '<div class="text-base-content/60 text-xs font-semibold tracking-wider uppercase">全球连接</div>' +
      '<div class="mt-2 flex h-32 items-center justify-center">' +
      '<span class="loading loading-spinner loading-sm"></span>' +
      '</div>'
    return node
  }

  /* ---------------- 卡片本体 ---------------- */

  function mount() {
    if (card || bundlePromise) return
    var node = document.querySelector(CARD_SELECTOR)
    if (!node) return

    bundlePromise = import(bundleUrl)
      .then(function (mod) {
        bundlePromise = null
        if (card) return
        // 这段等待期间页面可能已经重渲染，重新取一次锚点元素
        var host = document.querySelector(CARD_SELECTOR)
        if (!host) return

        var created = mod.createGlobeCard({
          assetBase: assetBase,
          workerUrl: workerUrl,
          proxyBase: resolveProxyBase(),
          panelBase: location.origin,
          language: detectLanguage(),
          onError: function (message) {
            if (window.console && console.warn) console.warn('[openbox-globe]', message)
          },
        })

        host.replaceWith(created.element)
        card = created
        placeCard(created.element)
      })
      .catch(function (error) {
        bundlePromise = null
        var host = document.querySelector(CARD_SELECTOR)
        if (host) {
          host.setAttribute('data-state', 'error')
          host.innerHTML =
            '<div class="text-base-content/60 text-xs font-semibold tracking-wider uppercase">全球连接</div>' +
            '<div class="text-error mt-2 text-sm">地图资源加载失败：' +
            String((error && error.message) || error) +
            '</div>'
        }
      })
  }

  function unmount() {
    if (card) {
      try {
        card.dispose()
      } catch (e) {}
      card = null
    }
  }

  function detectLanguage() {
    try {
      var stored = localStorage.getItem('zashboard-language') || localStorage.getItem('language')
      if (stored) return stored
    } catch (e) {}
    var html = document.documentElement.getAttribute('lang')
    if (html) return html
    return navigator.language || 'zh'
  }

  /* ---------------- 插入与维护 ---------------- */

  var observer = null

  function ensureCard() {
    var existing = document.querySelector(CARD_SELECTOR)
    // DNS settings also contain a Domain Filter heading. Only the Overview
    // route is a valid map host, even when the optional map is enabled.
    var route = (location.hash ? location.hash.slice(1).split('?')[0] : location.pathname).replace(/\/+$/, '')
    if (!/(?:^|\/)(overview|active)$/.test(route)) {
      unmount()
      if (existing) existing.remove()
      return
    }

    if (existing) {
      // 卡片被 SPA 重渲染拿掉后重建出来的，或是位置被后渲染的卡片挤走了，都要校正
      if (card && !card.element.isConnected) unmount()
      placeCard(existing)
      return
    }

    if (card) unmount()

    var found = findOverviewContainer()
    if (!found) return

    placeholder = createPlaceholder()

    if (!placeCard(placeholder)) {
      if (found.after && found.after.nextSibling) {
        found.container.insertBefore(placeholder, found.after.nextSibling)
      } else {
        found.container.appendChild(placeholder)
      }
    }

    if (observer && placeholder) observer.observe(placeholder)
    // 已经在视口内（或 Observer 不可用）时直接开始加载
    if (!observer || isInViewport(placeholder)) mount()
  }

  function isInViewport(node) {
    var rect = node.getBoundingClientRect()
    var height = window.innerHeight || document.documentElement.clientHeight
    return rect.top < height + 200 && rect.bottom > -200
  }

  function setupObserver() {
    if (typeof IntersectionObserver !== 'function') return
    observer = new IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) continue
          observer.unobserve(entries[i].target)
          mount()
        }
      },
      { rootMargin: '200px 0px' },
    )
  }

  var scheduled = false

  function schedule() {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(function () {
      scheduled = false
      ensureCard()
    })
  }

  function watch() {
    var mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { childList: true, subtree: true })

    window.addEventListener('hashchange', schedule)
    window.addEventListener('popstate', schedule)

    // SPA 里子路由切换未必触发上面两类事件，兜一个低频轮询
    retryTimer = setInterval(function () {
      schedule()
      if (Date.now() - startedAt > MAX_WAIT && card && card.element.isConnected) {
        clearInterval(retryTimer)
        retryTimer = null
      }
    }, 1000)

    schedule()
  }

  function start() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', start, { once: true })
      return
    }
    setupObserver()
    watch()
  }

  start()
})()

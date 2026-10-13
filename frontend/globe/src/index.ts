/**
 * [Open-Box Patch] 「全球连接」卡片。
 *
 * 结构与上游 zashboard 的 `EarthGlobeCard.vue` 一一对应（标题栏 / 投影与样式控件 /
 * 城市标签 / 自转 / 展开 / 公网 IP 服务与本机 IP / 图例 / 数据来源与归属 / 悬停详情 /
 * 数据库与定位的各类状态覆盖层），差别有四点：
 *
 *   1. 用原生 DOM 取代 Vue SFC（补丁不引入 Vue 运行时）；
 *   2. **布局样式自带**：面板的 Tailwind 是按用到的类裁剪的，原子类（h-96、bg-black、
 *      bg-base-100/75 …）在不同上游版本里可能不存在，靠它们做布局会随升级塌掉。
 *      因此尺寸/定位/间距全部由下面的 `.ob-globe-*` 样式表提供，只借用面板的
 *      daisyUI 主题变量（--color-*）与 btn/select 组件类保持观感一致；
 *   3. 公网 IP 归属走本机服务端代理；城市数据库由代理镜像，局域网只下一次；
 *   4. 连接数据来自面板自身的 Clash 兼容接口。
 */
import * as ipaddr from 'ipaddr.js'
import { startConnections, stopConnections } from './adapters/connections'
import {
  IP_INFO_API,
  IP_INFO_API_OPTIONS,
  cachePublicIPInfo,
  dnsAnswerType,
  getCachedPublicIPInfo,
  getPublicIPInfo,
  queryDNS,
  type IPInfo,
  type IPInfoAPI,
} from './adapters/geoip'
import { setAssetBase, setPanelBase, setProxyBase } from './adapters/runtime'
import { readColorScheme, watchColorScheme, type ThemeColorScheme } from './adapters/theme'
import { prettyBytesHelper } from './adapters/utils'
import { createEarthRenderer, type EarthRenderer } from './earth/earth-renderer'
import { ENDPOINT_PALETTE } from './earth/palette'
import type { EarthProjection } from './earth/projection'
import type { EarthVisualMode } from './earth/renderer-types'
import { loadGlobePreferences, saveGlobePreferences } from './preferences'
import type { RelayNode } from './earth/relays'
import { buildEarthRoutes } from './earth/routes'
import {
  DBIP_COMPRESSED_BYTES,
  DBIP_STORED_BYTES,
  type EarthEndpointInfo,
  type EarthLocation,
  type EarthLocationHint,
  type EarthRouteCategory,
  type GeoDatabaseError,
  type GeoDatabaseStatus,
  type GeoWorkerRequest,
  type GeoWorkerResponse,
} from './earth/types'
import { createTranslator, workerLocale, type Translator } from './i18n'

export interface GlobeMountOptions {
  /** 补丁资产目录（含 globe-assets/）的绝对地址 */
  assetBase: string
  /** globe.worker.js 的绝对地址 */
  workerUrl: string
  /** 多后端代理地址，例如 http://192.168.1.1:3037 */
  proxyBase: string
  /** 面板自身 origin */
  panelBase: string
  /** 城市数据库地址，默认取代理镜像 */
  dbUrl?: string
  /** zh / zh-tw / en */
  language?: string
  onError?: (message: string) => void
}

export interface GlobeCard {
  element: HTMLElement
  dispose: () => void
}

interface LookupRequest {
  resolve: (locations: Record<string, EarthLocation | null>) => void
}

const INIT_DELAY = 400
const INIT_IDLE_TIMEOUT = 1000
const REFRESH_DEBOUNCE = 150
const DNS_CONCURRENCY = 6
const DNS_TTL_FALLBACK = 30_000
const PROXY_READY_TIMEOUT = 4000
const ORIGIN_AUTO_RETRIES = 2
const ORIGIN_RETRY_DELAY = 5000

/* ================= 样式（自带，不依赖面板的原子类） ================= */

const STYLE_ID = 'openbox-globe-style'

const STYLE = `
.ob-globe-root{box-sizing:border-box;padding:1rem;font-family:inherit;font-size:.875rem;line-height:1.5;color:var(--color-base-content,#111)}
@media (max-width:768px){.ob-globe-root{padding:.75rem}}
.ob-globe-head{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.ob-globe-title{font-size:.875rem;line-height:1.5;font-weight:600;letter-spacing:normal;text-transform:none;color:inherit}
.ob-globe-tools{display:flex;align-items:center;gap:.25rem;flex-wrap:wrap;justify-content:flex-end}
.ob-globe-seg{display:inline-flex}
.ob-globe-stage{position:relative;margin-top:.5rem;width:100%;height:24rem;overflow:hidden;border-radius:.75rem;background:#0b0b0b}
.ob-globe-stage--flat{background:transparent}
.ob-globe-canvas{position:absolute;top:0;right:0;bottom:0;left:0;touch-action:none}
.ob-globe-canvas canvas{display:block;width:100%;height:100%}
.ob-globe-topbar{position:absolute;top:.5rem;right:.5rem;left:.5rem;display:flex;flex-wrap:wrap;gap:.375rem;pointer-events:none}
.ob-globe-chip{background:color-mix(in srgb,var(--color-base-100,#fff) 78%,transparent);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);display:inline-flex;align-items:center;height:2rem;gap:.375rem;border-radius:var(--app-radius-field,.5rem);padding:0 .5rem;pointer-events:auto;font-family:inherit;font-size:.75rem;color:var(--color-base-content,#111)}
.ob-globe-bottombar{position:absolute;right:.5rem;bottom:.5rem;left:.5rem;display:flex;align-items:flex-end;justify-content:space-between;gap:.5rem;pointer-events:none}
.ob-globe-credits{display:flex;flex-direction:column;align-items:flex-start;gap:.125rem;font-size:10px;pointer-events:auto;line-height:1.4}
.ob-globe-credits a{color:rgba(255,255,255,.68);text-decoration:none}
.ob-globe-credits a:hover{color:#fff;text-decoration:underline}
.ob-globe-credits--flat a{color:color-mix(in srgb,var(--color-base-content,#111) 60%,transparent)}
.ob-globe-credits--flat a:hover{color:var(--color-base-content,#111)}
.ob-globe-legend{list-style:none;margin:0;background:color-mix(in srgb,var(--color-base-100,#fff) 78%,transparent);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.125rem .625rem;border-radius:.5rem;padding:.375rem .5rem;font-size:10px;box-shadow:0 1px 4px rgba(0,0,0,.14)}
.ob-globe-legend li{display:flex;align-items:center;gap:.25rem}
.ob-globe-legend i{display:block;width:.5rem;height:.5rem;border-radius:9999px;flex:none;box-shadow:0 0 0 1px color-mix(in srgb,var(--color-base-content,#111) 22%,transparent)}
.ob-globe-legend span{color:color-mix(in srgb,var(--color-base-content,#111) 72%,transparent);white-space:nowrap}
.ob-globe-overlay{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;align-items:center;justify-content:center;padding:1rem;pointer-events:none}
.ob-globe-box{background:color-mix(in srgb,var(--color-base-100,#fff) 92%,transparent);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border-radius:.75rem;padding:1rem;text-align:center;font-size:.875rem;line-height:1.5;box-shadow:0 12px 32px rgba(0,0,0,.2);max-width:28rem;pointer-events:auto;color:var(--color-base-content,#111)}
.ob-globe-box--plain{background:color-mix(in srgb,var(--color-base-100,#fff) 80%,transparent);text-align:left;padding:.75rem 1rem;max-width:none}
.ob-globe-inline{display:flex;align-items:center;gap:.5rem}
.ob-globe-spinner{width:1rem;height:1rem;flex:none;border:2px solid color-mix(in srgb,var(--color-primary,#3b82f6) 28%,transparent);border-top-color:var(--color-primary,#3b82f6);border-radius:9999px;animation:ob-globe-spin .8s linear infinite}
@keyframes ob-globe-spin{to{transform:rotate(360deg)}}
.ob-globe-progress{position:relative;width:100%;margin-top:.75rem;height:.375rem;border-radius:9999px;background:color-mix(in srgb,var(--color-base-content,#111) 14%,transparent);overflow:hidden}
.ob-globe-progress i{position:absolute;top:0;bottom:0;left:0;background:var(--color-primary,#3b82f6);border-radius:9999px;transition:width .2s ease}
.ob-globe-muted{color:color-mix(in srgb,var(--color-base-content,#111) 66%,transparent)}
.ob-globe-tiny{font-size:.75rem;line-height:1.5}
.ob-globe-strong{font-weight:600}
.ob-globe-row{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem}
.ob-globe-actions{display:flex;align-items:center;justify-content:center;gap:.5rem;margin-top:.75rem}
.ob-globe-mt1{margin-top:.375rem}
.ob-globe-mt2{margin-top:.75rem}
.ob-globe-error{color:var(--color-error,#dc2626)}
.ob-globe-warning{color:var(--color-warning,#d97706)}
.ob-globe-hostlist{margin-top:.5rem;border-top:1px solid var(--color-base-300,#e5e7eb);padding-top:.375rem}
.ob-globe-hostrow{display:flex;max-width:16rem;align-items:center;justify-content:space-between;gap:.75rem;line-height:1.3}
.ob-globe-ellipsis{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ob-globe-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ob-globe-ip{font-variant-numeric:tabular-nums}
.ob-globe-nowrap{white-space:nowrap;flex:none}
.ob-globe-tooltip{position:fixed;z-index:10000;pointer-events:none;display:none;background:var(--color-base-100,#fff);border:1px solid var(--color-base-300,#e5e7eb);border-radius:.5rem;padding:.5rem;font-size:.75rem;line-height:1.5;box-shadow:0 12px 32px rgba(0,0,0,.22);min-width:10rem;color:var(--color-base-content,#111)}
.ob-globe-tooltip[data-open="1"]{display:block}
.ob-globe-hidden{display:none !important}
.ob-globe-expanded{position:fixed;top:0;right:0;bottom:0;left:0;z-index:60;display:flex;flex-direction:column;border-radius:0}
@media (min-width:769px){
  .home-page.sidebar-expanded .ob-globe-expanded{left:16rem}
  .home-page.sidebar-collapsed .ob-globe-expanded{left:4.5rem}
}
.ob-globe-expanded .ob-globe-stage{flex:1 1 auto;height:auto;min-height:0}
.ob-globe-expanded .ob-globe-credits a{color:rgba(255,255,255,.68)}
.ob-globe-ico{display:inline-flex;align-items:center;justify-content:center;line-height:0}
`

/* ================= 小工具 ================= */

type Child = Node | null | undefined | false

/** 线路类别 → 文案键：直连 / 经代理（单跳）/ 经中转（经中转再代理） */
const CATEGORY_LABEL_KEYS: Record<EarthRouteCategory, string> = {
  direct: 'direct',
  proxy: 'legendProxied',
  relay: 'legendRelay',
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string; style?: Record<string, string>; attrs?: Record<string, string> } = {},
  children: Child[] = [],
) => {
  const node = document.createElement(tag)
  if (options.className) node.className = options.className
  if (options.text !== undefined) node.textContent = options.text
  if (options.style) for (const [k, v] of Object.entries(options.style)) node.style.setProperty(k, v)
  if (options.attrs) for (const [k, v] of Object.entries(options.attrs)) node.setAttribute(k, v)
  for (const child of children) if (child) node.appendChild(child as Node)
  return node
}

const SVG_NS = 'http://www.w3.org/2000/svg'

const icon = (paths: string[], size = 16) => {
  const node = document.createElementNS(SVG_NS, 'svg')
  node.setAttribute('viewBox', '0 0 24 24')
  node.setAttribute('fill', 'none')
  node.setAttribute('stroke', 'currentColor')
  node.setAttribute('stroke-width', '1.7')
  node.setAttribute('stroke-linecap', 'round')
  node.setAttribute('stroke-linejoin', 'round')
  node.setAttribute('width', String(size))
  node.setAttribute('height', String(size))
  node.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    node.appendChild(p)
  }
  return node
}

const ICONS = {
  mapPin: ['M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z', 'M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z'],
  play: ['M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z'],
  pause: ['M15.75 5.25v13.5', 'M8.25 5.25v13.5'],
  expand: ['M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9', 'M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15', 'M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9', 'M20.25 20.25h-4.5m4.5 0v-4.5m0 4.5L15 15'],
  collapse: ['M9 9V4.5M9 9H4.5M9 9 3.75 3.75', 'M9 15v4.5M9 15H4.5M9 15l-5.25 5.25', 'M15 9h4.5M15 9V4.5M15 9l5.25-5.25', 'M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25'],
  eye: ['M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'],
  eyeSlash: [
    'M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774',
    'M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.243 4.243L9.88 9.88',
  ],
  retry: [
    'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99',
  ],
}

/** 与上游 p-limit 等价的极简并发限制 */
const createLimiter = (max: number) => {
  let active = 0
  const queue: Array<() => void> = []
  const next = () => {
    if (active >= max) return
    const job = queue.shift()
    if (!job) return
    active += 1
    job()
  }
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1
            next()
          })
      })
      next()
    })
}

const normalizeIP = (value: string) => {
  try {
    return ipaddr.parse(value).toNormalizedString()
  } catch {
    return null
  }
}

const isValidIP = (value: string) => Boolean(value && ipaddr.isValid(value))

const maskIP = (value: string) => {
  if (!isValidIP(value)) return '—'
  const address = ipaddr.parse(value)
  if (address.kind() === 'ipv4') {
    const octets = address.toByteArray()
    return `${octets[0]}.${octets[1]}.*.*`
  }
  const parts = address.toNormalizedString().split(':')
  return `${parts[0]}:${parts[1]}:****:****`
}

/* ================= 卡片 ================= */

export const createGlobeCard = (options: GlobeMountOptions): GlobeCard => {
  setAssetBase(options.assetBase)
  setProxyBase(options.proxyBase)
  setPanelBase(options.panelBase)

  const language = options.language || document.documentElement.lang || navigator.language || 'zh'
  const t: Translator = createTranslator(language)
  const locale = workerLocale(language)
  const proxyBase = options.proxyBase.replace(/\/+$/, '')
  const dbUrl = options.dbUrl || `${proxyBase}/api/mb/globe/db`

  const dbDownloadLabel = prettyBytesHelper(DBIP_COMPRESSED_BYTES)
  const dbStoredLabel = prettyBytesHelper(DBIP_STORED_BYTES)

  let disposed = false
  let renderer: EarthRenderer | undefined
  let worker: Worker | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let refreshRunning = false
  let refreshQueued = false
  let initTimer: ReturnType<typeof setTimeout> | null = null
  let initIdleHandle: number | null = null
  let originRequestID = 0
  let originRetries = 0
  let originRetryTimer: ReturnType<typeof setTimeout> | null = null
  let originIP = ''
  let originAPIInfo: IPInfo | null = null
  let originStatus: 'loading' | 'ready' | 'error' = 'loading'
  let routeCount = 0
  let routesLoading = false
  let proxyAvailable = true
  let lookupID = 0
  let rendererFailedMessage = ''
  let latestConnections: Parameters<typeof buildEarthRoutes>[0] = []

  const cleanup: Array<() => void> = []

  const preferences = loadGlobePreferences()
  let api: IPInfoAPI = preferences.api
  let projection: EarthProjection = preferences.projection
  let visualMode: EarthVisualMode = preferences.visualMode
  let showOriginIP = preferences.showOriginIP
  let showCityLabels = preferences.showCityLabels
  let rotationPaused = preferences.rotationPaused
  let showRelays = preferences.showRelays
  let relayNodes: RelayNode[] = []
  let relayLoadFailed = false
  let relayLoading = false
  let unresolvedHops = 0
  let routeCategoryCounts: Record<EarthRouteCategory, number> = { direct: 0, proxy: 0, relay: 0 }
  /** 每条线路的角色序列（如 `origin>relay>proxy`），排障用 */
  let routeShapes: string[] = []
  /** 每条线路的终点及其承载的域名（悬停卡片用的就是这份数据：直连是目的地，代理类是落地节点） */
  let routeTerminals: Array<{ category: EarthRouteCategory; role: string; hosts: string[] }> = []
  const saveView = () => saveGlobePreferences({ projection, visualMode, showCityLabels, rotationPaused, showRelays, api, showOriginIP })
  let expanded = false
  let databaseStatus: GeoDatabaseStatus = 'checking'
  let databaseError: GeoDatabaseError | undefined
  let recoveredCorruptCache = false
  let downloadedBytes = 0
  let downloadTotalBytes = DBIP_COMPRESSED_BYTES

  const locationCache = new Map<string, EarthLocation | null>()
  const dnsCache = new Map<string, { ip: string | null; expiresAt: number }>()
  const dnsRequests = new Map<string, Promise<string | null>>()
  const lookupRequests = new Map<number, LookupRequest>()
  const dnsLimit = createLimiter(DNS_CONCURRENCY)
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const routeActiveCount = () => latestConnections.length

  /* ---------- 样式注入（全局唯一，可多实例） ---------- */

  let styleTag = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!styleTag) {
    styleTag = el('style', { attrs: { id: STYLE_ID } })
    styleTag.textContent = STYLE
    document.head.appendChild(styleTag)
    cleanup.push(() => document.getElementById(STYLE_ID)?.remove())
  }

  /* ---------- DOM ---------- */

  const canvasHost = el('div', { className: 'ob-globe-canvas' })

  const apiSelect = el('select', {
    className: 'select select-sm',
    style: { 'min-height': '2rem', height: '2rem', width: 'auto', border: '0', background: 'transparent' },
    attrs: { 'aria-label': t('originAPI'), title: t('originAPI') },
  })
  for (const item of IP_INFO_API_OPTIONS) {
    apiSelect.appendChild(el('option', { text: item, attrs: { value: item } }))
  }
  apiSelect.value = api

  const originIPText = el('span', { className: 'ob-globe-ip', text: t('getting') })
  const originIPToggle = el(
    'button',
    {
      className: 'btn btn-ghost btn-circle btn-xs ob-globe-ico',
      attrs: { type: 'button', 'aria-label': t('toggleIP'), title: t('toggleIP') },
    },
    [icon(ICONS.eye, 14)],
  )

  const retryButton = el(
    'button',
    {
      className: 'btn btn-sm btn-square ob-globe-ico',
      style: { display: 'none' },
      attrs: { type: 'button', 'aria-label': t('retry'), title: t('retry') },
    },
    [icon(ICONS.retry)],
  )

  const topOverlay = el('div', { className: 'ob-globe-topbar' }, [
    el('div', { className: 'ob-globe-chip' }, [apiSelect]),
    el('div', { className: 'ob-globe-chip' }, [
      el('span', { className: 'ob-globe-muted', text: t('localIP') }),
      originIPText,
      originIPToggle,
    ]),
    retryButton,
  ])

  const legend = el('ul', { className: 'ob-globe-legend', attrs: { 'aria-label': t('legend') } })
  const rebuildLegend = () => {
    legend.replaceChildren()
    // 一个颜色一条：白=本机、橙=直连（含目的地）、青=经代理与其落地节点、紫=经中转与其中转节点
    for (const item of [
      { color: ENDPOINT_PALETTE.origin, label: t('role_origin') },
      { color: ENDPOINT_PALETTE.direct, label: t('direct') },
      { color: ENDPOINT_PALETTE.destination, label: t('legendProxyNode') },
      { color: ENDPOINT_PALETTE.relay, label: t('legendRelayNode') },
    ]) {
      legend.appendChild(
        el('li', {}, [
          el('i', { style: { background: item.color } }),
          el('span', { text: item.label }),
        ]),
      )
    }
  }
  rebuildLegend()

  const credits = el('div', { className: 'ob-globe-credits' })
  for (const item of [
    { href: 'https://db-ip.com/db/lite.php', text: 'DB-IP City Lite' },
    { href: 'https://www.solarsystemscope.com/textures/', text: 'Solar System Scope · CC BY 4.0' },
  ]) {
    credits.appendChild(
      el('a', { text: item.text, attrs: { href: item.href, target: '_blank', rel: 'noopener noreferrer' } }),
    )
  }

  const bottomOverlay = el('div', { className: 'ob-globe-bottombar' }, [credits, legend])

  const overlay = el('div', { className: 'ob-globe-overlay' })
  const overlayBox = el('div', { className: 'ob-globe-box' })
  overlay.appendChild(overlayBox)

  const stage = el('div', { className: 'ob-globe-stage' }, [canvasHost, topOverlay, bottomOverlay, overlay])

  const titleNode = el('div', { className: 'ob-globe-title', text: t('globeTitle') })
  const relayNotice = el('div', { className: 'ob-globe-tiny ob-globe-muted ob-globe-hidden' })
  const relayButton = el('button', { className: 'btn btn-ghost btn-sm', text: t('showRelays'), attrs: { type: 'button' } })

  const projection3D = el('button', { className: 'btn btn-xs', text: '3D', attrs: { type: 'button' } })
  const projection2D = el('button', { className: 'btn btn-xs', text: '2D', attrs: { type: 'button' } })
  const projectionControl = el('div', { className: 'join ob-globe-seg', attrs: { title: t('projection'), 'aria-label': t('projection') } }, [
    projection3D,
    projection2D,
  ])

  const styleSelect = el('select', {
    className: 'select select-sm',
    style: { 'min-height': '2rem', height: '2rem', width: 'auto' },
    attrs: { 'aria-label': t('visualStyle'), title: t('visualStyle') },
  })
  for (const item of [
    { value: 'space', label: t('visualStyle_space') },
    { value: 'flat', label: t('visualStyle_flat') },
  ]) {
    styleSelect.appendChild(el('option', { text: item.label, attrs: { value: item.value } }))
  }
  styleSelect.value = visualMode

  const cityLabelButton = el(
    'button',
    { className: 'btn btn-ghost btn-sm btn-square ob-globe-ico', attrs: { type: 'button' } },
    [icon(ICONS.mapPin)],
  )
  const rotationButton = el(
    'button',
    { className: 'btn btn-ghost btn-sm btn-square ob-globe-ico', attrs: { type: 'button' } },
    [icon(ICONS.pause)],
  )
  const expandButton = el(
    'button',
    { className: 'btn btn-ghost btn-sm btn-square ob-globe-ico', attrs: { type: 'button' } },
    [icon(ICONS.expand)],
  )

  const root = el(
    'section',
    { className: 'card bg-base-100 border-base-300/60 border ob-globe-root', attrs: { 'data-role': 'openbox-globe' } },
    [
      el('div', { className: 'ob-globe-head' }, [
        titleNode,
        el('div', { className: 'ob-globe-tools' }, [
          projectionControl,
          relayButton,
          styleSelect,
          cityLabelButton,
          rotationButton,
          expandButton,
        ]),
      ]),
      relayNotice,
      stage,
    ],
  )

  const tooltip = el('div', { className: 'ob-globe-tooltip' })
  document.body.appendChild(tooltip)
  cleanup.push(() => tooltip.remove())

  /* ---------- 状态覆盖层 ---------- */

  const setOverlay = (kind: 'none' | 'plain' | 'box') => {
    overlay.className = kind === 'none' ? 'ob-globe-overlay ob-globe-hidden' : 'ob-globe-overlay'
    overlayBox.className = kind === 'plain' ? 'ob-globe-box ob-globe-box--plain' : 'ob-globe-box'
  }

  const renderStatus = () => {
    originIPText.textContent =
      originStatus === 'loading'
        ? t('getting')
        : originStatus === 'error'
          ? t('testFailed')
          : showOriginIP
            ? originIP
            : maskIP(originIP)
    originIPToggle.replaceChildren(icon(showOriginIP ? ICONS.eye : ICONS.eyeSlash, 14))

    const showRetry =
      databaseStatus === 'error' ||
      originStatus === 'error' ||
      !proxyAvailable ||
      (databaseStatus === 'ready' && originStatus === 'ready' && routeCount === 0 && routeActiveCount() > 0)
    retryButton.style.display = showRetry ? '' : 'none'

    const flatLook = projection === '2d' || visualMode === 'flat'
    stage.className = flatLook ? 'ob-globe-stage ob-globe-stage--flat' : 'ob-globe-stage'
    credits.className = flatLook ? 'ob-globe-credits ob-globe-credits--flat' : 'ob-globe-credits'

    projection3D.className = `btn btn-xs${projection === '3d' ? ' btn-active' : ''}`
    projection2D.className = `btn btn-xs${projection === '2d' ? ' btn-active' : ''}`
    styleSelect.style.display = projection === '2d' ? 'none' : ''
    rotationButton.style.display = projection === '2d' ? 'none' : ''
    cityLabelButton.style.opacity = showCityLabels ? '1' : '.4'

    cityLabelButton.setAttribute('aria-label', t(showCityLabels ? 'hideCityLabels' : 'showCityLabels'))
    cityLabelButton.setAttribute('title', t(showCityLabels ? 'hideCityLabels' : 'showCityLabels'))
    cityLabelButton.setAttribute('aria-pressed', String(showCityLabels))

    rotationButton.replaceChildren(icon(rotationPaused ? ICONS.play : ICONS.pause))
    rotationButton.setAttribute('aria-label', t(rotationPaused ? 'resumeRotation' : 'pauseRotation'))
    rotationButton.setAttribute('title', t(rotationPaused ? 'resumeRotation' : 'pauseRotation'))
    rotationButton.setAttribute('aria-pressed', String(rotationPaused))
    relayButton.classList.toggle('btn-active', showRelays)
    relayButton.setAttribute('aria-pressed', String(showRelays))
    relayNotice.textContent = t(relayLoadFailed ? 'relayUnavailable' : 'relayIncomplete')
    relayNotice.classList.toggle('ob-globe-hidden', !showRelays || (!relayLoadFailed && !unresolvedHops))

    expandButton.replaceChildren(icon(expanded ? ICONS.collapse : ICONS.expand))
    expandButton.setAttribute('aria-label', t(expanded ? 'collapse' : 'expand'))
    expandButton.setAttribute('title', t(expanded ? 'collapse' : 'expand'))
    expandButton.setAttribute('aria-pressed', String(expanded))

    const retry = el('button', { className: 'btn btn-sm ob-globe-mt2', text: t('retry'), attrs: { type: 'button' } })
    retry.addEventListener('click', () => retryAll())

    if (rendererFailedMessage) {
      setOverlay('box')
      overlayBox.replaceChildren(el('div', { className: 'ob-globe-error', text: rendererFailedMessage }))
      return
    }

    if (!proxyAvailable) {
      setOverlay('box')
      overlayBox.replaceChildren(
        el('div', { className: 'ob-globe-warning', text: t('proxyMissing') }),
        el('div', { className: 'ob-globe-muted ob-globe-tiny ob-globe-mt1', text: proxyBase }),
        retry,
      )
      return
    }

    if (databaseStatus === 'checking' || databaseStatus === 'loading-cache') {
      setOverlay('box')
      overlayBox.replaceChildren(
        el('div', { className: 'ob-globe-inline' }, [
          el('span', { className: 'ob-globe-spinner' }),
          el('span', { text: t(databaseStatus === 'checking' ? 'databaseChecking' : 'databaseLoading') }),
        ]),
      )
      return
    }

    if (databaseStatus === 'idle') {
      setOverlay('box')
      downloadTotalBytes = DBIP_COMPRESSED_BYTES
      const download = el('button', {
        className: 'btn btn-primary btn-sm',
        text: t('databaseDownload'),
        attrs: { type: 'button' },
      })
      download.addEventListener('click', () => postWorker({ type: 'download' }))
      overlayBox.replaceChildren(
        el('div', { className: 'ob-globe-strong', text: t('databaseConsentTitle') }),
        el('p', {
          className: 'ob-globe-muted ob-globe-mt1',
          text: t('databaseConsent', { download: dbDownloadLabel, stored: dbStoredLabel }),
        }),
        el('p', {
          className: 'ob-globe-muted ob-globe-tiny ob-globe-mt1',
          text: t('databaseConsentSource'),
        }),
        recoveredCorruptCache
          ? el('p', { className: 'ob-globe-warning ob-globe-tiny ob-globe-mt1', text: t('databaseCacheRecovered') })
          : null,
        el('div', { className: 'ob-globe-actions' }, [
          download,
          el('a', {
            className: 'link ob-globe-tiny',
            text: t('databaseLearnMore'),
            attrs: { href: 'https://db-ip.com/db/lite.php', target: '_blank', rel: 'noopener noreferrer' },
          }),
        ]),
      )
      return
    }

    if (databaseStatus === 'downloading') {
      setOverlay('box')
      const percent = Math.min(100, (downloadedBytes / Math.max(1, downloadTotalBytes)) * 100)
      const cancel = el('button', { className: 'btn btn-ghost btn-sm ob-globe-mt2', text: t('cancel'), attrs: { type: 'button' } })
      cancel.addEventListener('click', () => postWorker({ type: 'cancel' }))
      overlayBox.replaceChildren(
        el('div', { className: 'ob-globe-row' }, [
          el('span', { className: 'ob-globe-strong', text: t('databaseDownloading') }),
          el('span', {
            className: 'ob-globe-muted ob-globe-tiny',
            text: `${prettyBytesHelper(downloadedBytes)} / ${downloadTotalBytes ? prettyBytesHelper(downloadTotalBytes) : '—'}`,
          }),
        ]),
        el('div', { className: 'ob-globe-progress' }, [
          el('i', { style: { width: `${percent}%` } }),
        ]),
        cancel,
      )
      return
    }

    if (databaseStatus === 'error') {
      setOverlay('box')
      overlayBox.replaceChildren(
        el('div', { className: 'ob-globe-error', text: t(`databaseError_${databaseError ?? 'unknown'}`) }),
        retry,
      )
      return
    }

    if (databaseStatus === 'ready' && originStatus === 'error') {
      setOverlay('plain')
      overlayBox.replaceChildren(el('div', { text: t('originError') }))
      return
    }

    if (databaseStatus === 'ready' && originStatus === 'ready' && !routesLoading && routeCount === 0) {
      setOverlay('plain')
      overlayBox.replaceChildren(
        el('div', { text: routeActiveCount() > 0 ? t('noLocatedConnections') : t('noConnections') }),
      )
      return
    }

    setOverlay('none')
  }

  /* ---------- 端点悬停 ---------- */

  const showTooltip = (info: EarthEndpointInfo | null, x?: number, y?: number) => {
    if (!info) {
      tooltip.removeAttribute('data-open')
      return
    }

    tooltip.replaceChildren(
      ...[
        el('div', {
          className: 'ob-globe-strong',
          text: [info.city, info.country].filter(Boolean).join(', ') || t('unknown'),
        }),
        el('div', {
          className: 'ob-globe-muted',
          text: `${t('endpointRole')}: ${t(`role_${info.role}`)}`,
        }),
        // 本机是所有线路的共同起点，类别没有意义（它会被各类线路合并统计）
        info.role === 'origin'
          ? null
          : el('div', {
              className: 'ob-globe-muted',
              text: `${t('trafficType')}: ${t(CATEGORY_LABEL_KEYS[info.category])}`,
            }),
        el('div', { className: 'ob-globe-muted', text: `${t('connectionCount')}: ${info.connections}` }),
      ].filter((node): node is HTMLElement => Boolean(node)),
    )

    // 下载量 Top5 挂在**线路终点**上：直连是目的地，经代理 / 经中转是落地节点
    if (info.topHosts.length > 0) {
      const list = el('div', { className: 'ob-globe-hostlist' }, [
        el('div', { className: 'ob-globe-muted', text: t('topDownloadedHosts') }),
      ])
      for (const item of info.topHosts) {
        list.appendChild(
          el('div', { className: 'ob-globe-hostrow' }, [
            el('span', { className: 'ob-globe-mono', text: item.host }),
            el('span', { className: 'ob-globe-muted ob-globe-nowrap', text: prettyBytesHelper(item.downloaded) }),
          ]),
        )
      }
      tooltip.appendChild(list)
    }

    tooltip.setAttribute('data-open', '1')
    tooltip.style.left = `${Math.min(window.innerWidth - 200, (x ?? 0) + 12)}px`
    tooltip.style.top = `${Math.min(window.innerHeight - 120, (y ?? 0) + 12)}px`
  }

  /* ---------- 连接数据 ---------- */

  const loadDirectOutboundNames = async () => {
    try {
      const response = await fetch(`${options.panelBase}/api/controller/proxies`, {
        cache: 'no-store',
        credentials: 'same-origin',
      })
      if (!response.ok) return new Set<string>()
      const payload = (await response.json()) as { proxies?: Record<string, { type?: string }> }
      return new Set(
        Object.entries(payload.proxies ?? {})
          .filter(([, proxy]) => ['Direct', 'Reject', 'Compatible', 'Pass'].includes(proxy.type ?? ''))
          .map(([name]) => name),
      )
    } catch {
      return new Set<string>()
    }
  }

  const resolveHostname = (hostname: string): Promise<string | null> => {
    const cached = dnsCache.get(hostname)
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.ip)

    const pending = dnsRequests.get(hostname)
    if (pending) return pending

    const request = dnsLimit(async () => {
      for (const [type, answerType] of [
        ['A', dnsAnswerType.A],
        ['AAAA', dnsAnswerType.AAAA],
      ] as const) {
        try {
          const data = await queryDNS(hostname, type)
          for (const answer of data.Answer ?? []) {
            if (answer.type !== answerType) continue
            const ip = normalizeIP(answer.data)
            if (!ip) continue
            dnsCache.set(hostname, { ip, expiresAt: Date.now() + Math.max(1, answer.TTL) * 1000 })
            return ip
          }
        } catch {
          /* 该类型无记录或接口不可用，换下一种 */
        }
      }
      dnsCache.set(hostname, { ip: null, expiresAt: Date.now() + DNS_TTL_FALLBACK })
      return null
    }).finally(() => dnsRequests.delete(hostname))

    dnsRequests.set(hostname, request)
    return request
  }

  const resolveDestinationIPs = async (hostnames: string[]) => {
    const entries = await Promise.all(
      hostnames.map(async (hostname) => [hostname, await resolveHostname(hostname)] as const),
    )
    return Object.fromEntries(entries)
  }

  const lookupLocations = async (ips: string[], workerLocaleID: string) => {
    const result: Record<string, EarthLocation | null> = {}
    const missing: string[] = []

    for (const ip of ips) {
      if (locationCache.has(ip)) result[ip] = locationCache.get(ip) ?? null
      else missing.push(ip)
    }

    if (missing.length > 0 && worker) {
      const id = ++lookupID
      const locations = await new Promise<Record<string, EarthLocation | null>>((resolve) => {
        lookupRequests.set(id, { resolve })
        postWorker({ type: 'lookup', id, ips: missing, locale: workerLocaleID })
      })

      for (const [ip, location] of Object.entries(locations)) {
        locationCache.set(ip, location)
        result[ip] = location
      }
    }

    return result
  }

  const refreshRoutes = async () => {
    if (refreshRunning) {
      refreshQueued = true
      return
    }

    refreshRunning = true

    do {
      refreshQueued = false

      if (databaseStatus !== 'ready' || !isValidIP(originIP)) {
        routeCount = 0
        renderer?.setRoutes([])
        continue
      }

      routesLoading = true
      renderStatus()

      const snapshot = latestConnections
      const routeOriginIP = originIP
      const routeOriginRequestID = originRequestID
      const preferredOrigin: EarthLocationHint | null =
        api !== IP_INFO_API.IPIP && originAPIInfo
          ? {
              latitude: originAPIInfo.latitude,
              longitude: originAPIInfo.longitude,
              city: originAPIInfo.city,
              country: originAPIInfo.country,
            }
          : null

      try {
        const result = await buildEarthRoutes(
          snapshot,
          routeOriginIP,
          locale,
          lookupLocations,
          preferredOrigin,
          resolveDestinationIPs,
          { show: showRelays, nodes: relayNodes },
        )

        if (!disposed && routeOriginRequestID === originRequestID && routeOriginIP === originIP) {
          routeCount = result.routes.length
          unresolvedHops = result.unresolvedHops
          routeCategoryCounts = { direct: 0, proxy: 0, relay: 0 }
          for (const route of result.routes) routeCategoryCounts[route.category] += 1
          routeShapes = result.routes.map((route) => route.path.map((point) => point.role).join('>'))
          routeTerminals = result.routes.map((route) => ({
            category: route.category,
            role: route.path.at(-1)?.role ?? '',
            hosts: route.topHosts.map((host) => host.host),
          }))
          if (result.origin) renderer?.setInitialLocation(result.origin)
          renderer?.setRoutes(result.routes)
        }
      } catch {
        if (!disposed && routeOriginRequestID === originRequestID && routeOriginIP === originIP) {
          routeCount = 0
          routeCategoryCounts = { direct: 0, proxy: 0, relay: 0 }
          routeShapes = []
          routeTerminals = []
          renderer?.setRoutes([])
        }
      } finally {
        routesLoading = false
        renderStatus()
      }
    } while (refreshQueued && !disposed)

    refreshRunning = false
  }

  const scheduleRouteRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void refreshRoutes()
    }, REFRESH_DEBOUNCE)
  }

  /* ---------- 公网 IP ---------- */

  const loadOrigin = async (force = false) => {
    const requestID = ++originRequestID
    const currentAPI = api
    const cached = force ? null : getCachedPublicIPInfo(currentAPI)

    if (cached && isValidIP(cached.ip)) {
      originIP = cached.ip
      originAPIInfo = cached
      originStatus = 'ready'
      originRetries = 0
      renderStatus()
      scheduleRouteRefresh()
      return
    }

    originStatus = 'loading'
    originIP = ''
    originAPIInfo = null
    routeCount = 0
    renderer?.setRoutes([])
    renderStatus()

    try {
      const result = await getPublicIPInfo(currentAPI)
      if (!isValidIP(result.ip)) throw new Error('invalid origin ip')
      if (requestID !== originRequestID || currentAPI !== api) return

      originIP = result.ip
      originAPIInfo = result
      originStatus = 'ready'
      originRetries = 0
      cachePublicIPInfo(currentAPI, result)
      renderStatus()
      scheduleRouteRefresh()
    } catch {
      if (requestID !== originRequestID || currentAPI !== api) return
      originStatus = 'error'
      originIP = ''
      originAPIInfo = null
      renderStatus()

      // 代理服务可能比面板晚起来几秒，首次探测失败很常见；有限次自动重试，
      // 之后交给界面上的「重试」按钮，避免无休止地打上游。
      if (originRetries < ORIGIN_AUTO_RETRIES) {
        originRetries += 1
        if (originRetryTimer) clearTimeout(originRetryTimer)
        originRetryTimer = setTimeout(() => {
          originRetryTimer = null
          void loadOrigin(true)
        }, ORIGIN_RETRY_DELAY)
      }
    }
  }

  /* ---------- worker ---------- */

  const postWorker = (message: GeoWorkerRequest) => {
    worker?.postMessage(message)
  }

  const handleWorkerMessage = (event: MessageEvent<GeoWorkerResponse>) => {
    const data = event.data

    if (data.type === 'lookup') {
      lookupRequests.get(data.id)?.resolve(data.locations)
      lookupRequests.delete(data.id)
      return
    }

    databaseStatus = data.status
    if (data.error) databaseError = data.error
    if (data.recoveredCorruptCache) recoveredCorruptCache = true
    if (data.received != null) downloadedBytes = data.received
    if (data.total != null) downloadTotalBytes = data.total

    if (data.status === 'ready') {
      locationCache.clear()
      scheduleRouteRefresh()
    }
    if (data.status !== 'ready' && data.status !== 'downloading') {
      routeCount = 0
      renderer?.setRoutes([])
    }

    renderStatus()
  }

  /* ---------- 初始化 ---------- */

  const loadRelays = async () => {
    // 出站配置决定线路是「经代理」还是「经中转」，与「显示中转」开关无关，始终加载
    if (disposed || relayLoading) return
    relayLoading = true
    try {
      const response = await fetch(`${proxyBase}/api/mb/globe/relays`, { cache: 'no-store' })
      const data = await response.json()
      if (!response.ok || !Array.isArray(data.nodes)) throw new Error('relay configuration unavailable')
      if (disposed) return
      relayNodes = data.nodes.filter((node: RelayNode) => node && typeof node.tag === 'string' && typeof node.server === 'string')
      relayLoadFailed = false
    } catch {
      if (!disposed) { relayNodes = []; relayLoadFailed = true }
    } finally {
      relayLoading = false
      if (!disposed) { renderStatus(); scheduleRouteRefresh() }
    }
  }

  const initialize = async () => {
    if (disposed || worker) return

    proxyAvailable = await probeProxy(options.proxyBase)
    renderStatus()
    if (!proxyAvailable) return

    try {
      worker = new Worker(options.workerUrl, { type: 'module' })
    } catch (error) {
      rendererFailedMessage = t('databaseError_unsupported')
      renderStatus()
      options.onError?.(String(error))
      return
    }

    worker.addEventListener('message', handleWorkerMessage)
    postWorker({ type: 'init', dbUrl })

    const directNames = await loadDirectOutboundNames()
    startConnections((connections) => {
      latestConnections = connections
      scheduleRouteRefresh()
    }, directNames)

    void loadOrigin()
    void loadRelays()

    try {
      renderer = await createEarthRenderer(canvasHost, {
        reducedMotion: reducedMotion.matches,
        projection,
        visualMode,
        colorScheme: readColorScheme() as ThemeColorScheme,
        onEndpointHover: showTooltip,
      })
    } catch (error) {
      canvasHost.replaceChildren()
      rendererFailedMessage = t('rendererError')
      renderStatus()
      options.onError?.(String(error))
      return
    }

    if (disposed) {
      renderer.dispose()
      return
    }

    renderer.setAutoRotation(!rotationPaused)
    renderer.setCityLabelsVisible(showCityLabels)
    renderStatus()
    scheduleRouteRefresh()
  }

  const scheduleInitialization = () => {
    initTimer = setTimeout(() => {
      initTimer = null
      if (typeof requestIdleCallback === 'function') {
        initIdleHandle = requestIdleCallback(
          () => {
            initIdleHandle = null
            void initialize()
          },
          { timeout: INIT_IDLE_TIMEOUT },
        )
      } else {
        void initialize()
      }
    }, INIT_DELAY)
  }

  /* ---------- 交互 ---------- */

  const retryAll = () => {
    if (!proxyAvailable) {
      void initialize()
      return
    }
    if (databaseStatus === 'error') postWorker({ type: 'download' })
    if (originStatus === 'error') void loadOrigin(true)
    if (databaseStatus === 'ready' && originStatus === 'ready') scheduleRouteRefresh()
  }

  const setProjection = (next: EarthProjection) => {
    if (projection === next) return
    projection = next
    saveView()
    renderer?.setProjection(next)
    renderStatus()
  }

  const setExpanded = (next: boolean) => {
    expanded = next
    root.classList.toggle('ob-globe-expanded', expanded)
    renderStatus()
  }

  apiSelect.addEventListener('change', () => {
    api = apiSelect.value as IPInfoAPI
    saveView()
    originIPText.textContent = t('getting')
    void loadOrigin()
  })
  originIPToggle.addEventListener('click', () => {
    showOriginIP = !showOriginIP
    saveView()
    renderStatus()
  })
  retryButton.addEventListener('click', () => retryAll())
  projection3D.addEventListener('click', () => setProjection('3d'))
  projection2D.addEventListener('click', () => setProjection('2d'))
  styleSelect.addEventListener('change', () => {
    visualMode = styleSelect.value as EarthVisualMode
    saveView()
    renderer?.setVisualMode(visualMode)
    renderStatus()
  })
  cityLabelButton.addEventListener('click', () => {
    showCityLabels = !showCityLabels
    saveView()
    renderer?.setCityLabelsVisible(showCityLabels)
    renderStatus()
  })
  rotationButton.addEventListener('click', () => {
    rotationPaused = !rotationPaused
    saveView()
    renderer?.setAutoRotation(!rotationPaused)
    renderStatus()
  })
  expandButton.addEventListener('click', () => setExpanded(!expanded))
  relayButton.addEventListener('click', () => {
    showRelays = !showRelays
    saveView()
    void loadRelays()
    renderStatus()
    scheduleRouteRefresh()
  })
  const relayTimer = setInterval(() => void loadRelays(), 60000)
  cleanup.push(() => clearInterval(relayTimer))

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && expanded) setExpanded(false)
  }
  window.addEventListener('keydown', onKeydown)
  cleanup.push(() => window.removeEventListener('keydown', onKeydown))

  const onMotionChange = () => renderer?.setReducedMotion(reducedMotion.matches)
  reducedMotion.addEventListener('change', onMotionChange)
  cleanup.push(() => reducedMotion.removeEventListener('change', onMotionChange))

  cleanup.push(watchColorScheme((scheme) => renderer?.setColorScheme(scheme)))

  scheduleInitialization()
  renderStatus()

  // 只读诊断快照：排障时可在控制台执行 __openboxGlobe.state()，集成测试也靠它断言。
  const debugState = () => ({
    databaseStatus,
    databaseError: databaseError ?? null,
    recoveredCorruptCache,
    downloadedBytes,
    downloadTotalBytes,
    originStatus,
    originIP,
    origin: originAPIInfo
      ? {
          country: originAPIInfo.country,
          city: originAPIInfo.city,
          latitude: originAPIInfo.latitude,
          longitude: originAPIInfo.longitude,
        }
      : null,
    routeCount,
    // 直连 / 经代理 / 经中转 各有多少条线路；排障时一眼看出分类是否合理
    routeCategories: { ...routeCategoryCounts },
    routeShapes: [...routeShapes],
    routeTerminals: routeTerminals.map((terminal) => ({ ...terminal, hosts: [...terminal.hosts] })),
    unresolvedHops,
    connections: latestConnections.length,
    proxyAvailable,
    proxyBase,
    worker: Boolean(worker),
    renderer: Boolean(renderer),
    projection,
    visualMode,
  })

  const debugHost = window as unknown as { __openboxGlobe?: unknown }
  debugHost.__openboxGlobe = { element: root, state: debugState }

  return {
    element: root,
    dispose() {
      if (disposed) return
      disposed = true
      if (initTimer) clearTimeout(initTimer)
      if (originRetryTimer) clearTimeout(originRetryTimer)
      if (initIdleHandle !== null && typeof cancelIdleCallback === 'function') cancelIdleCallback(initIdleHandle)
      if (refreshTimer) clearTimeout(refreshTimer)
      stopConnections()
      renderer?.dispose()
      renderer = undefined
      if (worker) {
        worker.removeEventListener('message', handleWorkerMessage)
        worker.terminate()
        worker = null
      }
      locationCache.clear()
      dnsCache.clear()
      dnsRequests.clear()
      lookupRequests.clear()
      for (const fn of cleanup.splice(0)) {
        try {
          fn()
        } catch {
          /* ignore */
        }
      }
      if (debugHost.__openboxGlobe) delete debugHost.__openboxGlobe
      root.remove()
    },
  }
}

/** 探测代理是否可用（决定是否显示「代理服务未就绪」提示） */
export const probeProxy = async (proxyBase: string, timeout = PROXY_READY_TIMEOUT) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(`${proxyBase.replace(/\/+$/, '')}/api/mb/globe/health`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

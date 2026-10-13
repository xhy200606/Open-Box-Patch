/**
 * [Open-Box Patch] `@/assembly/connections` 的替身。
 *
 * 上游 zashboard 通过 driver 抽象同时支持 clash 与 dae；补丁只需要对接 Open-Box 面板的
 * Clash 兼容接口：
 *   · WebSocket `/api/controller-ws/connections`（首选，与面板自身一致）
 *   · HTTP     `/api/controller/connections`（WS 不可用时退化为轮询）
 *
 * 代理类型（判断「直连」）来自 `/api/controller/proxies`，与上游用 proxyMap 判 type 等价。
 */
import { getPanelBase } from './runtime'
import type { ClashConnectionRawMessage, Connection } from './types'

export interface ConnectionAccessor {
  chains(connection: Connection): string[]
  download(connection: Connection): number
  upload(connection: Connection): number
  hostname(connection: Connection): string
  destination(connection: Connection): string
  isDirect(connection: Connection): boolean
}

const asClash = (connection: Connection) => connection as ClashConnectionRawMessage

const getHostname = (c: ClashConnectionRawMessage) =>
  c.metadata.host || c.metadata.sniffHost || c.metadata.destinationIP || ''

/** 出口类型为 Direct / Reject 的内置出站名，取自 /proxies */
let directNames = new Set<string>(['DIRECT', 'REJECT', 'COMPATIBLE'])

export const setDirectOutboundNames = (names: Iterable<string>) => {
  directNames = new Set(names)
}

const getFinalProxyType = (c: ClashConnectionRawMessage) => c.chains?.[0] ?? ''

export const connectionAccessor = (): ConnectionAccessor => ({
  chains: (connection) => asClash(connection).chains ?? [],
  download: (connection) => asClash(connection).download ?? 0,
  upload: (connection) => asClash(connection).upload ?? 0,
  hostname: (connection) => getHostname(asClash(connection)),
  destination: (connection) => {
    const clash = asClash(connection)

    if (directNames.has(getFinalProxyType(clash)) && clash.metadata.remoteDestination) {
      return clash.metadata.remoteDestination
    }

    return clash.metadata.destinationIP || clash.metadata.host || ''
  },
  isDirect: (connection) => directNames.has(getFinalProxyType(asClash(connection))),
})

/* ================= 连接订阅 ================= */

export type ConnectionsListener = (connections: Connection[]) => void

let listener: ConnectionsListener | null = null
let socket: WebSocket | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let stopped = true
let previous = new Map<string, Connection>()

const publish = (connections: ClashConnectionRawMessage[]) => {
  const next = new Map<string, Connection>()

  for (const raw of connections) {
    const connection = raw as Connection
    const last = previous.get(connection.id)

    connection.downloadSpeed = last ? Math.max(0, connection.download - last.download) : 0
    connection.uploadSpeed = last ? Math.max(0, connection.upload - last.upload) : 0
    next.set(connection.id, connection)
  }

  previous = next
  listener?.([...next.values()])
}

const pollOnce = async () => {
  try {
    const response = await fetch(`${getPanelBase()}/api/controller/connections`, {
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (!response.ok) return
    const payload = (await response.json()) as { connections?: ClashConnectionRawMessage[] }
    publish(payload.connections ?? [])
  } catch {
    /* 面板重启或暂时不可达，下一轮再试 */
  }
}

const startPolling = () => {
  if (pollTimer !== null || stopped) return
  void pollOnce()
  pollTimer = setInterval(() => void pollOnce(), 3000)
}

const stopPolling = () => {
  if (pollTimer === null) return
  clearInterval(pollTimer)
  pollTimer = null
}

const scheduleRetry = () => {
  if (stopped || retryTimer !== null) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    connect()
  }, 30000)
}

const connect = () => {
  if (stopped || typeof WebSocket === 'undefined') {
    startPolling()
    return
  }

  try {
    const url = new URL(`${getPanelBase()}/api/controller-ws/connections`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(url.toString())
  } catch {
    startPolling()
    return
  }

  let opened = false

  socket.addEventListener('open', () => {
    opened = true
    stopPolling()
  })
  socket.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as { connections?: ClashConnectionRawMessage[] }
      publish(payload.connections ?? [])
    } catch {
      /* 忽略非 JSON 帧 */
    }
  })
  socket.addEventListener('close', () => {
    socket = null
    if (stopped) return
    // 握手就失败（例如面板未提供该端点）就直接轮询，不长等
    if (!opened) startPolling()
    scheduleRetry()
  })
  socket.addEventListener('error', () => {
    /* close 里统一处理 */
  })
}

export const startConnections = (onData: ConnectionsListener, outboundNames: Iterable<string>) => {
  stopConnections()
  stopped = false
  listener = onData
  previous = new Map()
  setDirectOutboundNames(outboundNames)
  connect()
}

export const stopConnections = () => {
  stopped = true
  listener = null
  previous = new Map()
  stopPolling()
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  if (socket) {
    try {
      socket.close()
    } catch {
      /* ignore */
    }
    socket = null
  }
}

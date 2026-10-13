/**
 * [Open-Box Patch] `@/types` 的最小替身。
 *
 * zashboard 里 `Connection` 是一个联合类型（clash / dae）。本补丁只对接 Open-Box 面板
 * 提供的 Clash 兼容 `/connections` 数据，因此只保留 Clash 形态。
 */

export interface ClashConnectionMetadata {
  network: string
  type: string
  sourceIP: string
  destinationIP: string
  sourcePort: string
  destinationPort: string
  host?: string
  sniffHost?: string
  remoteDestination?: string
  process?: string
  processPath?: string
  inboundUser?: string
  inboundName?: string
  inboundPort?: string
}

export interface ClashConnectionRawMessage {
  id: string
  upload: number
  download: number
  start: string
  chains: string[]
  rule: string
  rulePayload: string
  metadata: ClashConnectionMetadata
  /** 由连接订阅侧按前后两帧差分算出 */
  downloadSpeed?: number
  uploadSpeed?: number
}

export type Connection = ClashConnectionRawMessage

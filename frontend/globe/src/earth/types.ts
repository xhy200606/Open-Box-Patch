export const DBIP_CITY_URL = 'https://cdn.jsdelivr.net/npm/dbip-city-lite/dbip-city-lite.mmdb.gz'
export const DBIP_COMPRESSED_BYTES = 61_700_000
export const DBIP_STORED_BYTES = 130_200_000

/**
 * `relay` = 中转节点（链路中间的转发跳），`proxy` = 出口 / 落地节点（就是"代理"本身）。
 * 两者必须分开：只有 `relay` 才代表「经中转」，`proxy` 属于「经代理」。
 */
export type EarthEndpointRole = 'origin' | 'relay' | 'proxy' | 'destination'

/** 线路类别：直连 / 经代理（单跳）/ 经中转（多跳，经中转再代理） */
export type EarthRouteCategory = 'direct' | 'proxy' | 'relay'

export interface EarthLocation {
  ip: string
  latitude: number
  longitude: number
  city: string
  country: string
}

export interface EarthSample {
  latitude: number
  longitude: number
  altitude: number
}

export interface EarthLocationHint {
  latitude: number | null
  longitude: number | null
  city: string
  country: string
}

export interface EarthHostTraffic {
  host: string
  downloaded: number
}

export interface EarthRoute {
  key: string
  path: Array<EarthLocation & { role: EarthEndpointRole }>
  /** 直连 / 经代理 / 经中转。由链路解析结果决定，与中间点是否画得出来无关 */
  category: EarthRouteCategory
  connections: number
  upload: number
  download: number
  topHosts: EarthHostTraffic[]
}

export interface EarthEndpointInfo {
  city: string
  country: string
  role: EarthEndpointRole
  /** 该端点所属线路的类别；`origin` 端点会合并所有类别，取数值最大的一类 */
  category: EarthRouteCategory
  connections: number
  topHosts: EarthHostTraffic[]
}

export type GeoDatabaseStatus =
  'checking' | 'idle' | 'loading-cache' | 'downloading' | 'ready' | 'error'

export type GeoDatabaseError =
  'space' | 'network' | 'decompress' | 'invalid' | 'storage' | 'unsupported' | 'unknown'

export type GeoWorkerRequest =
  // [Open-Box Patch] init 可携带数据库地址：默认由服务器代理镜像到本机，避免每台设备都出网拉取
  | { type: 'init'; dbUrl?: string }
  | { type: 'download' }
  | { type: 'cancel' }
  | { type: 'lookup'; id: number; ips: string[]; locale: string }

export type GeoWorkerResponse =
  | {
      type: 'status'
      status: GeoDatabaseStatus
      received?: number
      total?: number
      error?: GeoDatabaseError
      recoveredCorruptCache?: boolean
    }
  | { type: 'lookup'; id: number; locations: Record<string, EarthLocation | null> }

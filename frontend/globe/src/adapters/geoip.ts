/**
 * [Open-Box Patch] 公网 IP 归属 + 连接域名解析。
 *
 * 与上游 zashboard 的差别：
 *   · 上游浏览器直连 ip.sb / ipwho.is / ipapi.is（受 CORS 与网络可达性制约）；
 *     补丁改为调用本机服务端代理，由代理出网并缓存结果，浏览器侧无跨域问题。
 *   · 域名解析沿用面板自身的 Clash 兼容接口 `/api/controller/dns/query`（同源）。
 */
import * as ipaddr from 'ipaddr.js'
import { getPanelBase, getProxyBase } from './runtime'

export const IP_INFO_API = {
  IPSB: 'ip.sb',
  IPWHOIS: 'ipwho.is',
  IPAPI: 'ipapi.is',
  IPIP: 'ipip.net',
} as const

export type IPInfoAPI = (typeof IP_INFO_API)[keyof typeof IP_INFO_API]

export const IP_INFO_API_OPTIONS: IPInfoAPI[] = [
  IP_INFO_API.IPSB,
  IP_INFO_API.IPWHOIS,
  IP_INFO_API.IPAPI,
  IP_INFO_API.IPIP,
]

export interface IPInfo {
  ip: string
  country: string
  region: string
  city: string
  asn: string
  organization: string
  latitude: number | null
  longitude: number | null
}

const coordinate = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

export const getPublicIPInfo = async (api: IPInfoAPI): Promise<IPInfo> => {
  const response = await fetch(
    `${getProxyBase()}/api/mb/globe/public-ip?api=${encodeURIComponent(api)}`,
    { cache: 'no-store' },
  )

  if (!response.ok) throw new Error(`public IP lookup failed: ${response.status}`)

  const data = (await response.json()) as Partial<IPInfo> & { ip?: string }

  if (!data || typeof data.ip !== 'string' || !ipaddr.isValid(data.ip)) {
    throw new Error('public IP lookup returned an invalid address')
  }

  return {
    ip: data.ip,
    country: data.country ?? '',
    region: data.region ?? '',
    city: data.city ?? '',
    asn: data.asn ?? '',
    organization: data.organization ?? '',
    latitude: coordinate(data.latitude),
    longitude: coordinate(data.longitude),
  }
}

let cachedPublicIP: { api: IPInfoAPI; info: IPInfo } | null = null

export const cachePublicIPInfo = (api: IPInfoAPI, info: IPInfo) => {
  cachedPublicIP = { api, info }
}

export const getCachedPublicIPInfo = (api: IPInfoAPI) =>
  cachedPublicIP?.api === api ? cachedPublicIP.info : null

/* ================= 连接域名解析 ================= */

const ANSWER_TYPE = { A: 1, AAAA: 28 } as const

export const queryDNS = async (name: string, type: 'A' | 'AAAA') => {
  const url = `${getPanelBase()}/api/controller/dns/query?name=${encodeURIComponent(name)}&type=${type}`
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new Error(`dns query failed: ${response.status}`)

  return (await response.json()) as { Answer?: Array<{ type: number; data: string; TTL: number }> }
}

export const dnsAnswerType = ANSWER_TYPE

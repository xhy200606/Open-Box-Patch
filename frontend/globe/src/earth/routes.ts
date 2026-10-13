import { connectionAccessor } from '@/assembly/connections'
import type { Connection } from '@/types'
import * as ipaddr from 'ipaddr.js'
import type { EarthHostTraffic, EarthLocation, EarthLocationHint, EarthRoute, EarthRouteCategory } from './types'
import { EMPTY_HOPS, resolveOutboundHops, type RelayNode } from './relays'

type LocatedCoordinates = { latitude: number; longitude: number }

interface RouteCandidate {
  destinationIP: string | null
  resolutionHost: string
  upload: number
  download: number
  host: string
  downloaded: number
  category: EarthRouteCategory
  /** 中转节点（可能多个），按「入口 → 出口」排列 */
  transit: string[]
  /** 出口 / 落地节点 —— 「经代理」里的那个代理 */
  exit: string
  incompleteHops: boolean
}

const normalizeIP = (value: string) => {
  try {
    return ipaddr.parse(value).toNormalizedString()
  } catch {
    return null
  }
}

const destinationIP = (rawValue: string) => {
  const value = rawValue.trim()

  if (!value) return null

  const bareIP = normalizeIP(value)

  if (bareIP) return bareIP

  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']')

    if (closingBracket > 1) return normalizeIP(value.slice(1, closingBracket))
  }

  const lastColon = value.lastIndexOf(':')

  if (lastColon > 0 && /^\d+$/.test(value.slice(lastColon + 1))) {
    return normalizeIP(value.slice(0, lastColon))
  }

  return null
}

const extractCandidates = (connections: readonly Connection[], relayOptions?: { show: boolean; nodes: readonly RelayNode[] }): RouteCandidate[] => {
  const accessor = connectionAccessor()
  const candidates: RouteCandidate[] = []

  for (const connection of connections) {
    const destination = destinationIP(accessor.destination(connection))
    const rawHost = accessor.hostname(connection).trim().replace(/\.$/, '')

    if (!destination && !rawHost) continue

    const direct = accessor.isDirect(connection)
    // 类别是流量自身的属性，与「显示转发」开关无关：开关只决定要不要把中间节点画出来。
    // 即使关闭开关，也要按实际出站配置判定它究竟是「经代理」还是「经中转」，否则两类又混在一起。
    const hops = relayOptions && !direct ? resolveOutboundHops(accessor.chains(connection), relayOptions.nodes) : EMPTY_HOPS
    // 类别只看链路解析结果：有中转跳才是「经中转」，否则单跳就是「经代理」。
    // 不能等路径画出来再反推 —— 中转节点查不到归属地时会退化成「经代理」，两类就混了。
    const category: EarthRouteCategory = direct ? 'direct' : hops.transit.length > 0 ? 'relay' : 'proxy'
    candidates.push({
      destinationIP: destination,
      resolutionHost: rawHost.toLowerCase(),
      upload: Math.max(0, connection.uploadSpeed),
      download: Math.max(0, connection.downloadSpeed),
      host: rawHost || destination || '',
      downloaded: Math.max(0, accessor.download(connection)),
      category,
      transit: hops.transit,
      exit: hops.exit,
      incompleteHops: hops.incomplete,
    })
  }

  return candidates
}

const coordinateKey = ({ latitude, longitude }: EarthLocation) =>
  `${latitude.toFixed(4)},${longitude.toFixed(4)}`

const mergeTopHosts = (...groups: EarthHostTraffic[][]) =>
  groups
    .flat()
    .sort((left, right) => right.downloaded - left.downloaded)
    .slice(0, 5)

const hasValidCoordinates = (
  location: Pick<EarthLocationHint, 'latitude' | 'longitude'> | EarthLocation | null,
): location is (EarthLocationHint | EarthLocation) & LocatedCoordinates =>
  location !== null &&
  location.latitude !== null &&
  location.longitude !== null &&
  Number.isFinite(location.latitude) &&
  Number.isFinite(location.longitude) &&
  location.latitude >= -90 &&
  location.latitude <= 90 &&
  location.longitude >= -180 &&
  location.longitude <= 180

const resolveOrigin = (
  ip: string,
  local: EarthLocation | null | undefined,
  preferred?: EarthLocationHint | null,
): EarthLocation | null => {
  let latitude: number
  let longitude: number

  if (preferred && hasValidCoordinates(preferred)) {
    latitude = preferred.latitude
    longitude = preferred.longitude
  } else if (local && hasValidCoordinates(local)) {
    latitude = local.latitude
    longitude = local.longitude
  } else {
    return null
  }

  return {
    ip,
    latitude,
    longitude,
    city: preferred?.city.trim() || local?.city || '',
    country: local?.country || preferred?.country.trim() || '',
  }
}

export const buildEarthRoutes = async (
  connections: readonly Connection[],
  originIP: string,
  locale: string,
  lookup: (ips: string[], locale: string) => Promise<Record<string, EarthLocation | null>>,
  preferredOrigin?: EarthLocationHint | null,
  resolveDestinationIPs?: (hostnames: string[]) => Promise<Record<string, string | null>>,
  /**
   * `nodes` 用于判定「经代理 / 经中转」并要求始终提供（决定线路类别）；
   * `show` 只决定是否把中转与出口节点画到地图上。
   */
  relayOptions?: { show: boolean; nodes: readonly RelayNode[] },
) => {
  const normalizedOrigin = normalizeIP(originIP)

  if (!normalizedOrigin) return { routes: [] as EarthRoute[], origin: null, unresolvedHops: 0 }

  const candidates = extractCandidates(connections, relayOptions)
  const hopServers = candidates.flatMap((candidate) => [...candidate.transit, candidate.exit])
  const unresolvedHosts = [
    ...new Set([
      ...candidates
        .filter((candidate) => !candidate.destinationIP)
        .map((candidate) => candidate.resolutionHost),
      ...hopServers.filter((server) => server && !normalizeIP(server)),
    ]),
  ]
  const resolvedIPs =
    resolveDestinationIPs && unresolvedHosts.length > 0
      ? await resolveDestinationIPs(unresolvedHosts)
      : {}

  for (const candidate of candidates) {
    if (!candidate.destinationIP) {
      candidate.destinationIP = normalizeIP(resolvedIPs[candidate.resolutionHost] ?? '')
    }
  }

  const resolvedCandidates = candidates.filter(
    (candidate): candidate is RouteCandidate & { destinationIP: string } =>
      candidate.destinationIP !== null,
  )
  const ips = new Set<string>([normalizedOrigin])

  for (const candidate of resolvedCandidates) ips.add(candidate.destinationIP)
  for (const candidate of resolvedCandidates) for (const server of [...candidate.transit, candidate.exit]) {
    const ip = normalizeIP(server) || normalizeIP(resolvedIPs[server] || '')
    if (ip) ips.add(ip)
  }

  const locations = await lookup([...ips], locale)
  const origin = resolveOrigin(normalizedOrigin, locations[normalizedOrigin], preferredOrigin)

  if (!origin) return { routes: [] as EarthRoute[], origin: null, unresolvedHops: 0 }

  const aggregated = new Map<string, EarthRoute>()
  let unresolvedHops = 0

  for (const candidate of resolvedCandidates) {
    const destination = locations[candidate.destinationIP]

    if (!destination) continue

    const path: EarthRoute['path'] = [{ ...origin, role: 'origin' }]

    /**
     * 把物理跳点接到本机与目的地之间（仅「显示转发」开启时画）。
     * 中转节点用 `relay`（紫），出口 / 落地节点用 `proxy`（青，与「经代理」同色）——
     * 两者绝不能都叫「中转」，否则「经中转再代理」与「本机经代理」就分不出来了。
     */
    const pushHop = (server: string, role: 'relay' | 'proxy') => {
      const ip = normalizeIP(server) || normalizeIP(resolvedIPs[server] || '')
      if (!ip) { unresolvedHops++; return }
      if (ip === normalizedOrigin || ip === candidate.destinationIP) return
      if (path.some(point => point.ip === ip)) return
      const location = locations[ip]
      if (!location) { unresolvedHops++; return }
      path.push({ ...location, role })
    }

    if (relayOptions?.show) {
      if (candidate.incompleteHops) unresolvedHops++
      for (const server of candidate.transit) pushHop(server, 'relay')
      // 出口节点只在「经中转」时画：单跳的代理节点不是"转发"
      if (candidate.category === 'relay') pushHop(candidate.exit, 'proxy')
    }

    path.push({ ...destination, role: 'destination' })

    const key = path.map((point) => `${point.role}:${point.ip}:${coordinateKey(point)}`).join('>') + `:${candidate.category}`
    const existing = aggregated.get(key)

    if (existing) {
      existing.connections += 1
      existing.upload += candidate.upload
      existing.download += candidate.download
      existing.topHosts = mergeTopHosts(
        existing.topHosts,
        candidate.host ? [{ host: candidate.host, downloaded: candidate.downloaded }] : [],
      )
    } else {
      aggregated.set(key, {
        key,
        path,
        category: candidate.category,
        connections: 1,
        upload: candidate.upload,
        download: candidate.download,
        topHosts: candidate.host
          ? [{ host: candidate.host, downloaded: candidate.downloaded }]
          : [],
      })
    }
  }

  return { routes: [...aggregated.values()], origin, unresolvedHops }
}

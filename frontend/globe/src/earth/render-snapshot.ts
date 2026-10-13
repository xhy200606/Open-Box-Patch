import * as THREE from 'three/webgpu'
import type { EarthRenderEndpoint, EarthRenderSnapshot } from './renderer-types'
import type { EarthHostTraffic, EarthRoute } from './types'

const mergeTopHosts = (...groups: readonly EarthHostTraffic[][]) =>
  groups
    .flat()
    .sort((left, right) => right.downloaded - left.downloaded)
    .slice(0, 5)

const cloneRoute = (route: EarthRoute): EarthRoute => ({
  ...route,
  path: route.path.map((point) => ({ ...point })),
  topHosts: route.topHosts.map((host) => ({ ...host })),
})

export const createEarthRenderSnapshot = (incomingRoutes: readonly EarthRoute[]) => {
  const routes = incomingRoutes
    .map(cloneRoute)
    .sort((left, right) => left.key.localeCompare(right.key))
  const signature = routes
    .map(({ category, key }) => `${key}:${category}`)
    .sort()
    .join('|')
  const endpoints = new Map<string, EarthRenderEndpoint>()

  for (const route of routes) {
    const terminalIndex = route.path.length - 1

    route.path.forEach((point, index) => {
      /**
       * 端点身份 = 类别 + 角色 + 坐标。
       *
       * 同一坐标既是某条线路的中转跳点、又是另一条线路的目的地，是很常见的（本机也会
       * 直连该节点，例如订阅更新 / 探测）。早期版本只用「角色 + 坐标」当身份，
       * 这种重合会被合并成一条记录、后一条覆盖前一条的颜色与悬浮信息 —— 也就是
       * 「经中转」和「经代理」在同一个点上打架。加上类别后各画各的，互不覆盖。
       *
       * 本机（origin）不分类别：它永远是一个白点，连接数按全部线路累加。
       */
      const location = `${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`
      const key = point.role === 'origin' ? `origin:${location}` : `${route.category}:${point.role}:${location}`
      // 下载量 Top5 挂在**线路终点**上：直连是目的地，经代理 / 经中转是落地节点 ——
      // 于是「这个出口跑过哪些域名」在地图上直接悬停就能看到。
      const terminal = index === terminalIndex
      const existing = endpoints.get(key)

      if (existing) {
        existing.connections += route.connections
        if (terminal) {
          existing.topHosts = mergeTopHosts(existing.topHosts, route.topHosts)
        }
      } else {
        endpoints.set(key, {
          key,
          category: route.category,
          city: point.city,
          country: point.country,
          role: point.role,
          connections: route.connections,
          topHosts: terminal ? [...route.topHosts] : [],
          latitude: point.latitude,
          longitude: point.longitude,
          position: new THREE.Vector3(),
        })
      }
    })
  }

  return {
    signature,
    routes,
    endpoints: [...endpoints.values()],
  } satisfies EarthRenderSnapshot
}

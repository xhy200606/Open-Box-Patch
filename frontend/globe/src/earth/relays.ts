export interface RelayNode {
  tag: string
  server: string
  detour?: string
  outbounds?: string[]
}

export interface OutboundHops {
  /** 中转节点（前置 / 中间跳）的服务器地址，按「入口 → 出口」排列；没有中转时为空数组 */
  transit: string[]
  /** 出口（落地）节点的服务器地址；无法判断时为空串 */
  exit: string
  /** 链路里存在无法识别或不唯一的环节，路径可能不完整 */
  incomplete: boolean
}

export const EMPTY_HOPS: OutboundHops = { transit: [], exit: '', incomplete: false }

/**
 * 把连接的 `chains` 映射回 sing-box 出站配置，得到**物理出站链路**。
 *
 * 这里必须分清两件事 —— 早期版本把两者混为一谈，于是「本机经代理」也被画成了
 * 「经中转」的紫色线路（任何代理节点都有 server，都会被当成中转跳点）：
 *
 *   · `chains` 里**带 server 的 tag 才是物理节点**；策略组 / 选择器没有 server，
 *     不是跳点，不能臆造成中转。
 *   · 物理链路的**最后一个**是出口（落地）节点 —— 它就是「经代理」里的那个代理；
 *     排在它**前面**的才是「中转」节点。
 *   · 物理节点只有一个时**没有中转**：那是「本机经代理」；两个及以上才是
 *     「经中转再代理」。
 *
 * `detour` 的语义是"连这个节点的服务器要先走谁"，所以递归 detour 得到的是前置节点，
 * 顺序自然成为 入口 → 出口。
 */
export function resolveOutboundHops(chains: readonly string[], nodes: readonly RelayNode[]): OutboundHops {
  const byName = new Map(nodes.map((node) => [node.tag, node]))
  const terminal = chains.find((name) => byName.get(name)?.server)

  if (!terminal) return { transit: [], exit: '', incomplete: true }

  const visited = new Set<string>()
  const servers: string[] = []
  let incomplete = false

  const visit = (name: string) => {
    if (visited.has(name) || visited.size >= 16) {
      incomplete = true
      return
    }

    visited.add(name)
    const node = byName.get(name)

    if (!node) {
      incomplete = true
      return
    }

    // 策略组 / 选择器不是物理跳点：只有唯一成员时才继续下钻，否则宁可不画
    if (!node.server && node.outbounds?.length) {
      const group = node.outbounds
      const members = chains.filter((tag) => tag !== name && !visited.has(tag) && group.includes(tag))
      if (members.length === 1) visit(members[0])
      else incomplete = true
      return
    }

    if (node.detour) visit(node.detour)
    if (node.server && !servers.includes(node.server)) servers.push(node.server)
  }

  visit(terminal)

  const exit = servers.length > 0 ? servers[servers.length - 1] : ''
  return { transit: servers.slice(0, -1), exit, incomplete }
}

export interface RelayNode { tag: string; server: string; detour?: string; outbounds?: string[] }

// Policy groups are not physical hops. Only actual server addresses are shown.
export function resolveConnectionRelays(chains: readonly string[], nodes: readonly RelayNode[]) {
  const byName = new Map(nodes.map(node => [node.tag, node]))
  const terminal = chains.find(name => byName.get(name)?.server)
  if (!terminal) return { servers: [] as string[], incomplete: true }
  const visited = new Set<string>()
  const servers: string[] = []
  let incomplete = false
  const visit = (name: string) => {
    if (visited.has(name) || visited.size >= 16) { incomplete = true; return }
    visited.add(name)
    const node = byName.get(name)
    if (!node) { incomplete = true; return }
    if (!node.server && node.outbounds?.length) {
      const members = chains.filter(tag => tag !== name && !visited.has(tag) && node.outbounds!.includes(tag))
      if (members.length === 1) visit(members[0])
      else incomplete = true
      return
    }
    if (node.detour) visit(node.detour)
    if (node.server && !servers.includes(node.server)) servers.push(node.server)
  }
  visit(terminal)
  return { servers, incomplete }
}

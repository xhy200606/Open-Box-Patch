// Return only the information required to draw the path, never node passwords,
// subscription contents, client keys, or other fields in the export.
export function relayNodesFromConfig(payload) {
  const config = payload?.config || {}
  const nodes = [...(Array.isArray(config.outbounds) ? config.outbounds : []), ...(Array.isArray(config.endpoints) ? config.endpoints : []),
    ...(Array.isArray(payload?.source?.nodes) ? payload.source.nodes : [])]
  const seen = new Set()
  return nodes.flatMap(node => {
    if (!node || typeof node.tag !== 'string' || seen.has(node.tag)) return []
    seen.add(node.tag)
    const server = typeof node.server === 'string' ? node.server.trim() : ''
    return [{ tag: node.tag, server, detour: typeof node.detour === 'string' ? node.detour : '',
      outbounds: Array.isArray(node.outbounds) ? node.outbounds.filter(value => typeof value === 'string') : [] }]
  })
}

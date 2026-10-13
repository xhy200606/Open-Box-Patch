import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const globe = fileURLToPath(new URL('../frontend/globe/', import.meta.url))
const { build } = createRequire(path.join(globe, 'package.json'))('esbuild')
const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-globe-test-'))
const compiled = path.join(stage, 'routes.mjs')
await build({ stdin: { contents: [
  `export * from ${JSON.stringify(path.join(globe, 'src/preferences.ts'))}`,
  `export * from ${JSON.stringify(path.join(globe, 'src/earth/relays.ts'))}`,
  `export * from ${JSON.stringify(path.join(globe, 'src/earth/routes.ts'))}`,
].join('\n'), resolveDir: globe }, outfile: compiled, bundle: true, platform: 'node', format: 'esm',
  alias: { '@/assembly/connections': path.join(globe, 'src/adapters/connections.ts') } })
const { loadGlobePreferences, saveGlobePreferences, buildEarthRoutes, resolveOutboundHops } = await import(pathToFileURL(compiled))
test.after(() => fs.rm(stage, { recursive: true, force: true }))

test('2D and display preferences survive a new mount and tolerate unavailable storage', () => {
  const data = new Map()
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) }
  const prefs = { projection: '2d', visualMode: 'flat', showCityLabels: false, rotationPaused: true, showRelays: false, api: 'ipwho.is', showOriginIP: true }
  saveGlobePreferences(prefs, storage)
  assert.deepEqual(loadGlobePreferences(storage), prefs)
  assert.equal(loadGlobePreferences({ getItem: () => '{invalid' }).projection, '3d')
  assert.equal(loadGlobePreferences({ getItem: () => { throw Error('denied') } }).showRelays, true)
  assert.doesNotThrow(() => saveGlobePreferences(prefs, { setItem: () => { throw Error('full') } }))
})

const nodes = [
  { tag: 'Shanghai', server: '106.14.83.154' },
  { tag: 'Exit', server: 'exit.example', detour: 'Shanghai' },
  { tag: 'Tokyo', server: '203.0.113.7' },
  { tag: 'Policy', server: '', outbounds: ['Exit'] },
]
const connection = (chains, destination = '8.8.8.8', host = 'google.example') => ({ id: 'one',
  metadata: { destinationIP: destination, host }, chains, upload: 10, download: 20, uploadSpeed: 1, downloadSpeed: 2 })
const lookup = async ips => Object.fromEntries(ips.map((ip, index) => [ip, { ip, latitude: index * 10, longitude: index * 20, city: ip, country: 'Test' }]))
const resolve = async names => Object.fromEntries(names.map(name => [name, '203.0.113.10']))
const routesOf = (connections, relayOptions) => buildEarthRoutes(connections, '9.9.9.9', 'zh', lookup, null, resolve, relayOptions)
const rolesOf = route => route.path.map(point => point.role)
const ipsOf = route => route.path.map(point => point.ip)

test('the exit node is told apart from the relay hops in front of it', () => {
  // 经中转再代理：detour 是前置（中转），排在出口（落地）之前
  assert.deepEqual(resolveOutboundHops(['Exit', 'Policy'], nodes),
    { transit: ['106.14.83.154'], exit: 'exit.example', incomplete: false })
  // 单跳：只有一个物理节点，它就是出口（代理），没有中转
  assert.deepEqual(resolveOutboundHops(['Tokyo'], nodes), { transit: [], exit: '203.0.113.7', incomplete: false })
  // 只给了策略组，无法判断物理跳点
  assert.equal(resolveOutboundHops(['Policy'], nodes).incomplete, true)
  assert.equal(resolveOutboundHops(['Policy'], nodes).exit, '')
  const cyclic = [{ tag: 'a', server: '1.1.1.1', detour: 'b' }, { tag: 'b', server: '2.2.2.2', detour: 'a' }]
  assert.equal(resolveOutboundHops(['a'], cyclic).incomplete, true)
})

test('a single-hop proxy is "via proxy"; only a detour chain is "via relay"', async () => {
  const single = await routesOf([connection(['Tokyo'])], { show: true, nodes })
  assert.equal(single.routes.length, 1)
  assert.equal(single.routes[0].category, 'proxy')
  // 单跳：本机 → 代理节点（落地）
  assert.deepEqual(rolesOf(single.routes[0]), ['origin', 'proxy'])
  assert.deepEqual(ipsOf(single.routes[0]), ['9.9.9.9', '203.0.113.7'])

  const relayed = await routesOf([connection(['Exit', 'Policy'])], { show: true, nodes })
  assert.equal(relayed.routes[0].category, 'relay')
  // 多跳：本机 → 中转 → 落地
  assert.deepEqual(rolesOf(relayed.routes[0]), ['origin', 'relay', 'proxy'])
  assert.deepEqual(ipsOf(relayed.routes[0]), ['9.9.9.9', '106.14.83.154', '203.0.113.10'])
})

test('proxy routes stop at the landing node instead of drawing the final destination', async () => {
  const single = await routesOf([connection(['Tokyo'])], { show: true, nodes })
  const relayed = await routesOf([connection(['Exit', 'Policy'])], { show: true, nodes })

  // 关键：经代理 / 经中转都不画最终目的地，线路终点就是最后一个代理节点
  assert.equal(rolesOf(single.routes[0]).includes('destination'), false)
  assert.equal(rolesOf(relayed.routes[0]).includes('destination'), false)
  assert.equal(relayed.routes[0].path.at(-1).role, 'proxy')

  // 直连仍然一路画到目的地
  const direct = await routesOf([connection(['DIRECT'])], { show: true, nodes })
  assert.deepEqual(rolesOf(direct.routes[0]), ['origin', 'destination'])
  assert.deepEqual(ipsOf(direct.routes[0]), ['9.9.9.9', '8.8.8.8'])
})

test('connections sharing one proxy chain merge into one line, destinations kept as top hosts', async () => {
  const merged = await routesOf([
    connection(['Tokyo'], '8.8.8.8', 'a.example'),
    connection(['Tokyo'], '1.1.1.1', 'b.example'),
  ], { show: true, nodes })

  // 不再画目的地后，同一代理下的多个目标自然合并成一条线
  assert.equal(merged.routes.length, 1)
  assert.deepEqual(rolesOf(merged.routes[0]), ['origin', 'proxy'])
  assert.equal(merged.routes[0].connections, 2)
  assert.deepEqual(merged.routes[0].topHosts.map(host => host.host).sort(), ['a.example', 'b.example'])
})

test('direct, single-hop and relayed traffic to one destination never merge into a single route', async () => {
  const mixed = await routesOf([connection(['DIRECT']), connection(['Tokyo']), connection(['Exit', 'Policy'])], { show: true, nodes })
  assert.equal(mixed.routes.length, 3)
  assert.deepEqual(mixed.routes.map(route => route.category).sort(), ['direct', 'proxy', 'relay'])
  assert.equal(new Set(mixed.routes.map(route => route.key)).size, 3)
  assert.equal(mixed.routes.find(route => route.category === 'direct').path.length, 2)
})

test('a relayed route keeps its category when a relay hop cannot be located', async () => {
  const lookupMissingTransit = async ips => Object.fromEntries(ips.map((ip, index) => [
    ip, ip === '106.14.83.154' ? null : { ip, latitude: index * 10, longitude: index * 20, city: ip, country: 'Test' },
  ]))
  const partial = await buildEarthRoutes([connection(['Exit', 'Policy'])], '9.9.9.9', 'zh', lookupMissingTransit, null, resolve,
    { show: true, nodes })
  // 少画了一个跳点，但它仍然是「经中转」，不能退化成「经代理」
  assert.equal(partial.routes[0].category, 'relay')
  assert(partial.unresolvedHops > 0)
  assert.deepEqual(rolesOf(partial.routes[0]), ['origin', 'proxy'])
})

test('turning relays off hides the transit nodes but keeps the landing node and the class', async () => {
  const hidden = await routesOf([connection(['Exit', 'Policy'])], { show: false, nodes })
  assert.equal(hidden.routes[0].category, 'relay')
  // 收起中转节点，但仍然画到落地节点（终点不会消失）
  assert.deepEqual(rolesOf(hidden.routes[0]), ['origin', 'proxy'])
  assert.equal(hidden.unresolvedHops, 0)
})

test('a proxy route falls back to the destination only when no hop can be located', async () => {
  // 出站配置取不到：链路解析不出来，此时才退化为画目的地，避免整条线消失
  const withoutConfig = await routesOf([connection(['Exit', 'Policy'])], { show: true, nodes: [] })
  assert.equal(withoutConfig.routes[0].category, 'proxy')
  assert.deepEqual(rolesOf(withoutConfig.routes[0]), ['origin', 'destination'])
})

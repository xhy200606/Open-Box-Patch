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
const { loadGlobePreferences, saveGlobePreferences, buildEarthRoutes, resolveConnectionRelays } = await import(pathToFileURL(compiled))
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
  { tag: 'Policy', server: '', outbounds: ['Exit'] },
]
const connection = (chains, destination = '8.8.8.8') => ({ id: 'one', metadata: { destinationIP: destination, host: 'google.example' },
  chains, upload: 10, download: 20, uploadSpeed: 1, downloadSpeed: 2 })
const lookup = async ips => Object.fromEntries(ips.map((ip, index) => [ip, { ip, latitude: index * 10, longitude: index * 20, city: ip, country: 'Test' }]))
const resolve = async names => Object.fromEntries(names.map(name => [name, '203.0.113.10']))

test('real detours are ordered from entry to exit; policy groups and cycles are not invented as hops', () => {
  assert.deepEqual(resolveConnectionRelays(['Exit', 'Policy'], nodes).servers, ['106.14.83.154', 'exit.example'])
  assert.equal(resolveConnectionRelays(['Policy'], nodes).servers.length, 0)
  const cyclic = [{ tag: 'a', server: '1.1.1.1', detour: 'b' }, { tag: 'b', server: '2.2.2.2', detour: 'a' }]
  assert.equal(resolveConnectionRelays(['a'], cyclic).incomplete, true)
})

test('relay toggle changes topology, direct routes stay direct, and unresolved nodes are reported', async () => {
  const enabled = await buildEarthRoutes([connection(['Exit', 'Policy'])], '9.9.9.9', 'zh', lookup, null, resolve, { show: true, nodes })
  assert.deepEqual(enabled.routes[0].path.map(point => point.role), ['origin', 'relay', 'relay', 'destination'])
  assert.deepEqual(enabled.routes[0].path.map(point => point.ip), ['9.9.9.9', '106.14.83.154', '203.0.113.10', '8.8.8.8'])
  assert.equal(enabled.routes[0].viaRelay, true)
  const disabled = await buildEarthRoutes([connection(['Exit'])], '9.9.9.9', 'zh', lookup, null, resolve, { show: false, nodes })
  assert.deepEqual(disabled.routes[0].path.map(point => point.role), ['origin', 'destination'])
  const direct = await buildEarthRoutes([connection(['DIRECT'])], '9.9.9.9', 'zh', lookup, null, resolve, { show: true, nodes })
  assert.equal(direct.routes[0].direct, true)
  assert.equal(direct.routes[0].path.length, 2)
  const missing = await buildEarthRoutes([connection(['Unknown', 'Policy'])], '9.9.9.9', 'zh', lookup, null, resolve, { show: true, nodes })
  assert(missing.unresolvedRelays > 0)
  assert.equal(missing.routes[0].path.length, 2)
})

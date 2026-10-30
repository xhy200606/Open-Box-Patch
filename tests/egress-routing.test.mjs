import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRoutingPlan, routingSettings, createRoutingManager, EGRESS_MARKS } from '../backend/egress-routing.mjs'
const clone = value => structuredClone(value)
const s = { enabled: true, proxyInterface: 'eth1', directInterface: 'eth2', routing: { automatic: true } }
function inventory() {
  return {
    links: [
      { ifname: 'br-lan', flags: ['UP'], operstate: 'UP', addr_info: [{ family: 'inet', local: '192.168.1.1', prefixlen: 24, scope: 'global' }] },
      { ifname: 'eth1', flags: ['UP'], operstate: 'UP', addr_info: [{ family: 'inet', local: '10.0.1.2', prefixlen: 24, scope: 'global' }, { family: 'inet6', local: '2001:db8:1::2', prefixlen: 64, scope: 'global' }] },
      { ifname: 'eth2', flags: ['UP'], operstate: 'UP', addr_info: [{ family: 'inet', local: '10.0.2.2', prefixlen: 24, scope: 'global' }] },
    ],
    routes: {
      4: [{ dst: 'default', gateway: '10.0.1.1', dev: 'eth1' }, { dst: '10.0.1.0/24', dev: 'eth1', scope: 'link' }, { dst: '10.0.2.0/24', dev: 'eth2', scope: 'link' }, { dst: '192.168.1.0/24', dev: 'br-lan', scope: 'link' }, { dst: '192.168.100.0/24', dev: 'tun0' }],
      6: [{ dst: 'default', dev: 'eth1', gateway: 'fe80::1', from: '2001:db8:1::/64' }, { dst: '2001:db8:1::/64', dev: 'eth1' }, { dst: 'fe80::/64', dev: 'eth1' }],
    },
    rules: { 4: [{ priority: 0, table: 'local' }, { priority: 32766, table: 'main' }], 6: [{ priority: 0, table: 'local' }, { priority: 32766, table: 'main' }] },
    networks: [{ interface: 'lan', up: true, l3_device: 'br-lan' }, { interface: 'wan', up: true, l3_device: 'eth1' }, { interface: 'wan2', up: true, l3_device: 'eth2', route: [{ target: '0.0.0.0', mask: 0, nexthop: '10.0.2.1' }] }],
  }
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-routing-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const proc = path.join(root, 'proc')
  for (const [dev, value] of [['eth1', '0'], ['eth2', '1'], ['br-lan', '0']]) {
    const file = path.join(proc, 'sys/net/ipv4/conf', dev, 'rp_filter')
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value)
  }
  const live = inventory(), calls = []
  let fail = null, bypassTable = false
  async function run(bin, args) {
    calls.push([bin, ...args])
    if (bin === 'ubus') return JSON.stringify({ interface: live.networks })
    if (fail && fail(args)) { fail = null; throw Error('injected ip failure') }
    const a = [...args], json = a[0] === '-j'; if (json) a.shift()
    if (a[0] === 'address') return JSON.stringify(live.links)
    const family = Number(a.shift().slice(1)), kind = a.shift(), action = a.shift()
    const value = key => a[a.indexOf(key) + 1]
    if (json) {
      if (kind === 'rule') return JSON.stringify(live.rules[family])
      if (action === 'get') {
        const dev = value('oif'), rule = live.rules[family].find(r => r.oif === dev && (!r.fwmark || Number(r.fwmark) === Number(value('mark'))))
        const route = live.routes[family].find(r => r.table === rule?.table && r.dst === 'default' && r.dev === dev)
        if (!route) throw Error('Network is unreachable')
        return JSON.stringify([{ dev, gateway: route.gateway, table: bypassTable ? 555 : rule.table }])
      }
      return JSON.stringify(live.routes[family])
    }
    if (kind === 'route') {
      const table = Number(value('table')), protocol = Number(value('protocol'))
      if (action === 'flush') { live.routes[family] = live.routes[family].filter(r => r.table !== table || r.protocol !== protocol); return '' }
      const type = a[0] === 'unreachable' ? a.shift() : undefined
      let dst = a[0]; dst = dst.replace(family === 4 ? /\/32$/ : /\/128$/, '')
      live.routes[family].push({ dst, table, protocol, ...(type ? { type, dev: 'lo' } : {}), ...(a.includes('dev') ? { dev: value('dev') } : {}), ...(a.includes('via') ? { gateway: value('via') } : {}), ...(a.includes('metric') ? { metric: Number(value('metric')) } : {}) })
    } else {
      const r = { priority: Number(value('priority')), oif: value('oif'), ...(a.includes('fwmark') ? { fwmark: value('fwmark').split('/')[0], fwmask: '0xffffffff' } : {}), table: Number(value('table')), protocol: Number(value('protocol')) }
      if (action === 'add') live.rules[family].push(r)
      else { const index = live.rules[family].findIndex(item => item.priority === r.priority && item.table === r.table && item.protocol === r.protocol); if (index >= 0) live.rules[family].splice(index, 1) }
    }
    return ''
  }
  return { root, live, calls, manager: createRoutingManager(root, { run, procRoot: proc }), fail: f => { fail = f }, bypass: v => { bypassTable = v }, sysctl: dev => fs.readFile(path.join(proc, 'sys/net/ipv4/conf', dev, 'rp_filter'), 'utf8') }
}
const mutations = calls => calls.filter(c => c[0] === 'ip' && !c.includes('-j'))

test('plans DHCP/PPP gateways, IPv4/IPv6 guards and distinct policy tables', () => {
  const plans = buildRoutingPlan(s, inventory())
  assert.deepEqual(plans.map(p => [p.table, p.priority]), [[22031, 8701], [22032, 8702]])
  assert.equal(plans[1].families[0].gateway, '10.0.2.1')
  assert.equal(plans[0].families[1].gateway, 'fe80::1')
  assert.equal(plans[1].families[1].blocked, true)
  assert(plans.every(p => p.families.every(f => f.entries.some(r => r.type === 'unreachable' && r.metric === 42760))))
  assert.equal(buildRoutingPlan({ ...s, routing: { automatic: true, directGateway4: '10.0.2.254' } }, inventory())[1].families[0].gateway, '10.0.2.254')
  const ppp = inventory(); ppp.routes[4].push({ dst: 'default', dev: 'eth2' })
  ppp.networks[2].route = []
  assert.equal(buildRoutingPlan(s, ppp)[1].families[0].gateway, '')
  assert.throws(() => buildRoutingPlan({ ...s, proxyInterface: 'br-lan' }, inventory()), /管理 LAN/)
  assert.throws(() => buildRoutingPlan({ ...s, directInterface: 'missing' }, inventory()), /未就绪/)
  assert.throws(() => buildRoutingPlan({ ...s, directInterface: 'eth1' }, inventory()), /两个不同/)
  for (const ip of ['127.0.0.1', '0.0.0.0', '224.0.0.1', '8.8.8.8;reboot', '::1']) assert.throws(() => routingSettings({ automatic: true, proxyGateway4: ip }))
  assert.throws(() => routingSettings({ automatic: true, proxyGateway6: 'fe80::1%eth1' }))
})

test('apply is owned, verifiable, idempotent, tracks DHCP and restores sysctls on removal', async t => {
  const f = await fixture(t), main = clone(f.live.routes)
  assert.equal((await f.manager.apply(s)).changed, true)
  assert.equal((await f.manager.status(s)).healthy, true)
  assert.equal(await f.sysctl('eth1'), '2'); assert.equal(await f.sysctl('eth2'), '2')
  assert.deepEqual(f.live.routes[4].filter(r => !r.table), main[4])
  assert.deepEqual(f.live.routes[6].filter(r => !r.table), main[6])
  assert.equal(f.calls.filter(c => c.includes('get') && c.includes('mark')).length, 3)
  const count = mutations(f.calls).length
  assert.equal((await f.manager.apply(s)).changed, false)
  assert.equal(mutations(f.calls).length, count)
  f.live.networks[2].route[0].nexthop = '10.0.2.254'
  assert.equal((await f.manager.status(s)).healthy, false)
  assert.equal((await f.manager.apply(s)).changed, true)
  assert(f.live.routes[4].some(r => r.table === 22032 && r.gateway === '10.0.2.254'))
  await f.manager.apply({ ...s, enabled: false })
  assert.deepEqual(f.live.routes, main)
  assert.equal(await f.sysctl('eth1'), '0'); assert.equal(await f.sysctl('eth2'), '1')
  assert(f.live.rules[4].every(r => r.priority !== 8701 && r.priority !== 8702))
})

test('foreign tables or policy priorities are rejected before any network mutation', async t => {
  for (const type of ['table', 'rule']) {
    const f = await fixture(t)
    if (type === 'table') f.live.routes[4].push({ dst: 'default', table: 22031, protocol: 242, dev: 'foreign' })
    else f.live.rules[4].push({ priority: 8701, table: 555, protocol: 4 })
    await assert.rejects(f.manager.apply(s), /未接管|已被占用/)
    assert.equal(mutations(f.calls).length, 0)
    assert.equal(await f.sysctl('eth2'), '1')
  }
})

test('partial route failure and higher-priority policy interference roll back the previous managed state', async t => {
  const f = await fixture(t)
  await f.manager.apply(s)
  const previous = clone(f.live)
  f.live.networks[2].route[0].nexthop = '10.0.2.254'
  f.fail(a => a.includes('route') && a.includes('add') && a.includes('10.0.2.254'))
  await assert.rejects(f.manager.apply(s), /出口路由已回退/)
  assert.deepEqual(f.live.routes, previous.routes)
  assert.deepEqual(f.live.rules, previous.rules)
  f.bypass(true)
  await assert.rejects(f.manager.apply(s), /更高优先级/)
  assert.deepEqual(f.live.routes, previous.routes)
  assert.deepEqual(f.live.rules, previous.rules)
  assert.equal(await f.sysctl('eth1'), '2')
  f.bypass(false)
  await f.manager.apply(s)
  assert.equal((await f.manager.status(s)).healthy, true)
})

test('disabled/manual settings never create routes, and interrupted removals recover before reconciling', async t => {
  const f = await fixture(t)
  await f.manager.apply({ ...s, enabled: false })
  await f.manager.apply({ ...s, routing: { automatic: false } })
  assert.equal(mutations(f.calls).length, 0)
  await f.manager.apply(s)
  const dir = path.join(f.root, 'data/multi-backend')
  const previous = JSON.parse(await fs.readFile(path.join(dir, 'egress-routes-state.json')))
  await fs.writeFile(path.join(dir, 'egress-routes-transaction.json'), JSON.stringify({ owner: previous.owner, previous, pending: null }))
  f.live.rules[4] = f.live.rules[4].filter(r => r.priority !== 8701)
  await f.manager.apply(s)
  assert.equal((await f.manager.status(s)).healthy, true)
  await assert.rejects(fs.stat(path.join(dir, 'egress-routes-transaction.json')), { code: 'ENOENT' })
})


test('unplugged WAN retains a blocking default and can still be removed; administrator sysctl edits survive', async t => {
  const f = await fixture(t)
  await f.manager.apply(s)
  f.live.links = f.live.links.filter(l => l.ifname !== 'eth2')
  f.live.routes[4] = f.live.routes[4].filter(r => !(r.table === 22032 && r.dev === 'eth2'))
  await assert.rejects(f.manager.apply(s), /未就绪/)
  assert(f.live.routes[4].some(r => r.table === 22032 && r.type === 'unreachable'))
  assert(f.live.rules[4].some(r => r.table === 22032 && r.oif === 'eth2'))
  const file = path.join(f.root, 'proc/sys/net/ipv4/conf/eth1/rp_filter')
  await fs.writeFile(file, '1')
  await f.manager.remove()
  assert.equal(await f.sysctl('eth1'), '1')
  assert(f.live.rules[4].every(r => ![22031, 22032].includes(r.table)))
})

const shared = { enabled: true, proxyInterface: 'br-lan', directInterface: 'br-lan', routing: { automatic: true, mode: 'shared-gateway', proxyGateway4: '192.168.1.10', directGateway4: '192.168.1.20' } }
test('shared bridge uses distinct exact marks and explicit on-link gateways, blocking unconfigured IPv6', async t => {
  const f = await fixture(t), main = clone(f.live.routes)
  const plans = buildRoutingPlan(shared, f.live)
  assert.deepEqual(plans.map(p => p.mark), [EGRESS_MARKS.proxy, EGRESS_MARKS.direct])
  assert(plans.every(p => p.families[1].blocked))
  await f.manager.apply(shared)
  assert.equal((await f.manager.status(shared)).healthy, true)
  assert.equal((await f.manager.apply(shared)).changed, false)
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'data/multi-backend/egress-routes-state.json'))).rpFilters.length, 1)
  assert.deepEqual(f.live.routes[4].filter(r => !r.table), main[4])
  await f.manager.remove()
  assert.deepEqual(f.live.routes, main)
  assert.equal(await f.sysctl('br-lan'), '0')
})
test('shared gateway rejects missing, duplicate, local and off-link gateways', () => {
  for (const patch of [{ proxyGateway4: '' }, { directGateway4: shared.routing.proxyGateway4 }, { proxyGateway4: '192.168.1.1' }, { proxyGateway4: '10.0.1.1' }, { proxyGateway4: '192.168.1.255' }, { automatic: false }]) {
    assert.throws(() => { const value = { ...shared, routing: { ...shared.routing, ...patch } }; if (!value.routing.automatic) return routingSettings({ ...value.routing, mode: 'invalid' }); buildRoutingPlan(value, inventory()) })
  }
})
test('shared marks can transition to and from physical WAN rules and recover partial failure', async t => {
  const f = await fixture(t)
  await f.manager.apply(s)
  await f.manager.apply(shared)
  const previous = clone(f.live)
  f.fail(a => a.includes('rule') && a.includes('add'))
  await assert.rejects(f.manager.apply(s), /已回退/)
  assert.deepEqual(f.live.routes, previous.routes)
  assert.deepEqual(f.live.rules, previous.rules)
  await f.manager.apply(s)
  assert.equal((await f.manager.status(s)).healthy, true)
})

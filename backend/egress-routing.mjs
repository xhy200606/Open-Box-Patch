import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)
const OWNER = 'openbox-patch-egress-v1'
const PROTO = '242'
export const ROUTE_SLOTS = [
  { role: 'proxy', label: 'Wan1', key: 'proxyInterface', table: 22031, priority: 8701 },
  { role: 'direct', label: 'Wan2', key: 'directInterface', table: 22032, priority: 8702 },
]
// 标记位必须避开 sing-box 自身的保留位：auto_redirect/strict_route 会安装
// `fwmark 0x2000000/0x2000000` 的 goto/unreachable 规则来防止流量回灌 TUN。
// 一旦我们的标记置上了 bit25，漏绑网口（oif 不匹配）的连接不会被退回 main 表，
// 而是直接命中那条 unreachable —— 表现为「分流应用成功，个别站点却完全连不上」，
// 且日志里看不出原因。这里固定使用不含 0x02000000 的一段独立号段。
export const EGRESS_MARKS = { proxy: 0x00d20101, direct: 0x00d20202 }
export const sharedGateway = s => s.routing?.mode === 'shared-gateway'
export function validateSharedGateway(s) {
  if (!sharedGateway(s)) return
  if (!s.routing.automatic || !s.proxyInterface || s.proxyInterface !== s.directInterface) throw Error('同网桥分流需要启用自动路由，并为两个出口选择同一网桥')
  const a = s.routing.proxyGateway4, b = s.routing.directGateway4
  if (!a || !b || a === b) throw Error('同网桥分流需要填写两个不同的 IPv4 上游网关')
}
const iface = /^[a-zA-Z0-9_.:-]{1,15}$/
export function routingSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.automatic !== 'boolean') throw Error('无效的自动路由设置')
  const out = { automatic: value.automatic }
  if (value.mode !== undefined) {
    if (!['interfaces', 'shared-gateway'].includes(value.mode)) throw Error('无效的出口分流模式')
    out.mode = value.mode
  }
  for (const role of ['proxy', 'direct']) for (const family of [4, 6]) {
    const key = `${role}Gateway${family}`, ip = value[key] || ''
    if (typeof ip !== 'string' || (ip && (net.isIP(ip) !== family || /^(127\.|0\.)/.test(ip) || ip === '::' || ip === '::1' || (family === 4 && Number(ip.split('.')[0]) >= 224) || (family === 6 && (ip.toLowerCase().startsWith('ff') || ip.includes('%')))))) throw Error(`${key} 必须是有效的 IPv${family} 网关地址；留空可自动识别`)
    out[key] = ip
  }
  return out
}
const mainRoute = r => !r.table || r.table === 'main' || r.table === 254
const ownedProtocol = r => String(r.protocol) === PROTO
const tableOf = r => Number(r.table)
const ruleDev = r => r.oif || r.oifname
const isDefault = r => r.dst === 'default' || r.dst === '0.0.0.0/0' || r.dst === '::/0'
const prefix = (value, family) => typeof value === 'string' && net.isIP(value.split('/')[0]) === family && (!value.includes('/') || /^\d{1,3}$/.test(value.split('/')[1]))

export function buildRoutingPlan(s, inventory) {
  if (!s.routing?.automatic) return []
  validateSharedGateway(s)
  const shared = sharedGateway(s)
  if (!s.proxyInterface || !s.directInterface || (!shared && s.proxyInterface === s.directInterface)) throw Error('自动路由需要选择两个不同且已配置地址的出口')
  const options = routingSettings(s.routing)
  return ROUTE_SLOTS.map(slot => {
    const dev = s[slot.key]
    if (!iface.test(dev)) throw Error('无效的网口名称')
    const link = inventory.links.find(l => l.ifname === dev)
    if (!link || !(link.flags || []).includes('UP') || ['DOWN', 'LOWERLAYERDOWN', 'NOTPRESENT'].includes(link.operstate)) throw Error(`${slot.label} ${dev} 尚未就绪`)
    const aliases = inventory.networks.filter(n => n.l3_device === dev && n.up)
    if (!shared && aliases.some(n => n.interface === 'lan')) throw Error(`${dev} 是管理 LAN，不能自动作为 WAN；请先在系统中配置独立的 WAN 网口`)
    const addresses = link.addr_info || []
    if (!addresses.some(a => a.family === 'inet' && a.scope !== 'host')) throw Error(`${slot.label} ${dev} 尚未取得 IPv4 地址`)
    const families = [4, 6].map(family => {
      const routes = inventory.routes[family].filter(r => mainRoute(r) && r.dev === dev && (!r.type || r.type === 'unicast'))
      const defaults = routes.filter(isDefault).sort((a, b) => (a.metric || 0) - (b.metric || 0) || String(a.gateway || '').localeCompare(String(b.gateway || '')))
      const native = aliases.flatMap(n => n.route || []).find(r => Number(r.mask) === 0 && net.isIP(r.target) === family)
      const override = options[`${slot.role}Gateway${family}`]
      const gateway = shared ? override : override || defaults[0]?.gateway || native?.nexthop || ''
      const hasAddress = addresses.some(a => a.family === (family === 4 ? 'inet' : 'inet6') && a.scope !== 'host' && (family === 4 || !a.local.startsWith('fe80:')))
      const hasDefault = shared ? Boolean(override) : Boolean(override || defaults.length || native)
      if (family === 4 && !hasDefault) throw Error(`${slot.label} ${dev} 无法识别 IPv4 网关；请先完成 DHCP/拨号，或在面板填写网关`)
      const usable = hasAddress && hasDefault
      if (gateway && net.isIP(gateway) !== family) throw Error(`${slot.label} 网关的地址类型不匹配`)
      if (shared && gateway && family === 4) {
        const toInt = ip => ip.split('.').reduce((a, b) => (a * 256 + Number(b)) >>> 0, 0)
        const valid = addresses.some(a => a.family === 'inet' && a.local !== gateway && a.prefixlen > 0 && a.prefixlen < 31 && (() => {
          const mask = (0xffffffff << (32 - a.prefixlen)) >>> 0, host = toInt(gateway), own = toInt(a.local)
          return (host & mask) === (own & mask) && (host & ~mask) !== 0 && (host & ~mask) !== (~mask >>> 0)
        })())
        if (!valid || inventory.links.some(l => (l.addr_info || []).some(a => a.local === gateway))) throw Error(`${slot.label} 网关必须是同网段的其他设备地址`)
      }
      const connected = routes.filter(r => !isDefault(r) && !r.gateway && prefix(r.dst, family)).map(r => r.dst)
      if (usable && gateway) connected.push(gateway + (family === 4 ? '/32' : '/128'))
      const entries = [...new Set(connected)].sort().map(dst => ({ dst, dev, metric: 10 }))
      // This device-independent guard survives an interface disappearing. Never
      // let a missing WAN default fall through to main/the other WAN.
      entries.unshift({ dst: 'default', type: 'unreachable', metric: 42760 })
      if (usable) entries.push({ dst: 'default', dev, ...(gateway ? { gateway } : {}), metric: 10 })
      return { family, gateway: usable ? gateway : '', blocked: !usable, entries }
    })
    return { ...slot, dev, ...(shared ? { mark: EGRESS_MARKS[slot.role] } : {}), networks: aliases.map(n => n.interface).sort(), families }
  })
}

export function createRoutingManager(root, dependencies = {}) {
  const dir = path.join(root, 'data/multi-backend')
  const file = path.join(dir, 'egress-routes-state.json'), journal = path.join(dir, 'egress-routes-transaction.json')
  const lock = path.join(dir, 'egress-routes.lock')
  const run = dependencies.run || (async (bin, args) => (await execute(bin, args, { timeout: 15000, maxBuffer: 1024 * 1024 })).stdout)
  const proc = dependencies.procRoot || '/proc'
  const text = async (p, fallback = null) => fs.readFile(p, 'utf8').catch(e => { if (e.code === 'ENOENT') return fallback; throw e })
  const read = async p => { const data = await text(p); return data === null ? null : JSON.parse(data) }
  async function write(p, data) {
    await fs.mkdir(dir, { recursive: true })
    const tmp = p + '.' + process.pid + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); await fs.rename(tmp, p)
  }
  const json = async args => JSON.parse(await run('ip', ['-j', ...args]))
  async function inspect() {
    const [links, routes4, routes6, rules4, rules6, ubus] = await Promise.all([
      json(['address', 'show']), json(['-4', 'route', 'show', 'table', 'all']), json(['-6', 'route', 'show', 'table', 'all']),
      json(['-4', 'rule', 'show']), json(['-6', 'rule', 'show']),
      run('ubus', ['call', 'network.interface', 'dump']).then(JSON.parse).catch(() => ({ interface: [] })),
    ])
    return { links, routes: { 4: routes4, 6: routes6 }, rules: { 4: rules4, 6: rules6 }, networks: ubus.interface || [] }
  }
  async function state() {
    const s = await read(file)
    if (s && (s.owner !== OWNER || !Array.isArray(s.plans) || !Array.isArray(s.rpFilters))) throw Error('路由所有权记录无效，未修改系统路由')
    return s
  }
  function validateOwnership(live, ownership) {
    for (const family of [4, 6]) for (const slot of ROUTE_SLOTS) {
      const allowed = (ownership || []).flatMap(s => s?.plans || []).filter(p => p.table === slot.table)
      for (const r of live.routes[family].filter(r => tableOf(r) === slot.table)) if (!allowed.length || !ownedProtocol(r)) throw Error(`路由表 ${slot.table} 已有非本补丁管理的路由，未接管`)
      for (const r of live.rules[family].filter(r => r.priority === slot.priority || tableOf(r) === slot.table)) {
        if (!ownedProtocol(r) || !allowed.some(p => r.priority === p.priority && tableOf(r) === p.table && ruleDev(r) === p.dev && (p.mark ? Number(r.fwmark) === p.mark && (!r.fwmask || Number(r.fwmask) === 0xffffffff) : !r.fwmark))) throw Error(`IPv${family} 策略规则 ${slot.priority} 或表 ${slot.table} 已被占用，未覆盖`)
      }
    }
  }
  const ip = (family, args) => run('ip', [`-${family}`, ...args])
  function routeArgs(entry) {
    return [...(entry.type ? [entry.type] : []), entry.dst, ...(entry.gateway ? ['via', entry.gateway] : []), ...(entry.dev ? ['dev', entry.dev] : []), ...(entry.metric ? ['metric', String(entry.metric)] : [])]
  }
  async function clear(ownership) {
    const live = await inspect(); validateOwnership(live, ownership)
    for (const family of [4, 6]) for (const slot of ROUTE_SLOTS) {
      // Delete by the validated, owned tuple, so unplugged devices do not
      // prevent cleanup (their interface name may no longer be resolvable).
      for (const rule of live.rules[family].filter(r => r.priority === slot.priority && tableOf(r) === slot.table)) {
        await ip(family, ['rule', 'del', 'priority', String(slot.priority), 'table', String(slot.table), 'protocol', PROTO])
      }
      if (live.routes[family].some(r => tableOf(r) === slot.table)) await ip(family, ['route', 'flush', 'table', String(slot.table), 'protocol', PROTO])
    }
  }
  const sysctl = dev => path.join(proc, 'sys/net/ipv4/conf', dev, 'rp_filter')
  async function restoreFilters(source, keep = []) {
    for (const r of source?.rpFilters || []) if (!keep.includes(r.dev)) {
      const current = await text(sysctl(r.dev))
      // Do not undo a newer administrator change.
      if (current?.trim() === '2') await fs.writeFile(sysctl(r.dev), r.previous)
    }
  }
  async function install(next, previous) {
    if (!next) { await restoreFilters(previous); return }
    for (const p of next.plans) for (const f of p.families) {
      for (const e of f.entries) await ip(f.family, ['route', 'add', ...routeArgs(e), 'table', String(p.table), 'protocol', PROTO])
    }
    for (const r of next.rpFilters) await fs.writeFile(sysctl(r.dev), '2')
    for (const p of next.plans) for (const f of p.families) await ip(f.family, ['rule', 'add', 'priority', String(p.priority), 'oif', p.dev, ...(p.mark ? ['fwmark', String(p.mark) + '/0xffffffff'] : []), 'table', String(p.table), 'protocol', PROTO])
    await restoreFilters(previous, next.rpFilters.map(r => r.dev))
  }
  function healthy(live, s) {
    if (!s) return false
    return s.plans.every(p => p.families.every(f =>
      live.rules[f.family].some(r => r.priority === p.priority && tableOf(r) === p.table && ruleDev(r) === p.dev && (p.mark ? Number(r.fwmark) === p.mark && (!r.fwmask || Number(r.fwmask) === 0xffffffff) : !r.fwmark) && ownedProtocol(r)) &&
      f.entries.every(e => live.routes[f.family].some(r => tableOf(r) === p.table && ownedProtocol(r) && r.dst.replace(f.family === 4 ? /\/32$/ : /\/128$/, '') === e.dst.replace(f.family === 4 ? /\/32$/ : /\/128$/, '') && (r.type || 'unicast') === (e.type || 'unicast') && (e.type === 'unreachable' || (r.dev || '') === (e.dev || '')) && (r.gateway || '') === (e.gateway || '') && (r.metric || 0) === (e.metric || 0)))
    ))
  }
  async function verify(next) {
    if (!next) return
    const live = await inspect()
    if (!healthy(live, next)) throw Error('自动路由落盘校验未通过')
    for (const p of next.plans) for (const f of p.families) if (!f.blocked) for (const mark of (p.mark ? [String(p.mark)] : [null, '0x2024'])) {
      const result = await json([`-${f.family}`, 'route', 'get', f.family === 4 ? '1.1.1.1' : '2001:4860:4860::8888', 'oif', p.dev, ...(mark ? ['mark', mark] : [])])
      if (!result.some(r => r.dev === p.dev && tableOf(r) === p.table && (r.gateway || '') === f.gateway)) throw Error(`${p.label} IPv${f.family} 实际路由查询未命中表 ${p.table}，可能有更高优先级的策略规则`)
    }
  }
  async function locked(fn) {
    await fs.mkdir(dir, { recursive: true })
    for (let attempt = 0; ; attempt++) {
      try { await fs.mkdir(lock); break } catch (e) {
        if (e.code !== 'EEXIST') throw e
        const pid = Number(await text(path.join(lock, 'pid'), '0'))
        let alive = false; try { if (pid > 0) { process.kill(pid, 0); alive = true } } catch {}
        const age = Date.now() - (await fs.stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs
        if (!alive && age > 2000) { await fs.rm(lock, { recursive: true, force: true }); continue }
        if (attempt >= 120) throw Error('其他进程正在更新出口路由，请稍后重试')
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    await fs.writeFile(path.join(lock, 'pid'), String(process.pid), { mode: 0o600 })
    try { return await fn() } finally { await fs.rm(lock, { recursive: true, force: true }) }
  }
  async function recover() {
    const transaction = await read(journal)
    if (!transaction) return
    if (transaction.owner !== OWNER) throw Error('路由事务记录无效')
    const { previous, pending } = transaction
    await clear([previous, pending]); await install(previous, pending)
    if (previous) await write(file, previous); else await fs.rm(file, { force: true })
    await fs.rm(journal, { force: true })
  }
  async function apply(s) {
    // Disabled/default/manual settings never create rules, tables, or sysctls.
    const current = await state()
    if (!s.enabled || !s.routing?.automatic) { if (!current && !await read(journal)) return { changed: false }; return remove() }
    return locked(async () => {
      await recover()
      const previous = await state(), live = await inspect()
      const plans = buildRoutingPlan(s, live)
      validateOwnership(live, [previous])
      const rpFilters = []
      for (const p of plans) {
        if (rpFilters.some(r => r.dev === p.dev)) continue
        const saved = previous?.rpFilters.find(r => r.dev === p.dev)
        const value = await text(sysctl(p.dev))
        if (value === null) throw Error(`无法读取 ${p.dev} 的反向路径校验设置`)
        rpFilters.push(saved || { dev: p.dev, previous: value.trim() })
      }
      const next = { owner: OWNER, plans, rpFilters }
      if (JSON.stringify(previous) === JSON.stringify(next) && healthy(live, next) && (await Promise.all(rpFilters.map(r => text(sysctl(r.dev))))).every(v => v?.trim() === '2')) return { changed: false, state: next }
      await write(journal, { owner: OWNER, previous, pending: next })
      try {
        await clear([previous]); await install(next, previous); await verify(next)
        await write(file, next); await fs.rm(journal, { force: true })
        return { changed: true, state: next }
      } catch (error) {
        try { await clear([previous, next]); await install(previous, next); if (previous) await write(file, previous); else await fs.rm(file, { force: true }); await fs.rm(journal, { force: true }) }
        catch (rollback) { throw Error(`${error.message}；路由回退未完成：${rollback.message}`) }
        throw Error(`${error.message}；出口路由已回退`)
      }
    })
  }
  async function remove() {
    return locked(async () => {
      await recover()
      const previous = await state()
      if (!previous) return { changed: false }
      await write(journal, { owner: OWNER, previous, pending: null })
      try { await clear([previous]); await install(null, previous); await fs.rm(file, { force: true }); await fs.rm(journal, { force: true }); return { changed: true } }
      catch (error) { await recover(); throw error }
    })
  }
  async function status(s) {
    try {
      const live = await inspect(), saved = await state()
      validateOwnership(live, [saved])
      let plans = [], planError = ''
      try { plans = buildRoutingPlan({ ...s, routing: { ...s.routing, automatic: true } }, live) } catch (e) { planError = e.message }
      const uplinks = live.links.filter(l => l.ifname !== 'lo').map(l => {
        const networks = live.networks.filter(n => n.l3_device === l.ifname && n.up)
        const gateways = [4, 6].map(f => live.routes[f].find(r => mainRoute(r) && r.dev === l.ifname && isDefault(r))?.gateway || networks.flatMap(n => n.route || []).find(r => !r.mask && net.isIP(r.target) === f)?.nexthop || '')
        return { dev: l.ifname, networks: networks.map(n => n.interface), gateway4: gateways[0], gateway6: gateways[1], management: networks.some(n => n.interface === 'lan') }
      })
      const filtersReady = Boolean(saved && (await Promise.all(saved.rpFilters.map(r => text(sysctl(r.dev))))).every(v => v?.trim() === '2'))
      const pending = Boolean(await read(journal))
      return { supported: true, automatic: Boolean(s.routing?.automatic), applied: Boolean(saved), healthy: Boolean(saved && plans.length && JSON.stringify(saved.plans) === JSON.stringify(plans) && healthy(live, saved) && filtersReady && !pending), plans, planError, uplinks, transactionPending: pending }
    } catch (error) { return { supported: false, automatic: Boolean(s.routing?.automatic), healthy: false, error: '自动路由检测失败（需要支持 JSON 的 ip-full）：' + error.message } }
  }
  return { apply, remove, status, inspect }
}
export const applyRouting = (s, root) => createRoutingManager(root).apply(s)
export const removeRouting = root => createRoutingManager(root).remove()
export const routingStatus = (s, root) => createRoutingManager(root).status(s)

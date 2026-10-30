import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { routingSettings, applyRouting, sharedGateway, validateSharedGateway, EGRESS_MARKS } from './egress-routing.mjs'
const exec = promisify(execFile)
export const ROOT = process.env.OPENBOX_ROOT || '/opt/open-box'
const loopback = host => typeof host === 'string' && (/^127\./.test(host) || ['::1', '[::1]', 'localhost'].includes(host.toLowerCase()))
const localDirect = node => node.type === 'direct' && ['lo', 'lo0'].includes(node.bind_interface)
const ifacePattern = /^[a-zA-Z0-9_.:-]{1,15}$/
const VIRTUAL = new Set(['selector', 'urltest', 'block', 'dns'])
// 网口自身的 IPv4 网段（规范成网络地址）。管理网段必须排除在 TUN 之外，
// 否则本机对 LAN 的回程流量也会被吸进 TUN，直接导致局域网内失联。
const networkCidrs = dev => (os.networkInterfaces()[dev] || [])
  .filter(a => a.family === 'IPv4' && a.cidr)
  .map(a => {
    const [ip, prefix] = a.cidr.split('/'), bits = Number(prefix)
    const n = ip.split('.').reduce((x, y) => (x * 256 + Number(y)) >>> 0, 0)
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    const net = (n & mask) >>> 0
    return [net >>> 24, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join('.') + '/' + bits
  })

export function settings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('无效的出口分流设置')
  if (typeof value.enabled !== 'boolean') throw Error('启用必须为布尔值')
  const result = { enabled: value.enabled, proxyInterface: value.proxyInterface || '', directInterface: value.directInterface || '' }
  for (const key of ['proxyInterface', 'directInterface']) if (typeof result[key] !== 'string' || (result[key] && !ifacePattern.test(result[key]))) throw Error('无效的网口名称')
  if (value.routing !== undefined) result.routing = routingSettings(value.routing)
  return result
}
export async function interfaces() {
  // 测试钩子：允许用固定网口清单跑通"已启用"分支（生产环境永远不会设置该变量）
  if (process.env.OPENBOX_EGRESS_INTERFACES) return JSON.parse(process.env.OPENBOX_EGRESS_INTERFACES)
  const addresses = os.networkInterfaces()
  const names = await fs.readdir('/sys/class/net').catch(() => Object.keys(addresses))
  return Promise.all(names.filter(n => n !== 'lo').map(async name => ({ name, addresses: (addresses[name] || []).map(a => a.address), state: (await fs.readFile(`/sys/class/net/${name}/operstate`, 'utf8').catch(() => 'unknown')).trim() })))
}
export function validateInterfaces(s, available) {
  if (!s.enabled) return
  if (!s.proxyInterface || !s.directInterface) throw Error('请分别选择代理出口（Wan1）与直连出口（Wan2）')
  validateSharedGateway(s)
  if (!sharedGateway(s) && s.proxyInterface === s.directInterface) throw Error('Wan1 与 Wan2 不能是同一个网口；出口分流需要两个不同的物理出口')
  for (const name of [s.proxyInterface, s.directInterface]) {
    const info = available.find(i => i.name === name)
    if (!info || !info.addresses.length || ['down', 'notpresent', 'lowerlayerdown'].includes(info.state)) throw Error(`网口 ${name || '未选择'} 尚未就绪；可先停用并保存，接入网口后再启用`)
  }
}
export function validateProfile(profile) {
  if (!profile || profile.directBypass !== false) throw Error('需先关闭直连绕过并重新部署 OpenBox')
  if (profile.clientRoutes?.some(r => r.bypass === true) || String(profile.bypassPorts || '').trim() || profile.bypassPortsMode === 'whitelist') throw Error('请先在 OpenBox 关闭终端绕过与端口绕过；这些流量不经过内核，无法绑定 Wan2')
}

// Clone only detour-reachable nodes: a direct node shared by a normal DIRECT
// selector and a proxy transport must have separate interface bindings.
export function transform(config, s) {
  const out = structuredClone(config)
  if (!s.enabled) return out
  validateSharedGateway(s)
  const shared = sharedGateway(s)
  if (out.endpoints?.length) throw Error('暂不支持含 endpoints 的配置，请先移除独立端点')
  const nodes = out.outbounds || []
  const groups = new Set(['selector', 'urltest'])
  // 指向本机回环的节点，其真实出口由那个本地进程决定，内核无法为它绑定出口。
  // 以前这里直接抛错，结果是「配置里残留一个失效的本地节点 → 整个分流功能不可用」。
  // 正确做法是把它们从分流里摘掉：先从 selector/urltest 的成员名单里剔除
  // （否则组里仍能选到它，出口就不可控了），再把出站本身移除。
  const loopbackTags = new Set(nodes.filter(n => loopback(n.server)).map(n => n.tag))
  if (loopbackTags.size) {
    for (const node of nodes) {
      if (!groups.has(node.type)) continue
      if (Array.isArray(node.outbounds)) node.outbounds = node.outbounds.filter(t => !loopbackTags.has(t))
      if (node.default && loopbackTags.has(node.default)) node.default = node.outbounds?.[0]
    }
    // 原地删除，保持 nodes 与 out.outbounds 的同一引用关系
    for (let i = nodes.length - 1; i >= 0; i--) if (loopbackTags.has(nodes[i].tag)) nodes.splice(i, 1)
  }
  const byTag = new Map(nodes.map(n => [n.tag, n]))
  if (byTag.size !== nodes.length || nodes.some(n => !n.tag)) throw Error('出站标签缺失或重复')
  const clones = new Map(), visiting = new Set()
  function viaProxy(tag) {
    if (visiting.has(tag)) throw Error('出站 detour 存在循环')
    if (clones.has(tag)) return clones.get(tag)
    const node = byTag.get(tag)
    if (!node) throw Error(`找不到 detour 出站 ${tag}`)
    visiting.add(tag)
    let cloneTag = `ob-egress-${clones.size}`
    while (byTag.has(cloneTag)) cloneTag += '-'
    const copy = structuredClone(node)
    copy.tag = cloneTag
    clones.set(tag, cloneTag)
    byTag.set(cloneTag, copy)
    if (groups.has(copy.type)) {
      copy.outbounds = (copy.outbounds || []).map(viaProxy)
      if (copy.default) copy.default = viaProxy(copy.default)
    } else if (!VIRTUAL.has(copy.type) && !localDirect(copy)) {
      delete copy.inet4_bind_address; delete copy.inet6_bind_address
      delete copy.bind_interface
      if (copy.detour) copy.detour = viaProxy(copy.detour)
      else { copy.bind_interface = s.proxyInterface; if (shared) copy.routing_mark = EGRESS_MARKS.proxy }
    }
    visiting.delete(tag)
    nodes.push(copy)
    return cloneTag
  }
  for (const node of [...nodes]) {
    if (VIRTUAL.has(node.type) || localDirect(node)) continue
    if (loopback(node.server)) throw Error('本机代理出口由其他进程转发，无法保证 Wan1 绑定；请改用远程代理节点')
    delete node.inet4_bind_address; delete node.inet6_bind_address
    delete node.bind_interface
    if (node.detour) node.detour = viaProxy(node.detour)
    else {
      node.bind_interface = node.type === 'direct' ? s.directInterface : s.proxyInterface
      if (shared) node.routing_mark = node.type === 'direct' ? EGRESS_MARKS.direct : EGRESS_MARKS.proxy
    }
  }
  // Internal DNS rewrite and dnsmasq sockets must still reach loopback;
  // the default external interface otherwise makes these local dials fail.
  for (const server of out.dns?.servers || []) {
    if (loopback(server.server) && !server.detour) { server.bind_interface = 'lo'; if (shared) server.routing_mark = 0 }
  }
  // fakeip 网段必须回灌进 TUN。否则客户端把被墙域名解析成 198.19.x 之后，这条
  // 连接会按系统默认路由（直连出口）走掉，根本进不了内核 —— 表现为「国外不通」，
  // 而内核侧看起来一切正常。sing-box 的 auto_route 只铺 route_address(set) 里的段，
  // 这里把 dns.servers 声明的 fakeip 范围补进去。
  const fakeip = (out.dns?.servers || [])
    .filter(server => server.type === 'fakeip')
    .flatMap(server => [server.inet4_range, server.inet6_range])
    .filter(Boolean)
  if (fakeip.length) {
    for (const inbound of out.inbounds || []) {
      if (inbound.type !== 'tun') continue
      inbound.route_address = [...new Set([...(inbound.route_address || []), ...fakeip])]
    }
  }
  if (shared) {
    // 管理网段必须留在 TUN 之外。全量接管后，如果 br-lan 自己的网段没有排除，
    // 本机发往 LAN（面板、SSH、两个上游网关）的回程也会被吸进 TUN ——
    // 表现为主机在局域网内 ping 不通、面板打不开、SSH 断开。
    const cidrs = networkCidrs(s.directInterface)
    for (const inbound of out.inbounds || []) {
      if (inbound.type !== 'tun') continue
      // 同网桥分流要求「所有出网流量都经过内核」，否则直连流量按系统主路由
      // （默认网关）直接出去，Wan2 上的网关形同虚设。而 auto_redirect 只接管
      // route_address_set 内的地址（实际等于 fakeip 段），并且它与
      // route.default_mark 在 sing-box 里互斥 —— 同时开启会让所有出站连接
      // 直接报错（节点域名解析失败，表现为「全部节点超时」）。
      // 因此这里关闭 auto_redirect，改由 auto_route 铺全量默认路由接管。
      inbound.auto_redirect = false
      delete inbound.route_address_set
      // route_address / route_address_set 任一非空，auto_route 就只铺这些段
      // （fakeip 回灌恰好会把接管范围缩到 198.19.0.0/16）。清空后才会铺
      // 0.0.0.0/1 + 128.0.0.0/1 的全量默认路由；fakeip 段本身也在其中。
      delete inbound.route_address
      if (cidrs.length) {
        inbound.route_exclude_address = [...new Set([...(inbound.route_exclude_address || []), ...cidrs])]
      }
    }
  }
  out.route = { ...out.route, auto_detect_interface: false, default_interface: s.directInterface, ...(shared ? { default_mark: EGRESS_MARKS.direct } : {}) }
  return out
}

/**
 * 静态校验「生成的运行配置确实实现了分流」。
 *
 * sing-box `check` 只保证语法与引用合法，无法发现"两个出口其实绑到了同一个网口"
 * 或"某个出站漏了绑定、走默认路由"这类问题 —— 这正是"应用成功但没分流"的来源。
 */
export function verifyConfig(config, s) {
  const problems = []
  if (!s.enabled) return { ok: true, problems }
  if (!config || typeof config !== 'object') return { ok: false, problems: ['运行配置为空'] }
  if (!s.proxyInterface || !s.directInterface) problems.push('未选择代理出口 / 直连出口')
  else if (!sharedGateway(s) && s.proxyInterface === s.directInterface) problems.push('Wan1 与 Wan2 是同一个网口，无法形成物理分流')
  try { validateSharedGateway(s) } catch (error) { problems.push(error.message) }
  const nodes = Array.isArray(config.outbounds) ? config.outbounds : []
  if (!nodes.length) problems.push('运行配置没有出站')
  const proxyBound = nodes.filter(n => n.bind_interface && n.bind_interface === s.proxyInterface && (!sharedGateway(s) || n.routing_mark === EGRESS_MARKS.proxy))
  const directBound = nodes.filter(n => n.type === 'direct' && n.bind_interface === s.directInterface && (!sharedGateway(s) || n.routing_mark === EGRESS_MARKS.direct))
  if (s.proxyInterface && !proxyBound.length) problems.push(`没有任何出站绑定到 Wan1 ${s.proxyInterface}`)
  if (s.directInterface && !directBound.length) problems.push(`没有直连出站绑定到 Wan2 ${s.directInterface}`)
  const unbound = nodes.filter(n => !VIRTUAL.has(n.type) && !localDirect(n) && !n.bind_interface && !n.detour)
  if (unbound.length) problems.push('以下出站未绑定网口：' + unbound.slice(0, 6).map(n => n.tag || n.type).join('、'))
  if (sharedGateway(s)) {
    if (config.route?.default_mark !== EGRESS_MARKS.direct) problems.push('默认直连路由标记不正确')
    for (const inbound of config.inbounds || []) {
      if (inbound.type !== 'tun') continue
      // 回归保护：这两项任一为真，直连出口都不会真正生效。
      if (inbound.auto_redirect) problems.push('TUN 仍启用 auto_redirect：它只接管 fakeip 段，且与默认路由标记互斥')
      if ((inbound.route_address_set || []).length) problems.push('TUN 仍受 route_address_set 限制：直连流量不经过内核')
      if ((inbound.route_address || []).length) problems.push('TUN 仍受 route_address 限制：auto_route 不会铺全量默认路由')
      const excluded = inbound.route_exclude_address || []
      const missing = networkCidrs(s.directInterface).filter(c => !excluded.includes(c))
      if (missing.length) problems.push(`TUN 未排除管理网段 ${missing.join('、')}：本机会在局域网内失联`)
    }
    const proxyLeaves = new Set(), visited = new Set(), byTag = new Map(nodes.map(n => [n.tag, n]))
    function visit(tag) {
      if (visited.has(tag)) return
      visited.add(tag)
      const n = byTag.get(tag); if (!n) return
      if (n.detour) visit(n.detour)
      else if (['selector', 'urltest'].includes(n.type)) (n.outbounds || []).forEach(visit)
      else if (!localDirect(n)) proxyLeaves.add(tag)
    }
    nodes.filter(n => !VIRTUAL.has(n.type) && n.type !== 'direct').forEach(n => visit(n.tag))
    for (const n of nodes.filter(n => !VIRTUAL.has(n.type) && !localDirect(n) && !n.detour)) {
      const expected = proxyLeaves.has(n.tag) ? EGRESS_MARKS.proxy : EGRESS_MARKS.direct
      if (n.routing_mark !== expected) problems.push(`出站 ${n.tag} 的路由标记不正确`)
    }
  }
  if (config.route?.auto_detect_interface !== false) problems.push('route.auto_detect_interface 未关闭')
  if (config.route?.default_interface !== s.directInterface) problems.push('route.default_interface 不是直连出口')
  return { ok: problems.length === 0, problems }
}

export const directory = root => path.join(root, 'data/multi-backend')
export async function atomic(file, data, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try { await fs.writeFile(tmp, data, { mode }); await fs.rename(tmp, file) }
  finally { await fs.rm(tmp, { force: true }) }
}
export async function load(root = ROOT) {
  try { return settings(JSON.parse(await fs.readFile(path.join(directory(root), 'egress.json'), 'utf8'))) }
  catch (error) { if (error.code !== 'ENOENT') throw error; return settings({ enabled: false }) }
}
export async function readProfile(root = ROOT) {
  const { DatabaseSync } = await import('node:sqlite')
  let dbPath = process.env.ZASHBOARD_DB_PATH
  if (!dbPath) {
    const current = path.join(root, 'data/openbox.sqlite')
    dbPath = await fs.stat(current).then(() => current, () => path.join(root, 'panel/data/zashboard.sqlite'))
  }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try { return JSON.parse(db.prepare("SELECT value FROM app_storage WHERE key='openbox/profile'").get()?.value || '{}') }
  finally { db.close() }
}

/**
 * 运行期状态：内核进程是否真的跑在 `egress-runtime.json` 上。
 * 包装脚本被绕过（面板直接拉起原生 sing-box）时这里会是 false —— 此时"应用成功"也等于没分流。
 */
export async function runtimeState(root = ROOT, procRoot = '/proc') {
  const runtime = path.join(directory(root), 'egress-runtime.json')
  const stat = await fs.stat(runtime).catch(() => null)
  const pids = await fs.readdir(procRoot).catch(() => null)
  const processes = []
  for (const pid of pids || []) {
    if (!/^\d+$/.test(pid)) continue
    const raw = await fs.readFile(path.join(procRoot, pid, 'cmdline'), 'utf8').catch(() => '')
    if (!raw || !raw.includes('sing-box')) continue
    const cmdline = raw.split('\0').filter(Boolean).join(' ')
    processes.push({ pid: Number(pid), usesRuntime: cmdline.includes(runtime), cmdline: cmdline.slice(0, 240) })
  }
  const active = processes.find(p => p.usesRuntime) || null
  return {
    // 非 Linux（无 /proc）无法检查进程，此时只做配置层校验
    supported: pids !== null,
    runtimeFile: stat ? { at: new Date(stat.mtimeMs).toISOString(), bytes: stat.size } : null,
    active: Boolean(active),
    pid: active ? active.pid : null,
    processes,
  }
}

/** 运行配置里实际的绑定情况，用于面板展示"到底绑到哪儿了"。 */
export async function summary(root = ROOT) {
  const s = await load(root).catch(() => null)
  const config = await fs.readFile(path.join(directory(root), 'egress-runtime.json'), 'utf8').then(text => JSON.parse(text), () => null)
  if (!s || !config) return null
  const nodes = Array.isArray(config.outbounds) ? config.outbounds : []
  const bound = (iface, role) => nodes.filter(n => n.bind_interface === iface && (!sharedGateway(s) || n.routing_mark === EGRESS_MARKS[role])).map(n => n.tag || n.type)
  return {
    enabled: s.enabled,
    proxyInterface: s.proxyInterface,
    directInterface: s.directInterface,
    proxyOutbounds: bound(s.proxyInterface, 'proxy').slice(0, 12),
    directOutbounds: bound(s.directInterface, 'direct').slice(0, 12),
    defaultInterface: config.route?.default_interface || '',
    autoDetectInterface: config.route?.auto_detect_interface,
    verify: verifyConfig(config, s),
  }
}

async function failureFile(root) { return path.join(directory(root), 'egress-last-error.json') }
export async function startupError(root = ROOT) {
  try { return JSON.parse(await fs.readFile(await failureFile(root), 'utf8')) } catch { return null }
}
async function recordFailure(root, message) {
  await atomic(await failureFile(root), JSON.stringify({ at: new Date().toISOString(), message: String(message).slice(0, 500) })).catch(() => {})
}

/**
 * 生成内核要用的配置路径。
 *
 * **失败即拒绝启动（fail-closed）**：任何一步校验不过都抛错，包装脚本因此退出，
 * 内核保持停止 —— 宁可不启动，也不把流量送到错误的出口。这里**不再**回退到原始配置
 * （曾经的静默回退会让面板显示"应用成功"，实际却没有分流）。
 */
export async function prepare(root = ROOT, value, profile, options = {}) {
  const s = settings(value || await load(root))
  const plain = path.join(root, 'etc/config.json')
  if (!s.enabled) {
    if (options.configureRoutes !== false) await applyRouting(s, root)
    await fs.rm(await failureFile(root), { force: true }).catch(() => {}); return plain
  }
  try {
    validateInterfaces(s, await interfaces())
    validateProfile(profile || await readProfile(root))
    const config = JSON.parse(await fs.readFile(plain, 'utf8'))
    const transformed = transform(config, s)
    const verdict = verifyConfig(transformed, s)
    if (!verdict.ok) throw Error('分流配置校验失败：' + verdict.problems.join('；'))
    const candidate = path.join(directory(root), `egress-check-${process.pid}.json`)
    try {
      await atomic(candidate, JSON.stringify(transformed, null, 2))
      await exec(path.join(root, 'bin/sing-box'), ['check', '-c', candidate, '-D', path.join(root, 'data')], { timeout: 30000, maxBuffer: 256 * 1024 })
      if (options.configureRoutes !== false) await applyRouting(s, root)
      const runtime = path.join(directory(root), 'egress-runtime.json')
      await fs.rename(candidate, runtime)
      await fs.rm(await failureFile(root), { force: true }).catch(() => {})
      return runtime
    } finally { await fs.rm(candidate, { force: true }) }
  } catch (error) {
    await recordFailure(root, error.stderr || error.message)
    throw error
  }
}

// Touch only the service launcher. Protected panel/server and CLI are untouched.
export async function hook(root = ROOT, remove = false) {
  const init = path.join(process.env.OPENBOX_INITD_DIR || '/etc/init.d', 'openbox')
  const drop = path.join(process.env.OPENBOX_SYSD_DIR || '/etc/systemd/system', 'openbox.service.d/90-openbox-egress.conf')
  const source = 'procd_set_param command "$BIN" run -c "$CONF" -D "$DATA"'
  const replacement = `procd_set_param command "${directory(root)}/egress-run.sh" run -c "$CONF" -D "$DATA" # openbox-patch-egress`
  if (await fs.stat(init).then(() => true, () => false)) {
    const text = await fs.readFile(init, 'utf8')
    if (remove) {
      if (text.includes(replacement)) await atomic(init, text.replace(replacement, source), 0o755)
      else if (text.includes('# openbox-patch-egress')) throw Error('启动脚本已变化，需手动移除出口分流启动行')
    } else if (!text.includes(replacement)) {
      if (text.split(source).length !== 2) throw Error('OpenWrt 启动格式不兼容，未修改服务')
      await atomic(init, text.replace(source, replacement), 0o755)
    }
    return 'openwrt'
  }
  if (await fs.stat(path.join(root, 'debian/systemd/openbox.service')).then(() => true, () => false)) {
    if (remove) await fs.rm(drop, { force: true })
    else {
      if (!/^\/[a-zA-Z0-9_./-]+$/.test(root)) throw Error('systemd 安装路径含不支持的字符')
      await atomic(drop, `[Service]\nExecStart=\nExecStart=${directory(root)}/egress-run.sh run -c ${root}/etc/config.json -D ${root}/data\n`, 0o644)
    }
    await exec('systemctl', ['daemon-reload'], { timeout: 15000 })
    return 'systemd'
  }
  if (!remove) throw Error('未找到支持的 OpenWrt/systemd 内核服务；未更改启动方式')
}

/** 通过服务管理器重启内核 —— 只有这样才会走 egress-run.sh 包装脚本。 */
export async function restartKernel() {
  const init = path.join(process.env.OPENBOX_INITD_DIR || '/etc/init.d', 'openbox')
  if (await fs.stat(init).then(() => true, () => false)) {
    await exec(init, ['restart'], { timeout: 120000 })
    return 'openwrt'
  }
  await exec('systemctl', ['restart', 'openbox'], { timeout: 120000 })
  return 'systemd'
}

/** 内核服务是否被包装脚本接管（决定"应用"之后能不能真的生效）。 */
export async function hookState(root = ROOT) {
  const init = path.join(process.env.OPENBOX_INITD_DIR || '/etc/init.d', 'openbox')
  const drop = path.join(process.env.OPENBOX_SYSD_DIR || '/etc/systemd/system', 'openbox.service.d/90-openbox-egress.conf')
  if (await fs.stat(init).then(() => true, () => false)) {
    const text = await fs.readFile(init, 'utf8').catch(() => '')
    return { platform: 'openwrt', active: text.includes('# openbox-patch-egress') }
  }
  if (await fs.stat(path.join(root, 'debian/systemd/openbox.service')).then(() => true, () => false)) {
    return { platform: 'systemd', active: await fs.stat(drop).then(() => true, () => false) }
  }
  return { platform: 'unknown', active: false }
}

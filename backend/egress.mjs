import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
export const ROOT = process.env.OPENBOX_ROOT || '/opt/open-box'
const loopback = host => typeof host === 'string' && (/^127\./.test(host) || ['::1', '[::1]', 'localhost'].includes(host.toLowerCase()))
const localDirect = node => node.type === 'direct' && ['lo', 'lo0'].includes(node.bind_interface)
const ifacePattern = /^[a-zA-Z0-9_.:-]{1,15}$/
export function settings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('无效的出口分流设置')
  if (typeof value.enabled !== 'boolean' || typeof value.singleNicTest !== 'boolean') throw Error('启用及测试模式必须为布尔值')
  const result = { enabled: value.enabled, singleNicTest: value.singleNicTest, proxyInterface: value.proxyInterface || '', directInterface: value.directInterface || '' }
  for (const key of ['proxyInterface', 'directInterface']) if (typeof result[key] !== 'string' || (result[key] && !ifacePattern.test(result[key]))) throw Error('无效的网口名称')
  return result
}
export async function interfaces() {
  const addresses = os.networkInterfaces()
  const names = await fs.readdir('/sys/class/net').catch(() => Object.keys(addresses))
  return Promise.all(names.filter(n => n !== 'lo').map(async name => ({ name, addresses: (addresses[name] || []).map(a => a.address), state: (await fs.readFile(`/sys/class/net/${name}/operstate`, 'utf8').catch(() => 'unknown')).trim() })))
}
export function validateInterfaces(s, available) {
  if (!s.enabled) return
  for (const name of [s.proxyInterface, s.directInterface]) {
    const info = available.find(i => i.name === name)
    if (!info || !info.addresses.length || ['down', 'notpresent', 'lowerlayerdown'].includes(info.state)) throw Error(`网口 ${name || '未选择'} 尚未就绪；可先停用并保存，接入网口后再启用`)
  }
  if (s.proxyInterface === s.directInterface && !s.singleNicTest) throw Error('Wan1 和 Wan2 相同；单网口验证请明确勾选测试模式')
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
  if (out.endpoints?.length) throw Error('暂不支持含 endpoints 的配置，请先移除独立端点')
  const nodes = out.outbounds || []
  const byTag = new Map(nodes.map(n => [n.tag, n]))
  if (byTag.size !== nodes.length || nodes.some(n => !n.tag)) throw Error('出站标签缺失或重复')
  const groups = new Set(['selector', 'urltest'])
  const virtual = new Set(['selector', 'urltest', 'block', 'dns'])
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
    } else if (!virtual.has(copy.type) && !localDirect(copy)) {
      delete copy.inet4_bind_address; delete copy.inet6_bind_address
      delete copy.bind_interface
      if (copy.detour) copy.detour = viaProxy(copy.detour)
      else copy.bind_interface = s.proxyInterface
    }
    visiting.delete(tag)
    nodes.push(copy)
    return cloneTag
  }
  for (const node of [...nodes]) {
    if (virtual.has(node.type) || localDirect(node)) continue
    if (loopback(node.server)) throw Error('本机代理出口由其他进程转发，无法保证 Wan1 绑定；请改用远程代理节点')
    delete node.inet4_bind_address; delete node.inet6_bind_address
    delete node.bind_interface
    if (node.detour) node.detour = viaProxy(node.detour)
    else node.bind_interface = node.type === 'direct' ? s.directInterface : s.proxyInterface
  }
  // Internal DNS rewrite and dnsmasq sockets must still reach loopback;
  // the default external interface otherwise makes these local dials fail.
  for (const server of out.dns?.servers || []) {
    if (loopback(server.server) && !server.detour) server.bind_interface = 'lo'
  }
  out.route = { ...out.route, auto_detect_interface: false, default_interface: s.directInterface }
  return out
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
  catch (error) { if (error.code !== 'ENOENT') throw error; return settings({ enabled: false, singleNicTest: false }) }
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
export async function prepare(root = ROOT, value, profile) {
  const s = settings(value || await load(root))
  if (!s.enabled) return path.join(root, 'etc/config.json')
  validateInterfaces(s, await interfaces())
  validateProfile(profile || await readProfile(root))
  const config = JSON.parse(await fs.readFile(path.join(root, 'etc/config.json'), 'utf8'))
  const candidate = path.join(directory(root), `egress-check-${process.pid}.json`)
  try {
    await atomic(candidate, JSON.stringify(transform(config, s), null, 2))
    await exec(path.join(root, 'bin/sing-box'), ['check', '-c', candidate, '-D', path.join(root, 'data')], { timeout: 30000, maxBuffer: 256 * 1024 })
    const runtime = path.join(directory(root), 'egress-runtime.json')
    await fs.rename(candidate, runtime)
    return runtime
  } finally { await fs.rm(candidate, { force: true }) }
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

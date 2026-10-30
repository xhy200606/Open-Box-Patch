import fs from 'node:fs/promises'
import path from 'node:path'
import { ROOT, directory, settings, interfaces, validateInterfaces, validateProfile, load, atomic, prepare, hook, restartKernel, runtimeState, summary, startupError, hookState } from './egress.mjs'

import { applyRouting, routingStatus, createRoutingManager } from './egress-routing.mjs'

let busy = false
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 等待内核真正跑在分流配置上（包装脚本准备配置需要时间）。 */
async function waitForRuntime(tries = 20) {
  let state = await runtimeState(ROOT)
  for (let attempt = 0; attempt < tries && state.supported && !state.active; attempt++) {
    await sleep(1000)
    state = await runtimeState(ROOT)
  }
  return state
}

/**
 * 「分流是否真的生效」：运行配置通过静态校验，且（在能检查进程的平台上）
 * 内核进程确实跑在这份配置上。
 */
async function verifiedSplit() {
  const detail = await summary(ROOT).catch(() => null)
  if (!detail?.verify?.ok) return { ok: false, detail }
  const state = await runtimeState(ROOT)
  if (!state.supported) return { ok: true, detail, state }
  return { ok: state.active || (await waitForRuntime()).active, detail, state }
}

export async function egressStatus() {
  const active = await load()
  let draft = active
  try { draft = settings(JSON.parse(await fs.readFile(path.join(directory(ROOT), 'egress-draft.json'), 'utf8'))) } catch (error) { if (error.code !== 'ENOENT') throw error }
  let lastApply = null
  try { lastApply = JSON.parse(await fs.readFile(path.join(directory(ROOT), 'egress-result.json'), 'utf8')) } catch {}
  const [runtime, detail, error, hookInfo, routing] = await Promise.all([
    runtimeState(ROOT).catch(() => ({ active: false, runtimeFile: null, pid: null, processes: [] })),
    summary(ROOT).catch(() => null),
    startupError(ROOT).catch(() => null),
    hookState(ROOT).catch(() => ({ platform: 'unknown', active: false })),
    routingStatus(active, ROOT),
  ])
  // 「分流真的生效」= 已启用 + 运行配置通过静态校验 + 内核进程正跑在这份配置上
  const splitActive = active.enabled && Boolean(detail?.verify?.ok) && (runtime.supported === false || runtime.active) && (!active.routing?.automatic || routing.healthy)
  return {
    ok: true,
    active,
    draft,
    interfaces: await interfaces(),
    busy,
    lastApply,
    runtime,
    summary: detail,
    startupError: active.enabled ? error : null,
    hook: hookInfo,
    splitActive,
    routing,
  }
}

export async function egressChange(action, value, api) {
  if (busy) throw Error('正在应用出口分流，请稍后再试')
  busy = true
  try {
    const s = settings(value)
    if (action === 'save') {
      await atomic(path.join(directory(ROOT), 'egress-draft.json'), JSON.stringify(s))
      return { ok: true, message: '草稿已保存，尚未应用', ...await egressStatus() }
    }
    if (action !== 'apply') throw Error('invalid-egress-action')
    const old = await load()
    validateInterfaces(s, await interfaces())
    const { profile } = await api('/api/openbox/profile')
    if (!profile || typeof profile !== 'object') throw Error('无法读取原生网络设置，未应用')
    if (s.enabled) {
      validateProfile({ ...profile, directBypass: false })
      if (s.routing?.automatic) {
        const routes = await routingStatus(s, ROOT)
        if (!routes.supported || routes.planError || routes.plans.length !== 2) throw Error(routes.error || routes.planError || '无法生成双出口路由计划')
      }
      // 生成并静态校验运行配置：不通过就直接拒绝，不写配置、不重启内核
      await prepare(ROOT, s, { ...profile, directBypass: false }, { configureRoutes: false })
    }
    async function deployAndRestart() {
      await api('/api/openbox/deploy', {}, 'POST')
      // Native deploy can skip restart when its original config hash is
      // unchanged. Interface-only changes still require the new wrapper config.
      await api('/api/openbox/service/core/restart', {}, 'POST')
      for (let attempt = 0; attempt < 8; attempt++) {
        const status = await api('/api/openbox/service/status')
        if (status.core?.running) return
        await sleep(1000)
      }
      throw Error('内核重启后未运行')
    }
    const priorService = await api('/api/openbox/service/status')
    if (typeof priorService.core?.running !== 'boolean') throw Error('无法确认内核状态，未应用')
    let profileChanged = false, serviceChanged = false
    try {
      await atomic(path.join(directory(ROOT), 'egress.json'), JSON.stringify(s))
      serviceChanged = true
      await hook(ROOT, !s.enabled)
      if (s.enabled && profile.directBypass !== false) {
        // Mark before the request: even a lost response may have changed it.
        profileChanged = true
        await api('/api/openbox/profile', { directBypass: false }, 'PUT')
      }
      await applyRouting(s, ROOT)
      await deployAndRestart()
      // 关键一步：确认内核真的用了分流配置。面板的重启接口有可能直接拉起原生
      // sing-box（绕过包装脚本），那样"应用成功"其实等于没分流。
      let runtime = s.enabled ? await runtimeState(ROOT) : { supported: true, active: false }
      if (s.enabled && runtime.supported && !runtime.active) {
        runtime = await waitForRuntime()
        if (!runtime.active) {
          await restartKernel().catch(() => {})
          runtime = await waitForRuntime()
        }
      }
      if (s.enabled) {
        const detail = await summary(ROOT).catch(() => null)
        if (!detail?.verify?.ok) throw Error('运行配置未通过分流校验：' + (detail?.verify?.problems || ['无法读取运行配置']).join('；'))
        if (s.routing?.automatic) {
          await applyRouting(s, ROOT)
          const routes = await routingStatus(s, ROOT)
          if (!routes.healthy) throw Error(routes.error || routes.planError || '内核重启后自动路由校验未通过')
        }
        if (runtime.supported && !runtime.active) {
          const failure = await startupError(ROOT).catch(() => null)
          throw Error(failure?.message ? '分流未生效，内核已拒绝启动：' + failure.message : '内核没有运行在分流配置上（启动方式可能绕过了包装脚本），已停止内核')
        }
      }
      await atomic(path.join(directory(ROOT), 'egress-draft.json'), JSON.stringify(s))
      const result = { ok: true, at: new Date().toISOString(), message: s.enabled ? `出口分流已应用并校验通过：代理 ${s.proxyInterface} / 直连 ${s.directInterface}` : '出口分流已停用；直连绕过可在原生设置重新开启' }
      await atomic(path.join(directory(ROOT), 'egress-result.json'), JSON.stringify(result))
      return result
    } catch (error) {
      const failures = []
      try { await atomic(path.join(directory(ROOT), 'egress.json'), JSON.stringify(old)); await hook(ROOT, !old.enabled) } catch (e) { failures.push(e.message) }
      try { await applyRouting(old, ROOT) } catch (e) { failures.push('路由回退失败：' + e.message) }
      if (profileChanged) try { await api('/api/openbox/profile', { directBypass: profile.directBypass ?? true }, 'PUT') } catch (e) { failures.push(e.message) }
      // 回退之后只有「仍是已验证的分流」才允许内核继续运行；否则停掉内核，
      // 避免面板显示失败、流量却已经从错误的出口出去了。
      let restored = false
      if (serviceChanged && old.enabled) {
        try {
          await prepare(ROOT, old, { ...profile, directBypass: false })
          await deployAndRestart()
          restored = (await verifiedSplit()).ok
          if (!restored) failures.push('回退后的分流配置同样未生效')
        } catch (e) { failures.push('回退失败：' + e.message) }
      }
      if (serviceChanged && !restored) {
        try { await api('/api/openbox/service/core/stop', {}, 'POST') } catch (e) { failures.push(e.message) }
        if (priorService.core.autostart === false) try { await api('/api/openbox/service/core/disable', {}, 'POST') } catch (e) { failures.push(e.message) }
      }
      const tail = restored ? '已回退到之前的分流配置' : '内核已停止（分流未通过校验，不启动以免流量走错出口）'
      const result = { ok: false, at: new Date().toISOString(), message: `应用失败：${error.stderr || error.message}；${failures.length ? '回退未完成：' + failures.join('；') : tail}` }
      await atomic(path.join(directory(ROOT), 'egress-result.json'), JSON.stringify(result))
      throw Error(result.message)
    }
  } finally { busy = false }
}

// Refresh DHCP/PPP gateways and connected prefixes without changing main,
// then probe the direct uplink and fall back to the proxy uplink if it is dead.
export async function maintainEgressRouting() {
  if (busy) return
  const s = await load()
  await applyRouting(s, ROOT)
  try { await createRoutingManager(ROOT).maintain(s) }
  catch (error) { console.warn('[出口回退] ' + error.message) }
}

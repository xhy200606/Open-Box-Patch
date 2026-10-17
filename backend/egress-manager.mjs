import fs from 'node:fs/promises'
import path from 'node:path'
import { ROOT, directory, settings, interfaces, validateInterfaces, validateProfile, load, atomic, prepare, hook } from './egress.mjs'
let busy = false
export async function egressStatus() {
  const active = await load()
  let draft = active
  try { draft = settings(JSON.parse(await fs.readFile(path.join(directory(ROOT), 'egress-draft.json'), 'utf8'))) } catch (error) { if (error.code !== 'ENOENT') throw error }
  let lastApply = null
  try { lastApply = JSON.parse(await fs.readFile(path.join(directory(ROOT), 'egress-result.json'), 'utf8')) } catch {}
  return { ok: true, active, draft, interfaces: await interfaces(), busy, lastApply }
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
      await prepare(ROOT, s, { ...profile, directBypass: false })
    }
    async function deployAndRestart() {
      await api('/api/openbox/deploy', {}, 'POST')
      // Native deploy can skip restart when its original config hash is
      // unchanged. Interface-only changes still require the new wrapper config.
      await api('/api/openbox/service/core/restart', {}, 'POST')
      for (let attempt = 0; attempt < 8; attempt++) {
        const status = await api('/api/openbox/service/status')
        if (status.core?.running) return
        await new Promise(resolve => setTimeout(resolve, 1000))
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
      await deployAndRestart()
      await atomic(path.join(directory(ROOT), 'egress-draft.json'), JSON.stringify(s))
      const result = { ok: true, at: new Date().toISOString(), message: s.enabled ? (s.singleNicTest ? '已应用单网口测试配置；未实现物理出口隔离' : '出口分流已应用') : '出口分流已停用；直连绕过可在原生设置重新开启' }
      await atomic(path.join(directory(ROOT), 'egress-result.json'), JSON.stringify(result))
      return result
    } catch (error) {
      const failures = []
      try { await atomic(path.join(directory(ROOT), 'egress.json'), JSON.stringify(old)); await hook(ROOT, !old.enabled) } catch (e) { failures.push(e.message) }
      if (profileChanged) try { await api('/api/openbox/profile', { directBypass: profile.directBypass ?? true }, 'PUT') } catch (e) { failures.push(e.message) }
      if (serviceChanged) try { await deployAndRestart() } catch (e) { failures.push(e.message) }
      // Native deploy enables/starts the core. A failed attempt must also
      // restore an originally stopped or disabled service.
      if (serviceChanged && !priorService.core.running) try { await api('/api/openbox/service/core/stop', {}, 'POST') } catch (e) { failures.push(e.message) }
      if (serviceChanged && priorService.core.autostart === false) try { await api('/api/openbox/service/core/disable', {}, 'POST') } catch (e) { failures.push(e.message) }
      const result = { ok: false, at: new Date().toISOString(), message: `应用失败：${error.stderr || error.message}；${failures.length ? '回退未完成：' + failures.join('；') : '已恢复之前配置'}` }
      await atomic(path.join(directory(ROOT), 'egress-result.json'), JSON.stringify(result))
      throw Error(result.message)
    }
  } finally { busy = false }
}

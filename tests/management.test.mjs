import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const repo = new URL('../', import.meta.url)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function listen(handler) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

test('multi-server versions, authenticated updates, target isolation and Patch jobs', async t => {
  const updateCalls = []
  function panel(version, session) {
    return async (req, res) => {
      const authorized = (req.headers.cookie || '').includes(session)
      const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (req.url === '/api/health') return json(200, { ok: true })
      if (req.url === '/api/auth/status') return json(200, { enabled: true, authenticated: authorized })
      if (req.url === '/api/auth/login') {
        let body = ''; for await (const chunk of req) body += chunk
        if (JSON.parse(body).password !== 'correct') return json(401, {})
        res.setHeader('Set-Cookie', `openbox_access_session=${session}; Path=/; HttpOnly`)
        return json(200, { ok: true })
      }
      if (!authorized) return json(401, { message: 'unauthorized' })
      if (req.url === '/api/openbox/update/status') return json(200, { version, status: { running: false } })
      if (req.url === '/api/openbox/service/status') return json(200, { core: { running: true, uptimeSeconds: 100 } })
      if (req.url === '/api/controller/proxies') return json(200, { selectedPolicy: version })
      if (req.url === '/api/openbox/update/run') {
        let body = ''; for await (const chunk of req) body += chunk
        updateCalls.push({ version, body: JSON.parse(body) })
        return json(200, { ok: true })
      }
      json(404, {})
    }
  }
  const first = await listen(panel('v1.0.0', 'first-session'))
  const second = await listen(panel('v2.0.0', 'second-session'))
  const upgradedSockets = []
  let upgradeHeaders
  second.server.on('upgrade', (req, socket) => {
    upgradedSockets.push(socket)
    upgradeHeaders = req.headers
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Test-Backend: second\r\n\r\n')
  })
  const agent = await listen((req, res) => {
    if (req.headers['x-mb-token'] !== 'remote-token') { res.writeHead(401); res.end('{}'); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, patchVersion: '2.1.0', update: { state: 'idle', running: false } }))
  })
  const reserve = await listen((req, res) => res.end())
  const port = reserve.server.address().port
  await new Promise(resolve => reserve.server.close(resolve))
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-patch-test-'))
  const dir = path.join(root, 'data/multi-backend')
  await fs.mkdir(dir, { recursive: true })
  for (const file of ['proxy.mjs', 'patch-manager.mjs', 'version.json']) await fs.copyFile(new URL(file, repo), path.join(dir, file))
  // Never run an installer in the test: the detached worker records completion.
  await fs.writeFile(path.join(dir, 'update-patch.sh'), '#!/bin/sh\nsleep 0.3\nprintf succeeded > "$2/state"\nrm -f "$3/pid"\nrmdir "$3"\n')
  const proxy = spawn(process.execPath, [path.join(dir, 'proxy.mjs')], {
    env: { ...process.env, OPENBOX_MB_PORT: String(port), OPENBOX_MB_BIND: '127.0.0.1', OPENBOX_MB_PANEL: first.url, OPENBOX_MB_TOKEN: '', OPENBOX_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    proxy.kill(); await once(proxy, 'exit').catch(() => {})
    for (const socket of upgradedSockets) socket.destroy()
    for (const item of [first, second, agent]) { item.server.closeAllConnections(); await new Promise(resolve => item.server.close(resolve)) }
    await fs.rm(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/mb/health')).ok) break } catch {} await delay(50) }
  async function post(endpoint, body, headers = {}) {
    const r = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { code: r.status, data: await r.json() }
  }
  const backend = { url: second.url, password: 'correct', agentUrl: agent.url, agentToken: 'remote-token' }
  const status = await post('/api/mb/server', { ...backend, action: 'status' })
  assert.equal(status.data.openbox.version, 'v2.0.0')
  assert.equal(status.data.patch.patchVersion, '2.1.0')
  assert.equal(status.data.agentAvailable, true)
  const bad = await post('/api/mb/server', { ...backend, password: 'wrong', action: 'updateOpenbox' })
  assert.equal(bad.code, 401)
  assert.equal(updateCalls.length, 0)
  const good = await post('/api/mb/server', { ...backend, action: 'updateOpenbox', channel: 'mirror' })
  assert.equal(good.code, 200)
  assert.deepEqual(updateCalls, [{ version: 'v2.0.0', body: { channel: 'mirror' } }])
  const encoded = Buffer.from(second.url).toString('base64url')
  const preflight = await fetch(base + '/__mb/target/' + encoded + '/api/controller/proxies', {
    method: 'OPTIONS', headers: { Origin: first.url, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), first.url)
  const route = await fetch(base + '/__mb/target/' + encoded + '/api/controller/proxies', { headers: { Origin: first.url } })
  assert.equal(route.headers.get('access-control-allow-origin'), first.url)
  assert.equal((await route.json()).selectedPolicy, 'v2.0.0')
  const upgraded = await new Promise((resolve, reject) => {
    const request = http.request(base + '/__mb/target/' + encoded + '/api/controller-ws/connections', {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', Origin: first.url },
    })
    request.once('upgrade', (res, socket) => { socket.destroy(); resolve(res.headers['x-test-backend']) })
    request.once('error', reject)
    request.setTimeout(5000, () => request.destroy(new Error('websocket timeout')))
    request.end()
  })
  assert.equal(upgraded, 'second')
  assert.equal(upgradeHeaders.origin, second.url)
  assert.equal(upgradeHeaders.cookie, 'openbox_access_session=second-session')
  const denied = await post('/api/mb/agent/update', { channel: 'mirror' })
  assert.equal(denied.code, 401)
  const permitted = await post('/api/mb/agent/update', { channel: 'mirror' }, { Cookie: 'openbox_access_session=first-session' })
  assert.equal(permitted.code, 202)
  const duplicate = await post('/api/mb/agent/update', { channel: 'mirror' }, { Cookie: 'openbox_access_session=first-session' })
  assert.equal(duplicate.code, 409)
  await delay(500)
  assert.equal((await (await fetch(base + '/api/mb/agent/status')).json()).update.state, 'succeeded')
})

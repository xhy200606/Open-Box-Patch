#!/usr/bin/env node
/*
 * Open-Box 多后端管理补丁 · 后端代理服务
 * ---------------------------------------------------------------
 * 为什么需要它：Open-Box 面板只认 Cookie 会话、且未开 CORS，浏览器无法跨域
 * 认证到另一台 Open-Box 面板。本服务在服务端用密码 POST /api/auth/login 登录
 * 目标后端，持有其会话 Cookie，再代为读取状态（在线 / 版本 / 内核运行时长），
 * 从而做到「输入密码才可认证」与多后端状态聚合。
 *
 * 零第三方依赖，仅用 Node 内置模块（随包 Node 24，global fetch 可用）。
 *
 * 环境变量：
 *   OPENBOX_MB_PORT    监听端口，默认 3037
 *   OPENBOX_MB_BIND    监听地址，默认 0.0.0.0（局域网可访问）
 *   OPENBOX_MB_TOKEN   可选；设置后要求请求头 X-MB-Token 匹配
 *   OPENBOX_MB_TIMEOUT 单次上游请求超时（毫秒），默认 6000
 *
 * 接口：
 *   GET  /api/mb/health            服务自检
 *   POST /api/mb/status  {url,password}  登录并聚合状态
 *   OPTIONS *                       CORS 预检
 *
 * 安全说明：本服务接受任意 http(s) url 并代为请求，仅面向可信局域网部署；
 * 如需限制，请设置 OPENBOX_MB_TOKEN 并在面板注入脚本的代理设置里填写同一值。
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { URL } from 'node:url'

const PORT = Number(process.env.OPENBOX_MB_PORT || 3037)
const BIND = process.env.OPENBOX_MB_BIND || '0.0.0.0'
const TOKEN = process.env.OPENBOX_MB_TOKEN || ''
const TIMEOUT = Number(process.env.OPENBOX_MB_TIMEOUT || 6000)
const SESSION_TTL = 20 * 60 * 1000 // 会话缓存 20 分钟
const MAX_BODY = 64 * 1024

/** origin -> { cookie, passwordTag, expiresAt } */
const sessions = new Map()

// 简单按 IP 限流，抑制把本服务当密码爆破口/端口扫描器
const RATE_WINDOW = 60 * 1000
const RATE_MAX = 60
const rateHits = new Map() // ip -> number[]
function rateLimited(ip) {
  const now = Date.now()
  const arr = (rateHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW)
  arr.push(now)
  rateHits.set(ip, arr)
  return arr.length > RATE_MAX
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-MB-Token',
  'Access-Control-Max-Age': '600',
}

function sendJson(res, code, body) {
  const data = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...CORS,
  })
  res.end(data)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 规范化后端地址：补协议、去尾部斜杠；只允许 http/https */
function normalizeBase(raw) {
  let s = String(raw || '').trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s
  let u
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
}

async function req(url, opts = {}, timeout = TIMEOUT) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

/** GET 并解析 JSON，失败返回 null */
async function safeJson(url, headers) {
  try {
    const r = await req(url, { headers })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

const tagOf = (p) => crypto.createHash('sha256').update(String(p)).digest('hex').slice(0, 16)

async function doLogin(base, password) {
  let r
  try {
    r = await req(
      `${base}/api/auth/login`,
      {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      },
    )
  } catch (e) {
    return { ok: false, reason: 'unreachable' }
  }
  if (r.status === 401) return { ok: false, reason: 'bad-password' }
  if (!r.ok) return { ok: false, reason: `login-http-${r.status}` }
  const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []
  const raw = setCookies.length ? setCookies : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')] : [])
  const cookie = (raw[0] || '').split(';')[0]
  if (!cookie) return { ok: false, reason: 'no-session-cookie' }
  return { ok: true, cookie }
}

async function ensureSession(base, password) {
  const now = Date.now()
  const cached = sessions.get(base)
  if (cached && cached.passwordTag === tagOf(password) && cached.expiresAt > now) {
    return { cookie: cached.cookie }
  }
  const r = await doLogin(base, password)
  if (!r.ok) return { cookie: '', reason: r.reason }
  sessions.set(base, { cookie: r.cookie, passwordTag: tagOf(password), expiresAt: now + SESSION_TTL })
  return { cookie: r.cookie }
}

/** 聚合：可达性 → 认证 → 状态 */
async function statusOf(rawUrl, password) {
  const base = normalizeBase(rawUrl)
  if (!base) return { online: false, error: 'invalid-url' }
  const pw = typeof password === 'string' ? password : ''

  // 1) 可达性：/api/health 免鉴权
  try {
    await req(`${base}/api/health`, {}, Math.min(TIMEOUT, 4000))
  } catch {
    return { online: false }
  }

  // 2) 认证
  let authenticated = false
  let cookie = ''
  if (pw) {
    const s = await ensureSession(base, pw)
    if (s.cookie) {
      authenticated = true
      cookie = s.cookie
    } else {
      const st = await safeJson(`${base}/api/auth/status`)
      if (st && st.enabled === false) {
        authenticated = true // 该面板未设密码，无需登录
      } else {
        return { online: true, authenticated: false, reason: s.reason || 'bad-password' }
      }
    }
  } else {
    const st = await safeJson(`${base}/api/auth/status`)
    if (st && st.enabled === false) authenticated = true
  }
  if (!authenticated) return { online: true, authenticated: false }

  // 3) 状态聚合（都不出网）
  const headers = cookie ? { Cookie: cookie } : {}
  const [upd, svc] = await Promise.all([
    safeJson(`${base}/api/openbox/update/status`, headers),
    safeJson(`${base}/api/openbox/service/status`, headers),
  ])
  const out = { online: true, authenticated: true }
  if (upd) {
    out.version = upd.version || ''
    out.singboxVersion = upd.singboxVersion || ''
  }
  if (svc) {
    out.coreRunning = Boolean(svc.core && svc.core.running)
    out.uptimeSeconds =
      svc.core && Number.isFinite(svc.core.uptimeSeconds) ? svc.core.uptimeSeconds : null
    out.platform = svc.platform || ''
    out.osRelease = svc.osRelease || ''
    out.arch = svc.arch || ''
  }
  return out
}

/** 清理过期会话 */
function sweepSessions() {
  const now = Date.now()
  for (const [k, v] of sessions) if (!v || v.expiresAt <= now) sessions.delete(k)
}
setInterval(sweepSessions, 5 * 60 * 1000).unref?.()

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname.replace(/\/{2,}/g, '/')

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }

  // 可选 token 校验
  if (TOKEN && req.headers['x-mb-token'] !== TOKEN) {
    sendJson(res, 401, { ok: false, error: 'unauthorized' })
    return
  }

  if (req.method === 'GET' && (path === '/api/mb/health' || path === '/health')) {
    sendJson(res, 200, { ok: true, service: 'openbox-mb-proxy', version: '1.0.0' })
    return
  }

  if (req.method === 'POST' && path === '/api/mb/status') {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown'
    if (rateLimited(ip)) {
      sendJson(res, 429, { ok: false, error: 'rate-limited' })
      return
    }
    let body
    try {
      body = JSON.parse((await readBody(req)) || '{}')
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad-json' })
      return
    }
    try {
      const result = await statusOf(body.url, body.password)
      sendJson(res, 200, result)
    } catch (e) {
      sendJson(res, 200, { online: false, error: 'internal' })
    }
    return
  }

  sendJson(res, 404, { ok: false, error: 'not-found' })
})

server.listen(PORT, BIND, () => {
  console.log(`[openbox-mb-proxy] listening on http://${BIND}:${PORT}${TOKEN ? ' (token required)' : ''}`)
})

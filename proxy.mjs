#!/usr/bin/env node
/*
 * Open-Box 多后端管理补丁 · 后端代理服务
 * ---------------------------------------------------------------
 * 为什么需要它：Open-Box 面板只认 Cookie 会话（openbox_access_session）、且未开 CORS，
 * 浏览器既无法跨域认证到另一台面板，也无法在 iframe 里带着目标面板的 Cookie
 * （跨站下 SameSite=Lax 的 Cookie 不会随 iframe 请求发出）。本服务同时解决两件事：
 *
 *   1) 状态聚合：用密码在服务端 POST /api/auth/login 登录目标后端，代为读取
 *      在线 / 版本 / 内核运行时长（对应「输入密码才可认证」）。
 *   2) 原地显示：把目标面板**反向代理**到本服务的根路径下（/），让当前页面用一个
 *      同站 iframe 直接把目标面板渲染出来 —— 顶层网页地址完全不变。
 *      会话 Cookie 只存在于服务端；浏览器拿到的是重写过的响应。
 *
 * 零第三方依赖，仅用 Node 内置模块（随包 Node 24）。
 *
 * 环境变量：
 *   OPENBOX_MB_PORT    监听端口，默认 3037
 *   OPENBOX_MB_BIND    监听地址，默认 0.0.0.0（局域网可访问）
 *   OPENBOX_MB_TOKEN   可选；设置后要求 /api/mb/* 请求头 X-MB-Token 匹配
 *   OPENBOX_MB_TIMEOUT 单次上游请求超时（毫秒），默认 6000
 *
 * 接口：
 *   GET  /api/mb/health                        服务自检
 *   POST /api/mb/status  {url,password}         登录并聚合状态（同时为该后端建立服务端会话）
 *   GET  /__mb/open?t=<base64url(目标地址)>      把当前浏览器会话绑定到该后端，302 到 /
 *   GET  /__mb/close                           解绑当前会话
 *   <其它任意路径>                               反向代理到当前绑定的后端
 *   WS   <任意路径>                             反向代理 WebSocket（面板的 /api/controller-ws）
 *
 * 安全说明：
 *   · /__mb/open 只接受**已经通过密码认证、服务端存在有效会话**的后端地址，未认证的
 *     任意地址无法被打开，因此本服务不会被当作任意内网 URL 的转发器。
 *   · 拒绝目标为链路本地 / 云元数据地址（169.254.*、fe80::*、0.0.0.0、::）。
 *   · /api/mb/* 支持 OPENBOX_MB_TOKEN 口令；反向代理部分浏览器无法带自定义头，
 *     依赖"必须先认证"这一条。
 *   · 仅面向可信局域网部署。需要收紧时把 OPENBOX_MB_BIND 设为 127.0.0.1 或设置令牌。
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import os from 'node:os'
import crypto from 'node:crypto'
import { URL } from 'node:url'

const PORT = Number(process.env.OPENBOX_MB_PORT || 3037)
const BIND = process.env.OPENBOX_MB_BIND || '0.0.0.0'
const TOKEN = process.env.OPENBOX_MB_TOKEN || ''
const TIMEOUT = Number(process.env.OPENBOX_MB_TIMEOUT || 6000)
const SESSION_TTL = 12 * 60 * 60 * 1000 // 上游会话缓存 12 小时（上游 Cookie 本身 30 天有效）
const MAX_BODY = 64 * 1024

const SESSION_COOKIE = 'openbox_access_session'
const TARGET_COOKIE = 'openbox_mb_target'
const TARGET_COOKIE_MAXAGE = 12 * 60 * 60 // 秒

/** 上游 origin(base) -> { cookie, passwordTag, expiresAt } */
const sessions = new Map()

/* ========================= 通用工具 ========================= */

// 简单按 IP 限流，抑制把本服务当密码爆破口 / 端口扫描器
const RATE_WINDOW = 60 * 1000
const RATE_MAX = 60
const rateHits = new Map()
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

function sendHtml(res, code, title, detail) {
  const data =
    '<!doctype html><meta charset="utf-8"><title>' +
    title +
    '</title><style>body{font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f6f7f9;color:#1f2937}div{max-width:520px;padding:28px 32px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.06)}h1{font-size:16px;margin:0 0 8px}p{margin:0;color:#4b5563;font-size:13px}</style><div><h1>' +
    title +
    '</h1><p>' +
    detail +
    '</p></div>'
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
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

/** 不该被代理到的地址：链路本地 / 云元数据 / 未指定地址 */
function isForbiddenHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === '0.0.0.0' || h === '::' || h === '169.254.169.254') return true
  if (/^169\.254\./.test(h)) return true
  if (/^fe80:/.test(h)) return true
  return false
}

/** 规范化后端地址：补协议、去尾部斜杠；只允许 http/https，且拒绝危险地址 */
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
  if (isForbiddenHost(u.hostname)) return null
  if (!u.port && u.protocol === 'https:') u.port = '443'
  if (!u.port && u.protocol === 'http:') u.port = '80'
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
}

/** 该地址是不是本服务自己（防止把代理当后端再加一次，形成自环） */
function isSelfTarget(base) {
  try {
    const u = new URL(base)
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    if (port !== PORT) return false
    const h = u.hostname.toLowerCase()
    const local = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', BIND, os.hostname().toLowerCase()])
    return local.has(h)
  } catch {
    return false
  }
}

/* ========================= 上游请求 ========================= */

async function req(url, opts = {}, timeout = TIMEOUT) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

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

function sessionCookieOf(headers) {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  const list = raw.length ? raw : headers.get('set-cookie') ? [headers.get('set-cookie')] : []
  for (const c of list) {
    const m = new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]*)').exec(c)
    if (m) return SESSION_COOKIE + '=' + m[1]
  }
  return ''
}

async function doLogin(base, password) {
  let r
  try {
    r = await req(`${base}/api/auth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
  if (r.status === 401) return { ok: false, reason: 'bad-password' }
  if (!r.ok) return { ok: false, reason: `login-http-${r.status}` }
  const cookie = sessionCookieOf(r.headers)
  if (!cookie) return { ok: false, reason: 'no-session-cookie' }
  return { ok: true, cookie }
}

function rememberSession(base, cookie, password) {
  sessions.set(base, {
    cookie: cookie || '',
    passwordTag: tagOf(password || ''),
    expiresAt: Date.now() + SESSION_TTL,
  })
}

async function ensureSession(base, password) {
  const now = Date.now()
  const cached = sessions.get(base)
  if (cached && cached.passwordTag === tagOf(password) && cached.expiresAt > now) {
    return { cookie: cached.cookie }
  }
  const r = await doLogin(base, password)
  if (!r.ok) return { cookie: '', reason: r.reason }
  rememberSession(base, r.cookie, password)
  return { cookie: r.cookie }
}

/**
 * 聚合：可达性 → 认证 → 状态。
 * 认证成功后会在服务端留下会话，反向代理（原地显示）依赖它来判断该地址"已被授权打开"。
 */
async function statusOf(rawUrl, password) {
  const base = normalizeBase(rawUrl)
  if (!base) return { online: false, error: 'invalid-url' }
  if (isSelfTarget(base)) return { online: false, error: 'self-target' }
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
        rememberSession(base, '', '')
      } else {
        return { online: true, authenticated: false, reason: s.reason || 'bad-password' }
      }
    }
  } else {
    const st = await safeJson(`${base}/api/auth/status`)
    if (st && st.enabled === false) {
      authenticated = true
      rememberSession(base, '', '')
    }
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

/* ========================= 反向代理（原地显示） ========================= */

// 逐跳头：转发时要去掉
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
])

function cookieValue(header, name) {
  if (!header) return ''
  const re = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)')
  const m = re.exec(header)
  return m ? m[1] : ''
}

/**
 * 取本次请求要代理到的后端。
 * 只认「浏览器 Cookie 指定的地址」且「服务端已为其建立有效会话」——未认证的地址打不开。
 */
function pickTarget(req) {
  const raw = cookieValue(req.headers.cookie, TARGET_COOKIE)
  if (!raw) return null
  let decoded = ''
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const base = normalizeBase(decoded)
  if (!base || isSelfTarget(base)) return null
  const sess = sessions.get(base)
  if (!sess || sess.expiresAt <= Date.now()) return null
  return { base, sess }
}

/** 把上游返回的 Location 改写为代理自身 origin 下的路径 */
function rewriteLocation(loc, base) {
  if (!loc) return loc
  try {
    const b = new URL(base)
    const abs = new URL(loc, b.origin + (b.pathname || '/'))
    if (abs.host !== b.host) return loc // 指向别处（如外链）就原样放行
    const prefix = b.pathname.replace(/\/+$/, '')
    let p = abs.pathname
    if (prefix && (p === prefix || p.startsWith(prefix + '/'))) p = p.slice(prefix.length) || '/'
    return p + abs.search + abs.hash
  } catch {
    return loc
  }
}

/** 上游路径 = 目标 base 的路径前缀 + 浏览器请求路径 */
function upstreamPath(base, pathname, search) {
  let prefix = ''
  try {
    prefix = new URL(base).pathname.replace(/\/+$/, '')
  } catch {
    prefix = ''
  }
  return (prefix + pathname).replace(/\/{2,}/g, '/') + (search || '')
}

function buildUpstreamHeaders(req, base, sess) {
  const headers = {}
  const proxyOrigin = `http://${req.headers.host || ''}` // 仅用于改写 Origin/Referer
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k)) continue
    if (k === 'cookie') continue
    if ((k === 'origin' || k === 'referer') && typeof v === 'string' && proxyOrigin) {
      headers[k] = v.split(proxyOrigin).join(base)
      continue
    }
    headers[k] = v
  }
  try {
    headers.host = new URL(base).host
  } catch {
    /* ignore */
  }
  if (sess.cookie) headers.cookie = sess.cookie
  const ip = (req.socket && req.socket.remoteAddress) || ''
  if (ip) headers['x-forwarded-for'] = ip
  headers['x-forwarded-proto'] = 'http'
  return headers
}

function proxyHttp(req, res, target, url) {
  const isHttps = target.base.startsWith('https:')
  const mod = isHttps ? https : http
  let t
  try {
    t = new URL(target.base)
  } catch {
    sendHtml(res, 502, '目标地址无效', '无法解析后端地址。')
    return
  }
  const headers = buildUpstreamHeaders(req, target.base, target.sess)

  let upstream
  try {
    upstream = mod.request(
      {
        protocol: t.protocol,
        hostname: t.hostname,
        port: t.port || (isHttps ? 443 : 80),
        method: req.method,
        path: upstreamPath(target.base, url.pathname, url.search),
        headers,
        rejectUnauthorized: false, // 局域网后端常见自签证书
      },
      (up) => {
        // 捕获上游新下发的会话 Cookie（例如用户在 iframe 里重新登录），不把它交给浏览器
        const setCookies = up.headers['set-cookie']
        if (setCookies) {
          const list = Array.isArray(setCookies) ? setCookies : [setCookies]
          for (const c of list) {
            const m = new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]*)').exec(c)
            if (m) {
              target.sess.cookie = SESSION_COOKIE + '=' + m[1]
              target.sess.expiresAt = Date.now() + SESSION_TTL
            }
          }
        }

        const out = {}
        for (const [k, v] of Object.entries(up.headers)) {
          const lk = k.toLowerCase()
          if (HOP_BY_HOP.has(lk)) continue
          if (lk === 'set-cookie') continue
          out[k] = v
        }
        if (out.location) out.location = rewriteLocation(out.location, target.base)

        res.writeHead(up.statusCode || 502, out)
        if (typeof res.flushHeaders === 'function') res.flushHeaders()
        up.pipe(res)
        up.on('error', () => {
          try {
            res.destroy()
          } catch {
            /* ignore */
          }
        })
      },
    )
  } catch {
    sendHtml(res, 502, '无法连接后端', '请求未能发往 ' + target.base + '。')
    return
  }

  upstream.on('error', () => {
    if (res.headersSent) {
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
      return
    }
    sendHtml(
      res,
      502,
      '后端不可达',
      '无法连接到 ' + target.base + '。请确认该后端在线，然后点击「刷新」。',
    )
  })

  req.on('error', () => {
    try {
      upstream.destroy()
    } catch {
      /* ignore */
    }
  })
  req.pipe(upstream)
}

/* ========================= 请求分发 ========================= */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname.replace(/\/{2,}/g, '/')

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }

  /* ---- 供面板页调用的控制接口（可选用 token 保护）---- */
  if (path.startsWith('/api/mb/') || path === '/health') {
    if (TOKEN && req.headers['x-mb-token'] !== TOKEN) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }

    if (req.method === 'GET' && (path === '/api/mb/health' || path === '/health')) {
      sendJson(res, 200, { ok: true, service: 'openbox-mb-proxy', version: '2.0.0', targets: sessions.size })
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
        sendJson(res, 200, await statusOf(body.url, body.password))
      } catch {
        sendJson(res, 200, { online: false, error: 'internal' })
      }
      return
    }

    sendJson(res, 404, { ok: false, error: 'not-found' })
    return
  }

  /* ---- iframe 的入口：把浏览器会话绑定到一个已认证后端，然后 302 到根路径 ---- */
  if (req.method === 'GET' && path === '/__mb/open') {
    const raw = url.searchParams.get('t') || ''
    let base = ''
    try {
      base = normalizeBase(Buffer.from(raw, 'base64url').toString('utf8'))
    } catch {
      base = ''
    }
    if (!base || isSelfTarget(base)) {
      sendHtml(res, 400, '后端地址无效', '请回到面板，从「后端」列表里重新点击要查看的后端。')
      return
    }
    const sess = sessions.get(base)
    if (!sess || sess.expiresAt <= Date.now()) {
      sendHtml(
        res,
        403,
        '该后端尚未通过认证',
        '请回到面板，在左下角「后端」列表里点击 ' +
          base +
          ' 并输入密码完成认证后重试。',
      )
      return
    }
    res.writeHead(302, {
      // HttpOnly：浏览器 Cookie 不按端口隔离，若不加这条，同主机上面板页的 JS 也能读到它。
      // 它只编码目标地址（非凭据），但没必要暴露给页面脚本。
      'Set-Cookie':
        TARGET_COOKIE +
        '=' +
        raw +
        '; Path=/; Max-Age=' +
        TARGET_COOKIE_MAXAGE +
        '; HttpOnly; SameSite=Lax',
      Location: '/',
      'Cache-Control': 'no-store',
    })
    res.end()
    return
  }

  if (req.method === 'GET' && path === '/__mb/close') {
    res.writeHead(302, {
      'Set-Cookie': TARGET_COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      Location: '/',
      'Cache-Control': 'no-store',
    })
    res.end()
    return
  }

  /* ---- 其余全部反向代理到当前绑定的后端 ---- */
  const target = pickTarget(req)
  if (!target) {
    sendHtml(
      res,
      403,
      '未选择后端',
      '这个地址是 Open-Box 多后端管理补丁的代理入口。请从面板左下角的「后端」列表里选择要查看的后端。',
    )
    return
  }
  proxyHttp(req, res, target, url)
})

/* ---- WebSocket 反向代理（面板实时数据走 /api/controller-ws） ---- */
server.on('upgrade', (req, socket, head) => {
  let url
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  } catch {
    socket.destroy()
    return
  }
  if (url.pathname.startsWith('/api/mb/') || url.pathname.startsWith('/__mb/')) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  const target = pickTarget(req)
  if (!target) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  const isHttps = target.base.startsWith('https:')
  let t
  try {
    t = new URL(target.base)
  } catch {
    socket.destroy()
    return
  }

  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'cookie' || k === 'host') continue
    headers[k] = v
  }
  headers.host = t.host
  if (target.sess.cookie) headers.cookie = target.sess.cookie

  const up = isHttps
    ? tls.connect({
        host: t.hostname,
        port: Number(t.port || 443),
        rejectUnauthorized: false,
        servername: t.hostname,
      })
    : net.connect({ host: t.hostname, port: Number(t.port || 80) })

  const fail = () => {
    try {
      socket.destroy()
    } catch {
      /* ignore */
    }
    try {
      up.destroy()
    } catch {
      /* ignore */
    }
  }
  up.on('error', fail)
  socket.on('error', fail)
  up.setTimeout(0)
  socket.setTimeout(0)

  up.on('connect', () => {
    let raw = `${req.method} ${upstreamPath(target.base, url.pathname, url.search)} HTTP/1.1\r\n`
    for (const [k, v] of Object.entries(headers)) {
      raw += Array.isArray(v) ? v.map((x) => `${k}: ${x}\r\n`).join('') : `${k}: ${v}\r\n`
    }
    raw += '\r\n'
    up.write(raw)
    if (head && head.length) up.write(head)
    up.pipe(socket)
    socket.pipe(up)
  })
})

server.listen(PORT, BIND, () => {
  console.log(
    `[openbox-mb-proxy] listening on http://${BIND}:${PORT}${TOKEN ? ' (token required)' : ''}`,
  )
})

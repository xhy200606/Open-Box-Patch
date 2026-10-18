import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { parseHTML } from 'linkedom'

const script = await fs.readFile(new URL('../frontend/multi-backend.js', import.meta.url), 'utf8')
const turn = () => new Promise(resolve => setImmediate(resolve))
function store(initial = {}) {
  const values = new Map(Object.entries(initial))
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
}
async function panel(hash = '#/settings?tab=dns', remote = false) {
  // This reproduces the native SettingsPage shell, including the DNS page
  // that has no GitHub/version card. Execute the complete injected script.
  const { window, document } = parseHTML(`<!doctype html><html><body>
    <div id="settings-root"><div class="settings-menu"><ul class="settings-menu-list">
    <li class="settings-menu-slot"><button id="menu-item-dns" data-key="dns" class="settings-menu-btn menu-active">DNS 设置</button></li>
    <li class="settings-menu-slot"><button id="menu-item-kernel" data-key="kernel" class="settings-menu-btn">后端设置</button></li>
    </ul></div><div id="native-content">原生设置内容</div></div>
    </body></html>`)
  let url = new URL('http://panel.test:3036/' + hash)
  const location = { reload() {} }
  for (const key of ['href', 'origin', 'pathname', 'search', 'protocol', 'hostname', 'port']) Object.defineProperty(location, key, { get: () => url[key] })
  Object.defineProperty(location, 'hash', { get: () => url.hash, set: value => {
    if (url.hash === value || url.hash === '#' + value) return
    url.hash = value
    queueMicrotask(() => window.dispatchEvent(new window.Event('hashchange')))
  } })
  const calls = []
  const draft = { enabled: false, singleNicTest: false, proxyInterface: 'wan1', directInterface: 'wan2' }
  const fetch = async (input, init) => {
    let data = { ok: true, authenticated: true, online: true }
    if (String(input).endsWith('/api/mb/server')) {
      const body = JSON.parse(init.body); calls.push(body)
      if (body.action === 'egressStatus') data = { ok: true, active: draft, draft, interfaces: [{ name: 'wan1', addresses: ['192.0.2.2'], state: 'up' }, { name: 'wan2', addresses: [], state: 'down' }] }
      else if (body.action === 'egressSave') data = { ok: true, message: '草稿已保存，尚未应用' }
    }
    return { ok: true, json: async () => data }
  }
  // linkedom deliberately has a read-only select value; supply the standard
  // browser setter so this fixture can exercise the native select controls.
  const selectDescriptor = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')
  if (!selectDescriptor.set) Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true, get: selectDescriptor.get, set(value) {
    for (const option of this.options) option.selected = option.value === value
  } })
  const localStorage = store(remote ? { 'openbox.mb.backends.v2': JSON.stringify([{ uuid: 'remote', label: '服务器二', protocol: 'http', host: '192.0.2.10', port: '3036' }]) } : {})
  const sessionStorage = store(remote ? { 'openbox.mb.active.v2': 'remote' } : {})
  const history = { state: { preserved: true }, replaceState(state, _, value) { assert.equal(state, this.state); url = new URL(value, url) } }
  window.__obMultiBackend = false
  window.fetch = fetch; window.location = location
  window.__obMultiBackend = false
  const observers = []
  const MutationObserver = class extends window.MutationObserver {
    constructor(callback) {
      let count = 0, observer
      super(records => {
        if (++count > 50) { observer.disconnect(); throw Error('Mutation loop: ' + JSON.stringify(records.map(r => ({type:r.type, target:r.target?.id || r.target?.nodeName, added:[...r.addedNodes].map(n=>n.id||n.nodeName), removed:[...r.removedNodes].map(n=>n.id||n.nodeName)})))) }
        callback(records)
      })
      observer = this; observers.push(this)
    }
  }
  const context = vm.createContext({ window, document, localStorage, sessionStorage, location, history, fetch, MutationObserver,
    URL, Request, AbortController, TextEncoder, btoa, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, confirm: () => false })
  vm.runInContext(script, context)
  await turn(); await turn()
  return { window, document, location, calls, close: () => observers.forEach(o => o.disconnect()) }
}

test('egress is a peer menu on DNS settings without a backend GitHub card; native tab restores content', async t => {
  const p = await panel(); t.after(p.close)
  const button = p.document.getElementById('menu-item-egress')
  assert(button, 'entry exists even without the backend card')
  assert.equal(button.closest('li').previousElementSibling.querySelector('button').id, 'menu-item-kernel')
  assert.equal(p.document.getElementById('ob-egress-page'), null)
  button.click(); await turn(); await turn()
  assert.equal(p.location.hash, '#/settings?tab=egress')
  assert(p.document.getElementById('ob-egress-page'))
  assert.equal(p.document.getElementById('native-content').style.display, 'none')
  assert(button.classList.contains('menu-active'))
  assert.equal(p.document.querySelectorAll('.settings-menu-btn.menu-active').length, 1)
  assert(p.document.getElementById('ob-egress-settings').textContent.includes('当前后端：本机'))
  assert.equal(p.calls.filter(c => c.action === 'egressStatus').length, 1)
  // Unrelated native updates must neither duplicate the menu nor reset a draft.
  p.document.getElementById('native-content').appendChild(p.document.createElement('span'))
  await turn()
  assert.equal(p.document.querySelectorAll('#menu-item-egress').length, 1)
  assert.equal(p.calls.filter(c => c.action === 'egressStatus').length, 1)
  p.document.getElementById('menu-item-dns').click(); await turn()
  assert.equal(p.document.getElementById('ob-egress-page'), null)
  assert.equal(p.document.getElementById('native-content').style.display, '')
  assert(!p.location.hash.includes('tab=egress'))
})

test('direct/refresh route opens egress and requests the selected remote backend', async t => {
  const p = await panel('#/settings?tab=egress', true); t.after(p.close)
  assert(p.document.getElementById('ob-egress-page'))
  assert(p.document.getElementById('ob-egress-settings').textContent.includes('服务器二'))
  const request = p.calls.find(c => c.action === 'egressStatus')
  assert.equal(request.isSelf, false)
  assert.equal(request.url, 'http://192.0.2.10:3036')
  const save = Array.from(p.document.querySelectorAll('#ob-egress-settings button')).find(b => b.textContent === '保存草稿')
  assert(save)
  save.click(); await turn(); await turn()
  assert.equal(p.calls.find(c => c.action === 'egressSave').url, request.url)
  assert(p.document.getElementById('ob-egress-settings').textContent.includes('草稿已保存'))
  p.location.hash = '#/proxies'; await turn(); await turn()
  assert.equal(p.document.getElementById('ob-egress-page'), null)
})

test('overview page gets the egress card at the very bottom with live split share', async t => {
  const { window, document } = parseHTML(`<!doctype html><html><body>
    <div class="home-page"><div id="overview-cards" class="flex flex-col gap-2 px-2">
      <section class="card"><h2>面板概览</h2></section>
      <section class="card"><h2>流量洞察</h2></section>
    </div></div>
    </body></html>`)
  const url = new URL('http://panel.test:3036/#/overview')
  const location = { reload() {} }
  for (const key of ['href', 'origin', 'pathname', 'search', 'protocol', 'hostname', 'port']) Object.defineProperty(location, key, { get: () => url[key] })
  Object.defineProperty(location, 'hash', { get: () => url.hash, set: value => { url.hash = value } })
  const draft = { enabled: true, proxyInterface: 'eth3', directInterface: 'br-lan' }
  const fetch = async (input, init) => {
    const target = String(input)
    if (target.endsWith('/api/mb/server')) {
      return { ok: true, json: async () => ({
        ok: true, active: draft, draft, splitActive: true,
        interfaces: [{ name: 'br-lan', addresses: ['192.168.100.2'], state: 'up' }, { name: 'eth3', addresses: ['192.168.2.10'], state: 'up' }],
        summary: { verify: { ok: true, problems: [] }, proxyInterface: 'eth3', directInterface: 'br-lan', defaultInterface: 'br-lan', proxyOutbounds: ['Exit'], directOutbounds: ['DIRECT'] },
        runtime: { supported: true, active: true, pid: 4242 },
        lastApply: { message: '出口分流已应用并校验通过' },
      }) }
    }
    if (target.endsWith('/api/controller/connections')) return { ok: true, json: async () => ({ connections: [
      { chains: ['Exit'], uploadSpeed: 1024, downloadSpeed: 4096, upload: 300, download: 700 },
      { chains: ['DIRECT'], uploadSpeed: 0, downloadSpeed: 1024, upload: 100, download: 100 } ] }) }
    if (target.endsWith('/api/controller/proxies')) return { ok: true, json: async () => ({ proxies: { Exit: { type: 'Shadowsocks' }, DIRECT: { type: 'Direct' } } }) }
    return { ok: true, json: async () => ({ ok: true, authenticated: true }) }
  }
  window.fetch = fetch; window.location = location
  window.__obMultiBackend = false
  const observers = []
  const MutationObserver = class extends window.MutationObserver { constructor(callback) { super(callback); observers.push(this) } }
  const context = vm.createContext({ window, document, localStorage: store(), sessionStorage: store(), location,
    history: { state: {}, replaceState() {} }, fetch, MutationObserver, URL, Request, AbortController, TextEncoder, btoa, console,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, confirm: () => false })
  // 先让 linkedom 解析完成（readyState 不再是 loading），否则脚本会等一个永不触发的 DOMContentLoaded
  await turn()
  vm.runInContext(script, context)
  t.after(() => observers.forEach(o => o.disconnect()))
  for (let i = 0; i < 4; i++) await turn()
  // 概览页的卡片由 SPA 异步渲染；模拟一次 DOM 变动，触发注入脚本的位置校正
  document.getElementById('overview-cards').appendChild(document.createElement('span'))
  for (let i = 0; i < 4; i++) await turn()

  const card = document.getElementById('ob-home-egress')
  assert(card, 'overview page renders the egress card')
  assert.equal(document.getElementById('overview-cards').lastElementChild, card, 'card is the last card')
  const text = card.textContent
  assert.match(text, /分流已生效/)
  assert.match(text, /直连 Wan2：br-lan/)
  assert.match(text, /代理 Wan1：eth3/)
  assert.match(text, /192\.168\.100\.2/)
  // 直连 200B / 代理 1000B → 17% / 83%
  assert.match(text, /17%/)
  assert.match(text, /83%/)
})

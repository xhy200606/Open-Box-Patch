import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { transform, settings, validateInterfaces, validateProfile, hook, prepare, readProfile, runtimeState, verifyConfig } from '../backend/egress.mjs'
const run = promisify(execFile)
const split = { enabled: true, proxyInterface: 'wan1', directInterface: 'wan2' }
const available = ['wan1', 'wan2'].map(name => ({ name, addresses: ['192.0.2.1'], state: 'up' }))

test('binds direct and physical proxy sockets, preserves policy and clones direct detours', () => {
  const original = { outbounds: [
    { type: 'direct', tag: 'DIRECT', inet4_bind_address: '192.0.2.99' },
    { type: 'selector', tag: 'Transport', outbounds: ['DIRECT'], default: 'DIRECT' },
    { type: 'anytls', tag: 'Exit', server: 'example.com', detour: 'Transport' },
    { type: 'hysteria2', tag: 'HY2', server: 'example.org' },
    { type: 'selector', tag: 'Policy', outbounds: ['Exit', 'DIRECT', 'HY2'] },
    { type: 'block', tag: 'BLOCK' },
  ], route: { final: 'Policy', rules: [{ domain: ['local.test'], outbound: 'DIRECT' }] }, dns: { servers: [{ type: 'udp', server: '223.5.5.5' }] } }
  const before = structuredClone(original)
  const output = transform(original, split)
  const by = tag => output.outbounds.find(n => n.tag === tag)
  assert.deepEqual(original, before)
  assert.equal(by('DIRECT').bind_interface, 'wan2')
  assert.equal(by('DIRECT').inet4_bind_address, undefined)
  assert.equal(by('HY2').bind_interface, 'wan1')
  assert.equal(by('Exit').bind_interface, undefined)
  const transport = by(by('Exit').detour)
  assert.notEqual(transport.tag, 'Transport')
  assert.equal(by(transport.outbounds[0]).bind_interface, 'wan1')
  assert.equal(transport.default, transport.outbounds[0])
  assert.deepEqual(by('Policy').outbounds, ['Exit', 'DIRECT', 'HY2'])
  for (const tag of ['Policy', 'Transport', 'BLOCK']) assert.equal(by(tag).bind_interface, undefined)
  assert.deepEqual(output.route.rules, original.route.rules)
  assert.equal(output.route.default_interface, 'wan2')
  assert.deepEqual(output.dns, original.dns)
  assert.deepEqual(transform(original, { ...split, enabled: false }), original)
})

test('returns the fakeip range into the tun so proxied domains cannot leak to the direct exit', () => {
  const original = {
    inbounds: [
      { type: 'tun', tag: 'tun-in', route_address: ['10.0.0.0/8'] },
      { type: 'mixed', tag: 'panel-in', listen_port: 7891 },
    ],
    outbounds: [{ type: 'direct', tag: 'DIRECT' }],
    dns: { servers: [{ type: 'fakeip', tag: 'dns-fakeip', inet4_range: '198.19.0.0/16' }, { type: 'udp', server: '223.5.5.5' }] },
  }
  const output = transform(original, split)
  assert.deepEqual(output.inbounds[0].route_address, ['10.0.0.0/8', '198.19.0.0/16'])
  assert.equal(output.inbounds[1].route_address, undefined)
  // 反复执行不能重复追加
  assert.deepEqual(transform(output, split).inbounds[0].route_address, ['10.0.0.0/8', '198.19.0.0/16'])
  // 没有 fakeip 时不动 tun
  const plain = transform({ inbounds: [{ type: 'tun', route_address: ['10.0.0.0/8'] }], outbounds: [{ type: 'direct', tag: 'DIRECT' }] }, split)
  assert.deepEqual(plain.inbounds[0].route_address, ['10.0.0.0/8'])
})

test('keeps native loopback DNS paths and rejects proxying through another local process', () => {
  const original = { outbounds: [{ type: 'direct', tag: 'DIRECT' }, { type: 'direct', tag: 'dnsmasq', bind_interface: 'lo' }], dns: { servers: [{ type: 'udp', tag: 'rewrite', server: '127.0.0.1', server_port: 7854 }, { type: 'udp', tag: 'direct', server: '223.5.5.5' }] } }
  const output = transform(original, split)
  assert.equal(output.outbounds[0].bind_interface, 'wan2')
  assert.equal(output.outbounds[1].bind_interface, 'lo')
  assert.equal(output.dns.servers[0].bind_interface, 'lo')
  assert.equal(output.dns.servers[1].bind_interface, undefined)
  assert.throws(() => transform({ outbounds: [{ type: 'socks', tag: 'LOCAL', server: '127.0.0.1' }] }, split), /其他进程/)
})

test('rejects absent/down WAN, same NIC, invalid input and bypass escapes', () => {
  validateInterfaces(split, available)
  assert.throws(() => validateInterfaces(split, available.slice(0, 1)), /尚未就绪/)
  assert.throws(() => validateInterfaces(split, available.map(i => ({ ...i, state: 'down' }))), /尚未就绪/)
  // 单网口测试模式已移除：两项选择同一网口一律拒绝，带不带旧的 singleNicTest 字段都一样
  assert.throws(() => validateInterfaces({ ...split, directInterface: 'wan1' }, available), /同一个网口/)
  assert.throws(() => validateInterfaces({ ...split, directInterface: 'wan1', singleNicTest: true }, available), /同一个网口/)
  assert.throws(() => validateInterfaces({ ...split, proxyInterface: '' }, available), /请分别选择/)
  // 旧字段被丢弃，不再写回配置
  assert.deepEqual(settings({ ...split, singleNicTest: true }), split)
  settings({ ...split, enabled: false, directInterface: 'future-wan2' })
  assert.throws(() => settings({ ...split, directInterface: 'wan2;reboot' }), /无效/)
  assert.throws(() => settings({ ...split, enabled: 'true' }), /布尔/)
  validateProfile({ directBypass: false })
  for (const profile of [{}, { directBypass: true }, { directBypass: false, clientRoutes: [{ bypass: true }] }, { directBypass: false, bypassPorts: '22' }, { directBypass: false, bypassPortsMode: 'whitelist' }]) assert.throws(() => validateProfile(profile))
  assert.throws(() => transform({ endpoints: [{}] }, split), /endpoints/)
  assert.throws(() => transform({ outbounds: [{ type: 'socks', tag: 'A', detour: 'B' }, { type: 'socks', tag: 'B', detour: 'A' }] }, split), /循环/)
  assert.throws(() => transform({ outbounds: [{ type: 'socks', tag: 'A', detour: 'missing' }] }, split), /找不到/)
})

test('verifyConfig catches a config that would look applied without splitting', () => {
  const config = { outbounds: [
    { type: 'direct', tag: 'DIRECT', bind_interface: 'wan2' },
    { type: 'socks', tag: 'Proxy', server: '203.0.113.9', bind_interface: 'wan1' },
    { type: 'selector', tag: 'Policy', outbounds: ['Proxy', 'DIRECT'] },
  ], route: { auto_detect_interface: false, default_interface: 'wan2' } }
  assert.deepEqual(verifyConfig(config, split), { ok: true, problems: [] })
  // 两个出口绑到同一个网口 —— 曾经的"单网口测试模式"，实际没有物理分流
  assert.equal(verifyConfig(config, { ...split, directInterface: 'wan1' }).ok, false)
  // 漏绑的出站：会走默认路由，等于绕过分流
  const leaked = structuredClone(config)
  delete leaked.outbounds[1].bind_interface
  assert.match(verifyConfig(leaked, split).problems.join('；'), /未绑定网口/)
  // 默认出口不对
  assert.match(verifyConfig({ ...config, route: { ...config.route, default_interface: 'wan1' } }, split).problems.join('；'), /default_interface/)
  // auto_detect_interface 没关
  assert.match(verifyConfig({ ...config, route: { ...config.route, auto_detect_interface: true } }, split).problems.join('；'), /auto_detect_interface/)
})

test('launcher replay and restore preserve upstream edits and protected files', async t => {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-egress-hook-'))
  t.after(() => fs.rm(stage, { recursive: true, force: true }))
  const init = path.join(stage, 'init'); await fs.mkdir(init)
  const before = process.env.OPENBOX_INITD_DIR; process.env.OPENBOX_INITD_DIR = init
  t.after(() => { if (before === undefined) delete process.env.OPENBOX_INITD_DIR; else process.env.OPENBOX_INITD_DIR = before })
  const original = '#!/bin/sh\nprocd_set_param command "$BIN" run -c "$CONF" -D "$DATA"\n'
  const file = path.join(init, 'openbox')
  await fs.writeFile(file, original)
  await hook(stage); const hooked = await fs.readFile(file, 'utf8')
  assert.match(hooked, /egress-run.sh/)
  await hook(stage); assert.equal(await fs.readFile(file, 'utf8'), hooked)
  await fs.appendFile(file, '# unrelated upstream change\n')
  await hook(stage, true)
  assert.equal(await fs.readFile(file, 'utf8'), original + '# unrelated upstream change\n')
  await fs.writeFile(file, '# unknown upstream format\n')
  await assert.rejects(hook(stage), /不兼容/)
  assert.equal(await fs.readFile(file, 'utf8'), '# unknown upstream format\n')
})

test('real wrapper validates candidate, execs core, and disabled mode uses original config', async t => {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-egress-run-'))
  t.after(() => fs.rm(stage, { recursive: true, force: true }))
  const dir = path.join(stage, 'data/multi-backend')
  for (const folder of [dir, path.join(stage, 'bin'), path.join(stage, 'etc'), path.join(stage, 'panel/data')]) await fs.mkdir(folder, { recursive: true })
  for (const [source, dest] of [['backend/egress-routing.mjs', 'egress-routing.mjs'], ['backend/egress.mjs', 'egress.mjs'], ['scripts/egress-prepare.mjs', 'egress-prepare.mjs'], ['scripts/egress-run.sh', 'egress-run.sh']]) await fs.copyFile(new URL('../' + source, import.meta.url), path.join(dir, dest))
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(stage, 'panel/data/zashboard.sqlite'))
  db.exec('CREATE TABLE app_storage (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO app_storage VALUES (?, ?)').run('openbox/profile', JSON.stringify({ directBypass: false }))
  db.close()
  assert.equal((await readProfile(stage)).directBypass, false)
  await fs.rename(path.join(stage, 'panel/data/zashboard.sqlite'), path.join(stage, 'data/openbox.sqlite'))
  assert.equal((await readProfile(stage)).directBypass, false)
  await fs.writeFile(path.join(stage, 'etc/config.json'), JSON.stringify({ outbounds: [{ type: 'direct', tag: 'DIRECT' }, { type: 'socks', tag: 'Proxy' }] }))
  await fs.writeFile(path.join(stage, 'bin/sing-box'), '#!/bin/sh\nif [ "$1" = check ]; then exit 0; fi\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
  const ifaces = JSON.stringify([{ name: 'wan1', addresses: ['192.0.2.2'], state: 'up' }, { name: 'wan2', addresses: ['192.0.2.3'], state: 'up' }])
  const env = { ...process.env, OPENBOX_ROOT: stage, OPENBOX_EGRESS_INTERFACES: ifaces }
  let result = await run('/bin/sh', [path.join(dir, 'egress-run.sh')], { env })
  assert(result.stdout.includes(path.join(stage, 'etc/config.json')))
  const active = { enabled: true, proxyInterface: 'wan1', directInterface: 'wan2' }
  await fs.writeFile(path.join(dir, 'egress.json'), JSON.stringify(active))
  result = await run('/bin/sh', [path.join(dir, 'egress-run.sh')], { env })
  assert(result.stdout.includes(path.join(dir, 'egress-runtime.json')))
  const config = JSON.parse(await fs.readFile(path.join(dir, 'egress-runtime.json'), 'utf8'))
  assert.equal(config.outbounds.find(n => n.tag === 'DIRECT').bind_interface, 'wan2')
  assert.equal(config.outbounds.find(n => n.tag === 'Proxy').bind_interface, 'wan1')
  assert.equal(config.route.default_interface, 'wan2')
  assert.equal(config.route.auto_detect_interface, false)
  assert.deepEqual(verifyConfig(config, active), { ok: true, problems: [] })

  // sing-box check 不通过 → 拒绝启动，且不留下可用的运行配置
  await fs.rm(path.join(dir, 'egress-runtime.json'), { force: true })
  await fs.writeFile(path.join(stage, 'bin/sing-box'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await assert.rejects(run('/bin/sh', [path.join(dir, 'egress-run.sh')], { env }))
  await assert.rejects(fs.stat(path.join(dir, 'egress-runtime.json')), { code: 'ENOENT' })

  // 网口不存在 → 拒绝启动（不再静默回退到未分流的原始配置）
  await fs.writeFile(path.join(dir, 'egress.json'), JSON.stringify({ ...active, directInterface: 'missing-wan' }))
  await assert.rejects(run('/bin/sh', [path.join(dir, 'egress-run.sh')], { env }), /尚未就绪/)

  // 两项选择同一网口 → 拒绝启动（单网口测试模式已移除）
  await fs.writeFile(path.join(dir, 'egress.json'), JSON.stringify({ ...active, directInterface: 'wan1' }))
  await assert.rejects(run('/bin/sh', [path.join(dir, 'egress-run.sh')], { env }), /同一个网口/)
  const failure = JSON.parse(await fs.readFile(path.join(dir, 'egress-last-error.json'), 'utf8'))
  assert.match(failure.message, /同一个网口/)
})

test('a failed apply stops the core instead of running unsplit; a successful apply verifies bindings', async t => {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-egress-transaction-'))
  t.after(() => fs.rm(stage, { recursive: true, force: true }))
  for (const name of ['bin', 'etc', 'init', 'data/multi-backend']) await fs.mkdir(path.join(stage, name), { recursive: true })
  await fs.writeFile(path.join(stage, 'bin/sing-box'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await fs.writeFile(path.join(stage, 'etc/config.json'), JSON.stringify({ outbounds: [{ type: 'direct', tag: 'DIRECT' }, { type: 'socks', tag: 'Proxy', server: '203.0.113.9' }] }))
  await fs.writeFile(path.join(stage, 'init/openbox'), 'procd_set_param command "$BIN" run -c "$CONF" -D "$DATA"\n')
  const manager = new URL('../backend/egress-manager.mjs', import.meta.url).href
  const script = `
    import assert from 'node:assert/strict'; import fs from 'node:fs/promises';
    import { egressChange, egressStatus } from ${JSON.stringify(manager)};
    let profile = {directBypass:true}, deployments=0, fail=true, running=true, actions=[];
    const api = async (url, body) => {
      if (url.endsWith('/profile')) { if(body) profile={...profile,...body}; return {profile}; }
      if(url.endsWith('/service/status')) return {core:{running,autostart:true}};
      if(url.includes('/service/core/')) { actions.push(url); if(url.endsWith('/restart')) running=true; if(url.endsWith('/stop')) running=false; return {ok:true,code:0}; }
      deployments++; if(fail && deployments===1) throw Error('simulated deploy failure'); return {ok:true};
    };
    const value = ${JSON.stringify({ enabled: true, proxyInterface: 'wan1', directInterface: 'wan2' })};
    await egressChange('save', value, api);
    let st = await egressStatus();
    assert.equal(st.active.enabled,false); assert.equal(st.draft.enabled,true); assert.equal(deployments,0);

    // 部署失败：回退设置，并且**停掉内核**，不允许以未分流状态继续运行
    await assert.rejects(egressChange('apply',value,api),/内核已停止/);
    assert.equal(profile.directBypass,true);
    assert.equal(running,false); assert(actions.some(a=>a.endsWith('/stop')));
    st = await egressStatus();
    assert.equal(st.active.enabled,false);
    assert.equal(st.splitActive,false);
    assert(!(await fs.readFile(process.env.OPENBOX_INITD_DIR+'/openbox','utf8')).includes('egress-run.sh'));

    // 成功后：运行配置按两个网口分别绑定，状态里能读到校验结果
    fail=false; await egressChange('apply',value,api);
    assert.equal(profile.directBypass,false);
    st = await egressStatus();
    assert.equal(st.active.enabled,true);
    assert.equal(st.splitActive,true);
    assert.deepEqual(st.summary.verify.problems,[]);
    assert.equal(st.summary.proxyInterface,'wan1'); assert.equal(st.summary.directInterface,'wan2');
    assert(st.summary.proxyOutbounds.includes('Proxy'));
    assert(st.summary.directOutbounds.includes('DIRECT'));
    assert.equal(st.summary.defaultInterface,'wan2');
    assert((await fs.readFile(process.env.OPENBOX_INITD_DIR+'/openbox','utf8')).includes('egress-run.sh'));

    // 两项同网口：直接拒绝，不重启内核
    const before = actions.length;
    await assert.rejects(egressChange('apply',{...value,directInterface:'wan1'},api),/同一个网口/);
    assert.equal(actions.length,before);

    // 停用：启动器还原
    await egressChange('apply',{...value,enabled:false},api);
    assert.equal((await egressStatus()).active.enabled,false);
    assert(!(await fs.readFile(process.env.OPENBOX_INITD_DIR+'/openbox','utf8')).includes('egress-run.sh'));
  `
  await run(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, OPENBOX_ROOT: stage, OPENBOX_INITD_DIR: path.join(stage, 'init'),
      OPENBOX_EGRESS_INTERFACES: JSON.stringify([{ name: 'wan1', addresses: ['192.0.2.2'], state: 'up' }, { name: 'wan2', addresses: ['192.0.2.3'], state: 'up' }]) },
  })
})

test('runtimeState tells whether the running core uses the split config', async t => {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-egress-runtime-'))
  t.after(() => fs.rm(stage, { recursive: true, force: true }))
  const dir = path.join(stage, 'data/multi-backend')
  const proc = path.join(stage, 'proc')
  await fs.mkdir(dir, { recursive: true })
  await fs.mkdir(path.join(proc, '101'), { recursive: true })
  await fs.mkdir(path.join(proc, '202'), { recursive: true })
  const runtime = path.join(dir, 'egress-runtime.json')
  await fs.writeFile(runtime, '{}')
  await fs.writeFile(path.join(proc, '101', 'cmdline'), ['/opt/open-box/bin/sing-box', 'run', '-c', path.join(stage, 'etc/config.json'), '-D', 'data'].join('\0') + '\0')
  await fs.writeFile(path.join(proc, '202', 'cmdline'), ['/opt/open-box/bin/sing-box', 'run', '-c', runtime, '-D', 'data'].join('\0') + '\0')
  const both = await runtimeState(stage, proc)
  assert.equal(both.supported, true)
  assert.equal(both.active, true)
  assert.equal(both.pid, 202)
  assert.equal(both.processes.length, 2)
  // 只有原生进程（面板直接拉起 sing-box）时，说明包装脚本被绕过
  await fs.rm(path.join(proc, '202'), { recursive: true, force: true })
  const bypassed = await runtimeState(stage, proc)
  assert.equal(bypassed.active, false)
  // 没有 /proc 的平台：标记为"无法检查"，而不是谎报未生效
  assert.equal((await runtimeState(stage, path.join(stage, 'nope'))).supported, false)
})

test('systemd drop-in changes only ExecStart and restores without touching upstream unit', async t => {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-egress-systemd-'))
  t.after(() => fs.rm(stage, { recursive: true, force: true }))
  const unit = path.join(stage, 'debian/systemd/openbox.service')
  const systemd = path.join(stage, 'systemd'), bin = path.join(stage, 'tools')
  for (const folder of [path.dirname(unit), systemd, bin]) await fs.mkdir(folder, { recursive: true })
  const original = '[Service]\nExecStart=/opt/open-box/bin/sing-box run\n'
  await fs.writeFile(unit, original)
  await fs.writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\n[ "$1" = daemon-reload ]\n', { mode: 0o755 })
  const previous = { PATH: process.env.PATH, OPENBOX_INITD_DIR: process.env.OPENBOX_INITD_DIR, OPENBOX_SYSD_DIR: process.env.OPENBOX_SYSD_DIR }
  Object.assign(process.env, { PATH: bin + ':' + process.env.PATH, OPENBOX_INITD_DIR: path.join(stage, 'no-initd'), OPENBOX_SYSD_DIR: systemd })
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value })
  await hook(stage)
  const drop = path.join(systemd, 'openbox.service.d/90-openbox-egress.conf')
  const text = await fs.readFile(drop, 'utf8')
  assert(text.includes(`ExecStart=\nExecStart=${stage}/data/multi-backend/egress-run.sh`))
  assert.equal(await fs.readFile(unit, 'utf8'), original)
  await hook(stage, true)
  await assert.rejects(fs.stat(drop), { code: 'ENOENT' })
  assert.equal(await fs.readFile(unit, 'utf8'), original)
})

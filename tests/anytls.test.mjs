import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnyTlsShare } from '../backend/anytls-share.mjs';
import { patchServer, patchFrontend } from '../scripts/patch-anytls.mjs';

test('AnyTLS shares retain native routing and TLS paths without mutating stored servers', () => {
  const input = {profile: {servers: [
    {id: 'a', name: '上海', protocol: 'anytls', port: 8446, password: 'secret'},
    {id: 'b', protocol: 'vless', port: 8443, uuid: 'existing'},
    {id: 'c', protocol: 'anytls', port: 8447, enabled: false},
  ]}};
  const original = structuredClone(input);
  const routes = [{inbound: ['server-a'], outbound: 'policy'}];
  const result = buildAnyTlsShare((method, adapted) => {
    assert.equal(method, 'configDetailed');
    assert.equal(adapted.profile.servers[0].protocol, 'vless');
    assert.equal(adapted.profile.servers[0].tls, true);
    assert.equal(adapted.profile.servers[2].protocol, 'vless');
    return {config: {inbounds: [
      {type: 'vless', tag: 'server-a', listen: '::', listen_port: 8446, users: [{uuid: 'placeholder'}], tls: {enabled: true, certificate_path: '/cert.pem', key_path: '/key.pem'}},
      {type: 'vless', tag: 'server-b', listen_port: 8443, users: [{uuid: 'existing'}]},
    ], route: {rules: routes}, outbounds: [{type: 'anytls', tag: 'existing-outbound', password: 'keep'}]}};
  }, input);
  assert.deepEqual(input, original);
  assert.deepEqual(result.config.inbounds[0], {
    type: 'anytls', tag: 'server-a', listen: '::', listen_port: 8446,
    users: [{name: '上海', password: 'secret'}], tls: {enabled: true, certificate_path: '/cert.pem', key_path: '/key.pem'},
  });
  assert.equal(result.config.inbounds[1].type, 'vless');
  assert.equal(result.config.outbounds[0].password, 'keep');
  assert.equal(result.config.route.rules, routes);
});

test('AnyTLS configuration fails closed on missing certificates, passwords or unknown native layout', () => {
  const input = {profile: {servers: [{protocol: 'anytls', port: 8446, password: 'secret'}]}};
  assert.throws(() => buildAnyTlsShare(() => ({config: {inbounds: []}}), input), /不兼容/);
  assert.throws(() => buildAnyTlsShare(() => ({inbounds: [{type: 'vless', listen_port: 8446}]}), input), /TLS/);
  assert.throws(() => buildAnyTlsShare(() => {}, {profile: {servers: [{protocol: 'anytls'}]}}), /密码/);
  assert.throws(() => patchServer('unknown upstream'), /不兼容/);
  assert.throws(() => patchFrontend('unknown upstream'), /布局/);
});

test('Hy2 options reach native inbounds with TLS 1.3, certificate paths, bandwidth and masquerade', () => {
  const input = {profile: {servers: [{protocol: 'hysteria2', port: 8445, hy2: {
    serverName: 'hy.example.com', certificatePath: '/etc/hy.crt', keyPath: '/etc/hy.key',
    insecure: false, upMbps: '100', downMbps: 200, congestion: 'brutal', masquerade: 'https://example.com',
  }}]}};
  const result = buildAnyTlsShare((method, passed) => {
    assert.equal(passed.profile.servers[0].protocol, 'hysteria2');
    return {config: {inbounds: [{type: 'hysteria2', listen_port: 8445, tag: 'share-hy', obfs: {type: 'salamander', password: 'keep'}, tls: {enabled: true, certificate_path: '/auto.crt', key_path: '/auto.key'}}]}};
  }, input);
  const inbound = result.config.inbounds[0];
  assert.deepEqual(inbound.tls, {enabled: true, certificate_path: '/etc/hy.crt', key_path: '/etc/hy.key', min_version: '1.3', max_version: '1.3', alpn: ['h3']});
  assert.equal(inbound.up_mbps, 100); assert.equal(inbound.down_mbps, 200);
  assert.equal(inbound.ignore_client_bandwidth, true);
  assert.equal(inbound.masquerade, 'https://example.com');
  assert.equal(inbound.obfs.password, 'keep');
  assert.equal(input.profile.servers[0].hy2.upMbps, '100');
});

test('Hy2 BBR has no bandwidth limits and invalid combinations fail before native generation', async () => {
  const {normalizeHy2} = await import('../backend/anytls-share.mjs');
  for (const value of [{upMbps: -1}, {upMbps: true}, {congestion: 'bbr', upMbps: 100}, {congestion: 'brutal', upMbps: 100}, {certificatePath: '/only.crt'}, {masquerade: 'javascript:alert(1)'}, {tlsVersion: '1.2'}]) {
    assert.throws(() => normalizeHy2(value));
  }
  const input = {profile: {servers: [{protocol: 'hysteria2', port: 8445, hy2: {congestion: 'bbr'}}]}};
  const result = buildAnyTlsShare(() => ({config: {inbounds: [{type: 'hysteria2', listen_port: 8445, up_mbps: 99, down_mbps: 99, tls: {enabled: true}}]}}), input);
  assert.equal(result.config.inbounds[0].ignore_client_bandwidth, true);
  assert.equal(result.config.inbounds[0].up_mbps, undefined);
  assert.throws(() => buildAnyTlsShare(() => ({config: {inbounds: []}}), input), /Hy2/);
});

test('Hy2 form does not depend on the upstream minified name of its TLS hint style', () => {
  // A compact synthetic upstream shape, with deliberately renamed CSS bindings.
  const upstream = `
const U0="open-box.local",labels={hysteria2:"Hysteria2",mixed:"SOCKS5 / HTTP"};
const protocols=[{value:"hysteria2",label:"Hysteria2"}],ports={hysteria2:8445,mixed:7080};
const nu=e=>{const t=e.address;const n=dwe(t),a=encodeURIComponent(e.name||e.id);switch(e.protocol){case"hysteria2":{const s="";return\`hysteria2://\${encodeURIComponent(e.password||"")}@\${n}:\${e.port}/?insecure=1&sni=\${U0}\${s}#\${a}\`}case"mixed":return\`socks5://\${n}\`}};
const defaults={tls:!0,obfs:"",username:""};
const existing=n.server?{...n.server}:{};
const tls=u.protocol==="tuic"||u.protocol==="hysteria2"||u.protocol==="vless"&&u.tls;
function save(){u.protocol==="hysteria2"&&(M.password=u.password);if(M.password!==void 0&&!M.password)return;}
function render(){return [p("p",upstreamRenamedStyle,w(C.$t(v.value?"serverTlsHint":u.protocol==="mixed"?"serverMixedHint":"serverPlainHint")),1)];}
`;
  const patched = patchFrontend(upstream);
  assert.match(patched, /Hy2 高级设置/);
  assert.match(patched, /p\("p",upstreamRenamedStyle/);
  // Conditional form branches must stay in Vue's block tracking during switches.
  assert.match(patched, /u\.protocol==="hysteria2"\?\(b\(\),x\("div"/);
  assert.match(patched, /\],-2\)\):F/);
  assert.match(patched, /value:"anytls",label:"AnyTLS"/);
});

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

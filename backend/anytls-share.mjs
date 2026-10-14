// Keep the native generator's tags, routing and certificate paths. Only adapt
// explicitly configured AnyTLS share servers; never modify outbound nodes.
export function buildAnyTlsShare(native, input) {
  const servers = (input?.profile?.servers || []).filter(s => s.protocol === 'anytls' && s.enabled !== false);
  if (!(input?.profile?.servers || []).some(s => s.protocol === 'anytls')) return native('configDetailed', input);
  if (servers.some(s => typeof s.password !== 'string' || !s.password)) throw new Error('AnyTLS 共享网络密码不能为空');
  const adapted = {
    ...input,
    profile: {
      ...input.profile,
      servers: input.profile.servers.map(s => s.protocol === 'anytls' ? {
        ...s, protocol: 'vless', tls: true,
        uuid: '00000000-0000-4000-8000-000000000001',
      } : s),
    },
  };
  const result = native('configDetailed', adapted);
  const pending = new Map(servers.map(s => [s.port, s]));
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.inbounds)) {
      for (let i = 0; i < value.inbounds.length; i++) {
        const inbound = value.inbounds[i];
        const server = pending.get(inbound?.listen_port);
        if (!server || inbound.type !== 'vless') continue;
        if (!inbound.tls?.enabled || !inbound.tls.certificate_path || !inbound.tls.key_path) {
          throw new Error('AnyTLS 共享网络缺少 TLS 证书配置，已取消生成');
        }
        value.inbounds[i] = {
          type: 'anytls', tag: inbound.tag, listen: inbound.listen,
          listen_port: inbound.listen_port,
          users: [{ name: server.name || server.id, password: server.password }],
          tls: inbound.tls,
        };
        pending.delete(server.port);
      }
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'inbounds') visit(child);
  }
  visit(result);
  if (pending.size) throw new Error('当前 OpenBox 原生配置格式不兼容 AnyTLS 补丁，已取消生成');
  return result;
}

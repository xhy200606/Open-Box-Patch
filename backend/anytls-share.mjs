// Extend shared-network inbounds while keeping native tags and routing.
// Outbound nodes are never changed by this adapter.
export function buildAnyTlsShare(native, input) {
  const servers = (input?.profile?.servers || []).filter(s => s.protocol === 'anytls' && s.enabled !== false);
  const hy2 = (input?.profile?.servers || []).filter(s => s.protocol === 'hysteria2' && s.hy2 && s.enabled !== false);
  const hy2Options = new Map(hy2.map(s => [s.port, normalizeHy2(s.hy2)]));
  if (!hy2.length && !(input?.profile?.servers || []).some(s => s.protocol === 'anytls')) return native('configDetailed', input);
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
        const options = hy2Options.get(inbound?.listen_port);
        if (options && inbound.type === 'hysteria2') {
          if (!inbound.tls?.enabled) throw new Error('Hy2 需要启用 TLS');
          inbound.tls = {...inbound.tls, min_version: '1.3', max_version: '1.3', alpn: ['h3']};
          if (options.certificatePath) {
            delete inbound.tls.certificate; delete inbound.tls.key;
            inbound.tls.certificate_path = options.certificatePath;
            inbound.tls.key_path = options.keyPath;
          }
          for (const [key, field] of [['upMbps', 'up_mbps'], ['downMbps', 'down_mbps']]) {
            delete inbound[field];
            if (options[key]) inbound[field] = options[key];
          }
          inbound.ignore_client_bandwidth = ['bbr', 'brutal'].includes(options.congestion);
          if (options.masquerade) inbound.masquerade = options.masquerade;
          else delete inbound.masquerade;
          hy2Options.delete(inbound.listen_port);
        }
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
  if (hy2Options.size) throw new Error('当前 OpenBox 原生配置格式不兼容 Hy2 高级设置，已取消生成');
  if (pending.size) throw new Error('当前 OpenBox 原生配置格式不兼容 AnyTLS 补丁，已取消生成');
  return result;
}

// This standalone validator is also embedded into the shared-network dialog.
export function normalizeHy2(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hy2 高级设置必须是对象');
  const allowed = ['serverName', 'certificatePath', 'keyPath', 'insecure', 'upMbps', 'downMbps', 'congestion', 'masquerade'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Hy2 包含不支持的设置');
  const out = {};
  for (const key of ['serverName', 'certificatePath', 'keyPath', 'masquerade']) {
    if (value[key] === undefined || value[key] === '') continue;
    if (typeof value[key] !== 'string' || value[key].length > 2048 || /[\r\n\0]/.test(value[key])) throw new Error('Hy2 字符串设置无效');
    const text = value[key].trim();
    if (text) out[key] = text;
  }
  if (!!out.certificatePath !== !!out.keyPath) throw new Error('证书路径和私钥路径需要一起填写');
  if (out.serverName && !/^[A-Za-z0-9._-]{1,253}$/.test(out.serverName)) throw new Error('SNI 需要填写域名');
  if (value.insecure !== undefined) {
    if (typeof value.insecure !== 'boolean') throw new Error('跳过证书验证需要是布尔值');
    out.insecure = value.insecure;
  }
  for (const key of ['upMbps', 'downMbps']) {
    if (value[key] === undefined || value[key] === '') continue;
    if (!['number', 'string'].includes(typeof value[key])) throw new Error('带宽需要填写数字');
    const number = Number(value[key]);
    if (!Number.isInteger(number) || number < 1 || number > 1000000) throw new Error('带宽需要填写 1–1000000 Mbps 的整数，或留空');
    out[key] = number;
  }
  const congestion = value.congestion || 'auto';
  if (!['auto', 'bbr', 'brutal'].includes(congestion)) throw new Error('Hy2 拥塞控制设置无效');
  if (congestion === 'bbr' && (out.upMbps || out.downMbps)) throw new Error('使用 BBR 时请将上下行带宽留空');
  if (congestion === 'brutal' && (!out.upMbps || !out.downMbps)) throw new Error('使用 Brutal 时需要填写上下行带宽');
  if (congestion !== 'auto') out.congestion = congestion;
  if (out.masquerade) {
    let url;
    try { url = new URL(out.masquerade); } catch { throw new Error('伪装地址需要是完整的 http(s) 或 file URL'); }
    if (!['http:', 'https:', 'file:'].includes(url.protocol) || url.username || url.password || url.hash || (url.protocol === 'file:' && url.hostname)) throw new Error('伪装地址需要是 http(s) 或本地 file URL，且不包含账号密码或片段');
  }
  return out;
}

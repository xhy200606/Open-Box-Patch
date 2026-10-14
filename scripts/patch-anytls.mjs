import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// All anchors must match before any file is written. Unknown upstream versions
// keep their original files instead of receiving a partial protocol patch.
function replaceOnce(source, from, to) {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + from.length) >= 0) throw new Error(`不兼容的上游代码: ${from.slice(0, 65)}`);
  return source.slice(0, first) + to + source.slice(first + from.length);
}
export function patchServer(source) {
  source = replaceOnce(source, '["shadowsocks","vless","tuic","hysteria2","mixed"]', '["shadowsocks","vless","tuic","hysteria2","mixed","anytls"]');
  const firewall = source;
  source = source.replace(/(\w+)\.protocol==="vless"\|\|\1\.protocol==="mixed"\?"tcp":"udp"/, '$1.protocol==="vless"||$1.protocol==="anytls"||$1.protocol==="mixed"?"tcp":"udp"');
  if (source === firewall) throw new Error('未找到 TCP 放行逻辑');
  const validation = source;
  source = source.replace(/(\w+)\.protocol==="shadowsocks"\|\|\1\.protocol==="tuic"\|\|\1\.protocol==="hysteria2"\)\&\&/, '$1.protocol==="shadowsocks"||$1.protocol==="tuic"||$1.protocol==="hysteria2"||$1.protocol==="anytls")&&');
  if (source === validation) throw new Error('未找到密码校验逻辑');
  const call = source.match(/(\w+)\("configDetailed",(\w+)\(e\)\)/);
  if (!call) throw new Error('未找到原生配置入口');
  source = replaceOnce(source, call[0], `__obAnyTlsConfig(${call[1]},${call[2]}(e))`);
  source = replaceOnce(source, 'if(!ue(n.name)||!n.name.trim()||n.name.length>40)', 'if(n.protocol==="hysteria2"&&n.hy2!==void 0)try{n.hy2=__obHy2Options(n.hy2)}catch(e){return e.message};if(!ue(n.name)||!n.name.trim()||n.name.length>40)');
  return '/* openbox-share-v2 */\nimport {buildAnyTlsShare as __obAnyTlsConfig,normalizeHy2 as __obHy2Options} from "./anytls-share.mjs";\n' + source;
}
export function patchCli(source) {
  const firewall = source;
  source = source.replace(/(\w+)\.protocol==="vless"\|\|\1\.protocol==="mixed"\?"tcp":"udp"/, '$1.protocol==="vless"||$1.protocol==="anytls"||$1.protocol==="mixed"?"tcp":"udp"');
  if (source === firewall) throw new Error('未找到 CLI TCP 放行逻辑');
  const call = source.match(/(\w+)\("configDetailed",(\w+)\(e\)\)/);
  if (!call) throw new Error('未找到 CLI 原生配置入口');
  source = replaceOnce(source, call[0], `__obAnyTlsConfig(${call[1]},${call[2]}(e))`);
  return 'import {buildAnyTlsShare as __obAnyTlsConfig} from "../anytls-share.mjs";\n' + source;
}
export function patchFrontend(source, helperSource) {
  if (!source.includes('U0="open-box.local"') || !source.includes('const n=dwe(t),a=encodeURIComponent(e.name||e.id)')) throw new Error('分享链接变量布局已变化');
  source = replaceOnce(source, 'hysteria2:"Hysteria2",mixed:"SOCKS5 / HTTP"', 'hysteria2:"Hysteria2",anytls:"AnyTLS",mixed:"SOCKS5 / HTTP"');
  source = replaceOnce(source, '{value:"hysteria2",label:"Hysteria2"}', '{value:"hysteria2",label:"Hysteria2"},{value:"anytls",label:"AnyTLS"}');
  source = replaceOnce(source, 'hysteria2:8445,mixed:7080', 'hysteria2:8445,anytls:8446,mixed:7080');
  source = replaceOnce(source, 'case"mixed":return`socks5://', 'case"anytls":return`anytls://${encodeURIComponent(e.password||"")}@${n}:${e.port}?security=tls&sni=${U0}&allowInsecure=1#${a}`;case"mixed":return`socks5://');
  source = replaceOnce(source, 'u.protocol==="tuic"||u.protocol==="hysteria2"||u.protocol==="vless"&&u.tls', 'u.protocol==="anytls"||u.protocol==="tuic"||u.protocol==="hysteria2"||u.protocol==="vless"&&u.tls');
  source = replaceOnce(source, 'u.protocol==="hysteria2"&&(M.password=', 'u.protocol==="anytls"&&(M.password=(u.password||"").trim(),M.tls=!0),u.protocol==="hysteria2"&&(M.password=');
  return patchHy2Frontend(source, helperSource);
}
function patchHy2Frontend(source, helperSource) {
  if (!helperSource) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = fs.existsSync(path.join(here, 'anytls-share.mjs')) ? path.join(here, 'anytls-share.mjs') : path.join(here, '../backend/anytls-share.mjs');
    helperSource = fs.readFileSync(file, 'utf8');
  }
  const validator = helperSource.slice(helperSource.indexOf('export function normalizeHy2')).replace('export function normalizeHy2', 'function __obHy2Options');
  if (!validator.startsWith('function __obHy2Options')) throw new Error('缺少 Hy2 设置校验器');
  source = replaceOnce(source, 'tls:!0,obfs:"",username:""', 'tls:!0,obfs:"",username:"",hy2:{}');
  source = replaceOnce(source, 'n.server?{...n.server}:{}', 'n.server?{...n.server,hy2:{...n.server.hy2||{}}}:{}');
  source = replaceOnce(source, 'if(M.password!==void 0&&!M.password', 'if(u.protocol==="hysteria2")try{M.hy2=__obHy2Options(u.hy2)}catch(error){return k(error.message)}if(M.password!==void 0&&!M.password');
  source = replaceOnce(source, 'return`hysteria2://${encodeURIComponent(e.password||"")}@${n}:${e.port}/?insecure=1&sni=${U0}${s}#${a}`', 'return __obHy2Link(e,n,a,s)');
  const fields = [
    ['serverName', 'SNI / 证书域名', 'SNI / certificate name', 'text', 'open-box.local'],
    ['certificatePath', '证书文件路径（当前后端）', 'Certificate path on backend', 'text', '留空使用自签证书'],
    ['keyPath', '私钥文件路径（当前后端）', 'Private key path on backend', 'text', '/path/to/private.key'],
    ['upMbps', '服务器上行带宽（Mbps）', 'Server upload (Mbps)', 'number', '留空不限制'],
    ['downMbps', '服务器下行带宽（Mbps）', 'Server download (Mbps)', 'number', '留空不限制'],
    ['masquerade', 'HTTP/3 伪装地址', 'HTTP/3 masquerade URL', 'text', 'https://example.com 或 file:///var/www'],
  ];
  const label = (zh, en) => `__obHy2Text(C,${JSON.stringify(zh)},${JSON.stringify(en)})`;
  const rendered = fields.map(([key, zh, en, type, placeholder]) => `p("div",{class:"flex flex-col gap-1"},[p("label",{class:"text-xs font-medium"},${label(zh,en)}),p("input",{type:${JSON.stringify(type)},class:"input input-sm w-full",value:u.hy2.${key}??"",placeholder:${JSON.stringify(placeholder)},${type==='number'?'min:1,max:1000000,step:1,':''}onInput:A=>u.hy2.${key}=A.target.value})])`);
  rendered.push(`p("div",{class:"flex flex-col gap-1"},[p("label",{class:"text-xs font-medium"},${label('拥塞控制','Congestion control')}),p("select",{class:"select select-sm w-full",value:u.hy2.congestion||"auto",onChange:A=>u.hy2.congestion=A.target.value},[p("option",{value:"auto"},${label('默认（跟随客户端）','Default (client negotiated)')}),p("option",{value:"bbr"},${label('BBR（带宽留空）','BBR (leave bandwidth empty)')}),p("option",{value:"brutal"},${label('Brutal（填写上下行带宽）','Brutal (set upload and download)')})])])`);
  rendered.push(`p("label",{class:"flex items-center gap-2 text-sm"},[p("input",{type:"checkbox",class:"toggle toggle-sm",checked:u.hy2.insecure??!u.hy2.certificatePath,onChange:A=>u.hy2.insecure=A.target.checked}),${label('分享链接允许跳过证书验证','Allow insecure certificate in share link')}])`);
  const form = `u.protocol==="hysteria2"?(b(),x("div",{class:"flex flex-col gap-3"},[p("div",{class:"text-sm font-medium"},${label('Hy2 高级设置','Hy2 advanced settings')}),p("p",{class:"text-xs text-base-content/60"},${label('TLS 1.3 · HTTP/3 · ALPN h3（QUIC 固定版本）','TLS 1.3 · HTTP/3 · ALPN h3 (QUIC fixed versions)')}),p("div",{class:"grid grid-cols-1 gap-3 md:grid-cols-2"},[${rendered.join(',')}]),p("p",{class:"text-xs text-base-content/60"},${label('证书文件需已存在于当前后端；使用受信任证书时关闭跳过验证。伪装地址仅处理未认证的 HTTP/3 请求。','Certificate files must exist on the selected backend. Disable insecure verification for trusted certificates. Masquerade handles unauthenticated HTTP/3 requests.')} )],-2)):F("",!0),`;
  const hint = source.match(/p\("p",[\w$]+,w\(C\.\$t\(v\.value\?"serverTlsHint"/);
  if (!hint) throw new Error('未找到共享网络 TLS 提示位置');
  source = replaceOnce(source, hint[0], form + hint[0]);
  source = replaceOnce(source, 'w(C.$t(v.value?"serverTlsHint":u.protocol==="mixed"?"serverMixedHint":"serverPlainHint"))', 'u.protocol==="hysteria2"?__obHy2Text(C,"TLS 已启用；SNI 应与服务端证书域名一致。","TLS is enabled; SNI must match the server certificate."):w(C.$t(v.value?"serverTlsHint":u.protocol==="mixed"?"serverMixedHint":"serverPlainHint"))');
  const helpers = `
function __obHy2Text(C,zh,en){return /^en/i.test(C.$i18n?.locale||"")?en:zh}
function __obHy2Link(e,n,a,obfs){try{const o=__obHy2Options(e.hy2||{});const insecure=o.insecure??!o.certificatePath;return \`hysteria2://\${encodeURIComponent(e.password||"")}@\${n}:\${e.port}/?insecure=\${insecure?1:0}&sni=\${encodeURIComponent(o.serverName||"open-box.local")}\${obfs}#\${a}\`}catch{return ""}}
`;
  return '/* openbox-share-v2 */\n' + validator + helpers + source;
}
function atomic(file, content) {
  const temp = file + '.anytls-tmp';
  fs.writeFileSync(temp, content, {mode: fs.statSync(file).mode});
  fs.renameSync(temp, file);
}
export function apply(root, sourceDir) {
  const server = path.join(root, 'panel/server/index.mjs');
  if (!fs.existsSync(server)) return false;
  const assets = path.join(root, 'panel/dist/assets');
  const candidates = fs.readdirSync(assets).filter(f => f.endsWith('.js')).map(f => path.join(assets, f)).filter(f => fs.readFileSync(f, 'utf8').includes('__name:"ServerEditDialog"'));
  if (candidates.length !== 1) throw new Error('共享网络界面入口不唯一，跳过 AnyTLS 补丁');
  const ui = candidates[0];
  const cli = path.join(root, 'panel/server/cli/deploy.mjs');
  const rawCli = fs.readFileSync(cli, 'utf8');
  const cliBase = rawCli.includes('import {buildAnyTlsShare as __obAnyTlsConfig}') ? fs.readFileSync(cli + '.anytls-bak', 'utf8') : rawCli;
  const nextCli = patchCli(cliBase);
  const rawServer = fs.readFileSync(server, 'utf8');
  const rawUi = fs.readFileSync(ui, 'utf8');
  const serverBase = rawServer.includes('buildAnyTlsShare as __obAnyTlsConfig') ? fs.readFileSync(server + '.anytls-bak', 'utf8') : rawServer;
  const uiBase = /^\/\* openbox-(?:anytls-share-v1|share-v2) \*\//.test(rawUi) ? fs.readFileSync(ui + '.anytls-bak', 'utf8') : rawUi;
  const nextServer = patchServer(serverBase);
  const nextUi = patchFrontend(uiBase);
  const helper = path.join(root, 'panel/server/anytls-share.mjs');
  const nextHelper = fs.readFileSync(path.join(sourceDir, 'anytls-share.mjs'), 'utf8');
  const html = path.join(root, 'panel/dist/index.html');
  const rawHtml = fs.readFileSync(html, 'utf8');
  const cleanHtml = rawHtml.replace(/<!-- anytls-share:start -->[\s\S]*?<!-- anytls-share:end -->\n?/g, '');
  const asset = './assets/' + path.basename(ui);
  const hash = createHash('sha256').update(nextUi).digest('hex').slice(0, 12);
  const imports = JSON.stringify({imports: {[asset]: asset + '?anytls=' + hash}});
  const nextHtml = cleanHtml.replace(/<script\b/, '<!-- anytls-share:start --><script type="importmap">' + imports + '</script><!-- anytls-share:end -->\n<script');
  if (nextHtml === cleanHtml) throw new Error('未找到 HTML 模块入口');
  let changed = false;
  for (const [file, before, after] of [[server, rawServer, nextServer], [cli, rawCli, nextCli], [ui, rawUi, nextUi], [html, rawHtml, nextHtml]]) {
    if (before === after) continue;
    if (file !== html && !before.includes('buildAnyTlsShare as __obAnyTlsConfig') && !/^\/\* openbox-(?:anytls-share-v1|share-v2) \*\//.test(before)) fs.copyFileSync(file, file + '.anytls-bak');
    atomic(file, after);
    changed = true;
  }
  if (!fs.existsSync(helper) || fs.readFileSync(helper, 'utf8') !== nextHelper) {
    fs.writeFileSync(helper, nextHelper);
    changed = true;
  }
  return changed;
}
export function restore(root) {
  const server = path.join(root, 'panel/server/index.mjs');
  const assets = path.join(root, 'panel/dist/assets');
  const files = [server, path.join(root, 'panel/server/cli/deploy.mjs'), ...(fs.existsSync(assets) ? fs.readdirSync(assets).filter(f => f.endsWith('.js')).map(f => path.join(assets, f)) : [])];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    if (!(content.includes('buildAnyTlsShare as __obAnyTlsConfig') || /^\/\* openbox-(?:anytls-share-v1|share-v2) \*\//.test(content))) continue;
    if (!fs.existsSync(file + '.anytls-bak')) throw new Error('缺少 AnyTLS 原始文件备份，取消卸载');
    fs.renameSync(file + '.anytls-bak', file);
  }
  const html = path.join(root, 'panel/dist/index.html');
  if (fs.existsSync(html)) atomic(html, fs.readFileSync(html, 'utf8').replace(/<!-- anytls-share:start -->[\s\S]*?<!-- anytls-share:end -->\n?/g, ''));
  fs.rmSync(path.join(root, 'panel/server/anytls-share.mjs'), {force: true});
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    if (process.argv.includes('--restore')) { restore(process.env.OPENBOX_ROOT || '/opt/open-box'); process.exit(0); }
    const changed = apply(process.env.OPENBOX_ROOT || '/opt/open-box', path.dirname(fileURLToPath(import.meta.url)));
    process.exitCode = changed ? 10 : 0;
  } catch (error) { console.error('[AnyTLS]', error.message); process.exitCode = 1; }
}

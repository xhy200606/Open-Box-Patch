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
  return 'import {buildAnyTlsShare as __obAnyTlsConfig} from "./anytls-share.mjs";\n' + source;
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
export function patchFrontend(source) {
  if (!source.includes('U0="open-box.local"') || !source.includes('const n=dwe(t),a=encodeURIComponent(e.name||e.id)')) throw new Error('分享链接变量布局已变化');
  source = replaceOnce(source, 'hysteria2:"Hysteria2",mixed:"SOCKS5 / HTTP"', 'hysteria2:"Hysteria2",anytls:"AnyTLS",mixed:"SOCKS5 / HTTP"');
  source = replaceOnce(source, '{value:"hysteria2",label:"Hysteria2"}', '{value:"hysteria2",label:"Hysteria2"},{value:"anytls",label:"AnyTLS"}');
  source = replaceOnce(source, 'hysteria2:8445,mixed:7080', 'hysteria2:8445,anytls:8446,mixed:7080');
  source = replaceOnce(source, 'case"mixed":return`socks5://', 'case"anytls":return`anytls://${encodeURIComponent(e.password||"")}@${n}:${e.port}?security=tls&sni=${U0}&allowInsecure=1#${a}`;case"mixed":return`socks5://');
  source = replaceOnce(source, 'u.protocol==="tuic"||u.protocol==="hysteria2"||u.protocol==="vless"&&u.tls', 'u.protocol==="anytls"||u.protocol==="tuic"||u.protocol==="hysteria2"||u.protocol==="vless"&&u.tls');
  source = replaceOnce(source, 'u.protocol==="hysteria2"&&(M.password=', 'u.protocol==="anytls"&&(M.password=(u.password||"").trim(),M.tls=!0),u.protocol==="hysteria2"&&(M.password=');
  return '/* openbox-anytls-share-v1 */\n' + source;
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
  const nextCli = rawCli.includes('import {buildAnyTlsShare as __obAnyTlsConfig}') ? rawCli : patchCli(rawCli);
  const rawServer = fs.readFileSync(server, 'utf8');
  const rawUi = fs.readFileSync(ui, 'utf8');
  const nextServer = rawServer.includes('import {buildAnyTlsShare as __obAnyTlsConfig}') ? rawServer : patchServer(rawServer);
  const nextUi = rawUi.startsWith('/* openbox-anytls-share-v1 */') ? rawUi : patchFrontend(rawUi);
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
    if (file !== html) fs.copyFileSync(file, file + '.anytls-bak');
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
    if (!(content.includes('import {buildAnyTlsShare as __obAnyTlsConfig}') || content.startsWith('/* openbox-anytls-share-v1 */'))) continue;
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

# Open-Box Patch

为 [Open-Box](https://github.com/liandu2024/Open-Box) 面板添加**多后端管理**的补丁项目。以「运行时注入 + 升级后自动重放」的方式实现，**不修改上游任何源码或二进制，上游升级后自动恢复**。

在面板左下角「运行时长」下方新增「后端」管理区，对齐 [zashboard](https://github.com/Zephyruso/zashboard) 的多后端模型：

- **自动识别当前面板**，作为默认后端（首位、标记「当前」、不可删除）。
- **每个后端各自一个密码**；切换需经服务端代理用密码**真认证**（`POST /api/auth/login`），密码错误不跳转并提示重输。
- **状态聚合**：在线 / 版本 / 内核运行时长，由服务端代理持续刷新。
- 点击后端在新标签页打开对应面板（切换时可选自动复制密码到剪贴板，便于在目标面板粘贴登录）。

## 架构

补丁由两部分组成：

1. **前端注入脚本**（`multi-backend.js`）——注入到面板 SPA，渲染管理区与弹窗。数据模型与 zashboard 一致：
   `{ uuid, protocol, host, port, secondaryPath, label, password }`，存浏览器 `localStorage`。
2. **后端代理服务**（`proxy.mjs`，systemd 常驻）——为什么需要它：Open-Box 面板**只认 Cookie 会话、未开 CORS**，浏览器无法跨域认证到另一台面板。代理在服务端用密码登录目标后端、持有会话 Cookie，再代为读取状态并开放 CORS 给面板页调用。

```
浏览器(面板页) --注入脚本--> 代理(3037) --密码登录 POST /api/auth/login--> 其它 Open-Box 面板
```

代理会话仅在内存缓存（20 分钟），不落盘。

## 安装

目标机为 **Debian / Ubuntu（systemd）** 的 Open-Box 路由器端，需要 root。

直连 GitHub：

```sh
curl -fsSL https://raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/install.sh | sudo sh
```

GitHub 访问不畅时，走镜像（默认 `gh-proxy.com`）：

```sh
curl -fsSL https://gh-proxy.com/raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/install.sh | sudo sh -s -- --mirror
```

本地目录安装 / 指定代理端口：

```sh
sudo sh install.sh
sudo sh install.sh --mirror https://gh-proxy.com/ --proxy-port 3037
```

安装脚本会：

1. 下载补丁文件到 `/opt/open-box/data/multi-backend/`（该目录在上游升级时被保留）；
2. 安装 systemd 单元：`openbox-patch.{service,path}`（前端重放）与 `openbox-mb-proxy.service`（代理）；
3. 立即执行一次 `apply.sh` 并启动代理。

装完刷新面板页面，左下角出现「后端」管理区。

## 使用

- 点「后端」区右上角 **⚙** 打开管理弹窗。
- **添加后端**：协议（HTTP/HTTPS）、主机 / IP、端口、路径前缀（可选）、名称、密码（必填）。可先点「测试连接」验证。
- **切换**：点列表里的「切换」或直接点侧栏中的后端行 —— 代理会用该密码登录验证，通过即在新标签页打开；失败则提示重输。
- **删除**：列表里的「删除」（「当前」本机不可删）。
- **代理设置**：修改代理服务地址（默认 `http://<本机>:3037`）、切换时是否复制密码到剪贴板。

## 卸载

```sh
curl -fsSL https://raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/uninstall.sh | sudo sh
```

会停用并删除三个 systemd 单元、移除注入脚本、还原 `index.html`、删除补丁数据目录。

## 升级后是否自动恢复

是。上游 `update.sh` 升级时整体替换 `/opt/open-box/panel/`，systemd `path` 单元检测到 `panel/dist/index.html` 变化后自动调用 `apply.sh` 重新注入（幂等）。也可手动重放：

```sh
sudo sh /opt/open-box/data/multi-backend/apply.sh
```

## 原理要点

- **注入点**：`panel/dist/index.html` 末尾追加 `<script src="./multi-backend.js?v=<hash>"></script>`，并把自包含脚本放到 `panel/dist/`。
- **缓存穿透**：面板对 `index.html/sw.js` 之外的文件返回一年强缓存（`immutable`），故注入标签带内容哈希；补丁更新后哈希变化、URL 变化，浏览器自动拉新版本。
- **锚点定位**：查找文案为「运行时长 / 運行時長 / Uptime」的叶子 `<span>`，把管理区插到其所在整行下方；配合 `MutationObserver` 应对 SPA 重渲染。
- **自身状态**：当前面板为同源，直接读 `/api/openbox/update/status`、`/api/openbox/service/status`（携带 Cookie）。
- **其它后端**：经代理 `POST /api/mb/status {url,password}`；代理不可用时回退为 `no-cors` 可达性探测（仅在线/离线）。

## 代理服务接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/mb/health` | 自检，返回 `{ok,service,version}` |
| POST | `/api/mb/status` | 请求体 `{url,password}`；返回 `{online,authenticated,version,uptimeSeconds,...}` |
| OPTIONS | `*` | CORS 预检 |

代理所调用的上游接口（Open-Box 面板）：

- `POST /api/auth/login`（JSON `{password}`，成功返回 `Set-Cookie`；401 表示密码错）
- `GET  /api/auth/status`（免鉴权，`{enabled,authenticated}`）
- `GET  /api/openbox/update/status`（鉴权，版本；不出网）
- `GET  /api/openbox/service/status`（鉴权，内核运行状态与 `uptimeSeconds`）

代理环境变量：`OPENBOX_MB_PORT`（默认 3037）、`OPENBOX_MB_BIND`（默认 0.0.0.0）、`OPENBOX_MB_TOKEN`（可选，设后需请求头 `X-MB-Token` 匹配）、`OPENBOX_MB_TIMEOUT`（默认 6000ms）。

## 安全边界

1. 代理默认监听 `0.0.0.0:3037`，**同一局域网内可访问**。它接受任意 http(s) 地址并代为请求，仅适合可信局域网；需要收紧时设置 `OPENBOX_MB_TOKEN` 并在「代理设置」里填写同一值。
2. 代理内置按 IP 限流（60 次/分钟），抑制把它当作密码爆破口或端口扫描器。
3. 密码保存在**浏览器 `localStorage`**（随浏览器配置），并在切换/刷新时经局域网发给代理；代理仅在内存持有会话 Cookie，不落盘。若开启「切换时复制密码到剪贴板」，明文会短暂进入系统剪贴板。
4. 代理以 root 启动（systemd），但只做 HTTP 转发，不执行任何 shell。

## 目录结构

```
Open-Box-Patch/
├── README.md
├── install.sh                    # 安装（curl | sh，从本仓库下载）
├── uninstall.sh                  # 卸载
├── apply.sh                      # 前端重放脚本（幂等）
├── multi-backend.js              # 注入到面板 SPA 的前端脚本
├── proxy.mjs                     # 后端代理服务（零依赖 Node）
└── systemd/
    ├── openbox-patch.service     # oneshot，执行 apply.sh
    └── openbox-patch.path        # 监听 panel/dist 变化
```

> `openbox-mb-proxy.service` 由 `install.sh` 生成（需嵌入设备的 `node-preload`），未随仓库提供。

## systemd 单元（参考）

`openbox-patch.service`：

```ini
[Unit]
Description=Re-apply Open-Box multi-backend patch
ConditionPathExists=/opt/open-box/panel/dist/index.html

[Service]
Type=oneshot
ExecStart=/opt/open-box/data/multi-backend/apply.sh

[Install]
WantedBy=multi-user.target
```

`openbox-patch.path`：

```ini
[Unit]
Description=Watch Open-Box panel dist for upstream updates

[Path]
PathChanged=/opt/open-box/panel/dist/index.html
PathModified=/opt/open-box/panel/dist

[Install]
WantedBy=multi-user.target
```

`openbox-mb-proxy.service`（install.sh 生成，示意）：

```ini
[Unit]
Description=Open-Box multi-backend proxy (password auth + status)
After=network.target

[Service]
Type=simple
Environment=OPENBOX_MB_PORT=3037
Environment=OPENBOX_MB_BIND=0.0.0.0
ExecStart=/opt/open-box/node/bin/node /opt/open-box/data/multi-backend/proxy.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## 已知边界

1. **仅面向「浏览器面板」**（OpenWrt / Debian / Ubuntu 的路由器端面板）。桌面客户端 App（macOS / Windows / Linux）是另一套技术栈，本补丁不适用。
2. **切换语义为「导航跳转」**：验证密码后在新标签页打开目标面板；是否免登录取决于该面板在浏览器里已有的登录态（代理认证不等于浏览器已登录，可用「复制密码」在目标面板粘贴一次）。
3. **在线状态分级**：经代理且密码正确时为「真状态」（含版本、运行时长）；代理不可用或未填密码时退化为可达性（仅在线/离线）。
4. **混合内容**：面板若以 HTTPS 访问，浏览器会拦截对 HTTP 代理的请求，需为代理配置 HTTPS 或在「代理设置」里填可用的 HTTPS 地址。
5. **锚点依赖文案**：靠「运行时长 / 運行時長 / Uptime」定位插入点；若上游改动侧边栏 footer 结构，需同步微调 `multi-backend.js` 的 `UPTIME_LABELS` 与 `findUptimeRow`。

## 许可证

本仓库仅包含补丁脚本与前端注入脚本，不包含 Open-Box 的任何源码或二进制。

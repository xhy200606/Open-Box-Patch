# Open-Box Patch

为 [Open-Box](https://github.com/liandu2024/Open-Box) 面板添加**多后端管理**的补丁项目。以「运行时注入 + 升级后自动重放」的方式实现，**不修改上游任何源码或二进制，上游升级后自动恢复**。

在面板左下角「运行时长」下方新增「后端」管理区，对齐 [zashboard](https://github.com/Zephyruso/zashboard) 的多后端模型：

- **自动识别当前面板**，作为默认后端（首位、标记「当前」、不可删除）。
- **每个后端各自一个密码**；切换用密码**真认证**（服务端 `POST /api/auth/login`），密码错误不切换并提示重输。
- **原地显示**：点击后端后，在当前页面用一个铺满视口的 iframe 直接把目标面板渲染出来 —— **不跳转、不开新标签，顶层网页地址完全不变**。覆盖层顶部自带后端下拉与「返回本机 / 刷新 / 在新标签打开」，按 `Esc` 也可退出。
- **状态聚合**：在线 / 版本 / 内核运行时长，由服务端代理持续刷新。

## 支持的系统

| 平台 | 服务管理 | 补丁重放机制 | 安装位置 |
|---|---|---|---|
| **OpenWrt**（路由器原生形态） | procd | `openbox-multi-backend` 常驻轮询（约 15 秒） | `/etc/init.d/` |
| **Debian / Ubuntu** | systemd | `openbox-patch.path` 监听文件变化（即时） | `/etc/systemd/system/` |

安装脚本会自动识别（判据与上游 `update.sh` 一致：`/run/systemd/system` → systemd，`/etc/openwrt_release` 或 `procd` → OpenWrt），也可用 `--platform openwrt|systemd` 手动指定。

## 架构

补丁由三部分组成：

1. **前端注入脚本**（`multi-backend.js`）——注入到面板 SPA，渲染管理区、管理弹窗与**原地显示覆盖层**。数据模型与 zashboard 一致：`{ uuid, protocol, host, port, secondaryPath, label, password }`，存浏览器 `localStorage`。
2. **后端代理服务**（`proxy.mjs`，procd / systemd 常驻）——两件事：
   - **真认证 + 状态聚合**：在服务端用密码登录目标后端、持有其会话 Cookie，代为读取状态。
   - **反向代理**：把目标面板代理到代理服务自己的根路径下，让当前页面用一个**同站 iframe** 原地渲染它。
3. **重放脚本**（`apply.sh` + 平台各自的触发机制）——上游升级替换 `panel/` 后自动把注入标签补回去。

```
                          ┌─ 认证：POST /api/auth/login（服务端持有会话 Cookie）
浏览器(面板页) ──注入脚本──▶ 代理 :3037
   │                      └─ 反代：/  →  目标面板（Cookie 只存在于服务端）
   └── iframe(同主机:3037) ──▶ 原地渲染目标面板；顶层地址不变
```

**为什么必须反向代理**（而不是直接把 iframe 指向目标面板）：

- Open-Box 面板只认 Cookie 会话（`openbox_access_session`），且**未开 CORS** —— 浏览器无法跨域认证到另一台面板。
- 跨站 iframe 里，`SameSite=Lax` 的会话 Cookie 不会随请求发出，目标面板只会显示登录页（且登录后依然发不出 Cookie，形成死循环）。
- 面板前端全部使用**绝对路径** `/api/...`，WebSocket 用 `location.origin` 构造 —— 因此必须由代理在**自身根路径**上反向代理，路径前缀方案会破坏 API 调用。

代理会话仅在内存缓存（12 小时，上游 Cookie 本身 30 天有效），**不落盘**；上游下发的 `Set-Cookie` 一律被代理拦截，浏览器只持有代理自己的绑定 Cookie。

## 安装

需要 root。**OpenWrt 与 Debian / Ubuntu 使用同一条命令**，脚本自动识别平台。

直连 GitHub：

```sh
curl -fsSL https://raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/install.sh | sudo sh
```

GitHub 访问不畅时走镜像（默认 `gh-proxy.com`）：

```sh
curl -fsSL https://gh-proxy.com/raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/install.sh | sudo sh -s -- --mirror
```

本地目录安装 / 常用参数：

```sh
sudo sh install.sh
sudo sh install.sh --proxy-port 3037                 # 代理端口
sudo sh install.sh --proxy-bind 0.0.0.0              # 代理绑定地址（收紧为 127.0.0.1 则只允许本机）
sudo sh install.sh --proxy-token <口令>              # 给代理加访问口令
sudo sh install.sh --platform openwrt                # 跳过平台自动识别
```

参数说明：

| 参数 | 说明 |
|---|---|
| `--proxy-port <端口>` | 代理监听端口，默认 `3037` |
| `--proxy-bind <地址>` | 代理绑定地址，默认 `0.0.0.0` |
| `--proxy-token <口令>` | 给代理加访问口令（需与面板「后端管理 → 代理设置」填的一致） |
| `--platform openwrt\|systemd` | 跳过平台自动识别 |
| `--mirror [前缀]` | 走 GitHub 镜像（默认 `https://gh-proxy.com/`） |
| `--direct` | 强制直连 GitHub |

安装脚本会：

1. 把补丁文件下载到 `$ROOT/data/multi-backend/`（`data/` 在上游升级时被保留）；
2. 写入统一配置 `$ROOT/data/multi-backend/proxy.conf`（端口 / 绑定 / 口令）；
3. 安装平台对应的服务：
   - OpenWrt：`/etc/init.d/openbox-multi-backend`（重放）、`/etc/init.d/openbox-mb-proxy`（代理），并 `enable` + 启动；
   - Debian：`openbox-patch.{service,path}`、`openbox-mb-proxy.service`，并 `enable` + 启动；
4. 立即执行一次 `apply.sh` 完成注入。

**重复安装会保留你已改过的代理配置**（端口 / 绑定 / 口令），只有显式传参才会覆盖。环境变量 `OPENBOX_ROOT`、`OPENBOX_SYSD_DIR`、`OPENBOX_INITD_DIR` 可覆盖安装根目录与服务目录。

装完刷新面板页面，左下角出现「后端」管理区。

## 使用

- 点「后端」区右上角 **⚙** 打开管理弹窗。
- **添加后端**：协议（HTTP/HTTPS）、主机 / IP、端口、路径前缀（可选）、名称、密码（必填）。可先点「测试连接」验证。
- **切换**：点侧栏中的后端行或列表里的「切换」—— 代理用该密码登录验证，通过后**在当前页面原地显示**该后端；失败则提示重输密码。
- **原地显示中切换**：覆盖层顶部有后端下拉，可直接换目标；`← 返回本机` 或 `Esc` 退出；`↻ 刷新` 重新载入；`在新标签打开` 用独立标签页打开（兜底）。
- **删除**：列表里的「删除」（「当前」本机不可删）。删除正在查看的后端会自动退出覆盖层。
- **代理设置**：修改代理服务地址（默认 `http://<本机>:3037`）、是否在切换时也把密码复制到剪贴板（默认关；原地显示已由代理完成认证，仅在目标面板偶发要求重新登录时用得上）。

同一标签页刷新后会**自动恢复**上一次正在查看的后端（记录在 `sessionStorage`，关闭标签即清除）。

## 卸载

```sh
curl -fsSL https://raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/uninstall.sh | sudo sh
```

会停用并删除平台对应的服务文件、移除注入脚本、还原 `index.html`、删除补丁数据目录。同样支持 `--platform` 指定，且在平台无法识别时会**同时清理两套服务文件**，避免留下孤儿服务。

## 升级后是否自动恢复

是。

- **Debian**：systemd `path` 单元检测到 `panel/dist/index.html` 变化后立即触发 `openbox-patch.service` 重新注入。
- **OpenWrt**：`openbox-multi-backend` 常驻轮询（默认 15 秒，可用 `data/multi-backend/watch-interval` 调整，最小 5 秒），发现 `index.html` 或补丁脚本变化就重新注入。

两条路径都调用幂等的 `apply.sh`，手动重放：

```sh
# OpenWrt
/etc/init.d/openbox-multi-backend restart
# Debian
sudo systemctl restart openbox-patch.service
# 通用
sudo sh /opt/open-box/data/multi-backend/apply.sh
```

## 原理要点

- **注入点**：`panel/dist/index.html` 末尾追加 `<script src="./multi-backend.js?v=<hash>"></script>`，并把自包含脚本放到 `panel/dist/`。
- **缓存穿透**：面板对 `index.html/sw.js` 之外的文件返回一年强缓存（`immutable`），故注入标签带内容哈希；补丁更新后哈希变化、URL 变化，浏览器自动拉新版本。
- **锚点定位**：查找文案为「运行时长 / 運行時長 / Uptime」的叶子 `<span>`，把管理区插到其所在整行下方；配合 `MutationObserver` 应对 SPA 重渲染。
- **自身状态**：当前面板为同源，直接读 `/api/openbox/update/status`、`/api/openbox/service/status`（携带 Cookie）。
- **其它后端状态**：经代理 `POST /api/mb/status {url,password}`；代理不可用时回退为 `no-cors` 可达性探测（仅在线/离线）。
- **原地显示**：注入脚本把 iframe 指向 `代理/__mb/open?t=<base64url(目标地址)>`，代理校验「该目标已有有效服务端会话」后下发绑定 Cookie 并 302 到 `/`，之后 `/` 下的所有请求（HTML、静态资产、`/api/*`、WebSocket `/api/controller-ws`）都反代到目标面板。
- **反向代理细节**：逐跳头剥离、`Location` 改写到代理自身 origin、请求 `Origin/Referer` 改写、上游 `Set-Cookie` 被拦截并在服务端捕获、WebSocket 握手与数据双向中继。

## 代理服务接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/mb/health` | 自检，返回 `{ok,service,version,targets}` |
| POST | `/api/mb/status` | 请求体 `{url,password}`；返回 `{online,authenticated,version,uptimeSeconds,...}`，并建立服务端会话 |
| GET | `/__mb/open?t=<base64url>` | 把当前浏览器会话绑定到该后端（**要求该后端已认证**），302 到 `/` |
| GET | `/__mb/close` | 解绑当前浏览器会话 |
| 其它任意路径 | — | 反向代理到当前绑定的后端（含 WebSocket） |

代理所调用的上游接口（Open-Box 面板）：

- `POST /api/auth/login`（JSON `{password}`，成功返回 `Set-Cookie`；401 表示密码错）
- `GET  /api/auth/status`（免鉴权，`{enabled,authenticated}`）
- `GET  /api/openbox/update/status`（鉴权，版本；不出网）
- `GET  /api/openbox/service/status`（鉴权，内核运行状态与 `uptimeSeconds`）

代理环境变量：`OPENBOX_MB_PORT`（默认 3037）、`OPENBOX_MB_BIND`（默认 0.0.0.0）、`OPENBOX_MB_TOKEN`（可选，设后 `/api/mb/*` 需请求头 `X-MB-Token` 匹配）、`OPENBOX_MB_TIMEOUT`（默认 6000ms）。运行时改配置不必改环境变量：编辑 `data/multi-backend/proxy.conf` 后重启服务即可。

## 目录结构

```
Open-Box-Patch/
├── README.md
├── install.sh                       # 安装（自动识别 OpenWrt / systemd）
├── uninstall.sh                     # 卸载
├── apply.sh                         # 前端重放脚本（幂等）
├── watch.sh                         # OpenWrt 用的变更轮询（systemd 走 path 单元）
├── multi-backend.js                 # 注入到面板 SPA 的前端脚本
├── proxy.mjs                        # 后端代理服务（认证 + 状态 + 反向代理，零依赖 Node）
├── openwrt/initd/
│   ├── openbox-multi-backend        # procd：启动即重放 + 常驻轮询
│   └── openbox-mb-proxy             # procd：代理服务
└── systemd/
    ├── openbox-patch.service        # oneshot，执行 apply.sh
    └── openbox-patch.path           # 监听 panel/dist 变化
```

> `systemd/` 下的两个文件是**默认根目录 `/opt/open-box` 的参考副本**；`install.sh` 会按实际安装根目录生成到 `/etc/systemd/system/`，`openbox-mb-proxy.service` 也在安装时生成（需嵌入设备的 `node-preload`），因此自定义根目录不会写死 `/opt/open-box`。

## 服务与配置速查

```sh
# OpenWrt
/etc/init.d/openbox-mb-proxy        {start|stop|restart|enable|disable}
/etc/init.d/openbox-multi-backend   {start|stop|restart|enable|disable}
# Debian
systemctl {status|restart} openbox-mb-proxy.service
systemctl {status|restart} openbox-patch.path
```

配置：`/opt/open-box/data/multi-backend/proxy.conf`

```
OPENBOX_MB_PORT=3037
OPENBOX_MB_BIND=0.0.0.0
OPENBOX_MB_TOKEN=
```

## 安全边界

1. 代理默认监听 `0.0.0.0:3037`，**同一局域网内可访问**；请只在可信局域网部署。
2. `/api/mb/status` 接受任意 http(s) 地址并代为请求，因此整块 `/api/mb/*` 建议设置 `OPENBOX_MB_TOKEN`。
3. 反向代理入口 `/__mb/open` **只接受已经通过密码认证、服务端存在有效会话的后端地址**——未认证的任意地址打不开，代理不会被当作任意内网 URL 的转发器。同时拒绝链路本地 / 云元数据地址（`169.254.*`、`fe80::*`、`0.0.0.0`、`::`）与把自己当后端（防自环）。
4. 代理内置按 IP 限流（60 次/分钟）。
5. 密码保存在**浏览器 `localStorage`**，切换/刷新时经局域网发给代理；代理仅在内存持有会话 Cookie，不落盘。若开启「切换时复制密码到剪贴板」，明文会短暂进入系统剪贴板。
6. 上游面板的 `Set-Cookie` 不会下发到浏览器，浏览器只持有代理自己的绑定 Cookie（`openbox_mb_target`，`HttpOnly; SameSite=Lax`，仅编码目标地址、非凭据）。注意浏览器 Cookie **不按端口隔离**，同主机上面板页与代理共享 Cookie 域，故代理对其加了 `HttpOnly`，页面脚本读不到。
7. 代理以 root 启动（procd / systemd），但只做 HTTP 转发，不执行任何 shell。

## 已知边界

1. **仅面向「浏览器面板」**（OpenWrt / Debian / Ubuntu 的路由器端面板）。桌面客户端 App（macOS / Windows / Linux）是另一套技术栈，本补丁不适用。
2. **代理需与面板同主机**（默认部署即如此，只差端口）。若把代理地址改成另一台主机，iframe 会处于跨站上下文，`SameSite=Lax` 的绑定 Cookie 不会被发出，原地显示会停在提示页 —— 此时注入脚本会给出一次提示，也可退化为「在新标签打开」。
3. **绑定粒度是每个浏览器的代理 origin**：同一浏览器多个标签共享同一个「当前后端」，切换其中一个标签的目标会影响其它标签；需要并行看两台后端请用「在新标签打开」（每个标签各自独立的后端地址）。
4. **在线状态分级**：经代理且密码正确时为「真状态」（含版本、运行时长）；代理不可用或未填密码时退化为可达性（仅在线/离线）。
5. **混合内容**：面板若以 HTTPS 访问，浏览器会拦截对 HTTP 代理的请求，需为代理配置 HTTPS 或在「代理设置」里填可用的 HTTPS 地址。
6. **锚点依赖文案**：靠「运行时长 / 運行時長 / Uptime」定位插入点；若上游改动侧边栏 footer 结构，需同步微调 `multi-backend.js` 的 `UPTIME_LABELS` 与 `findUptimeRow`。
7. **上游升级会重铺 `/etc/init.d/openbox`、`/etc/init.d/openbox-panel`**，但不会触碰本补丁新增的 `openbox-multi-backend`、`openbox-mb-proxy`，因此补丁在升级后依然常驻。

## 许可证

本仓库仅包含补丁脚本与前端注入脚本，不包含 Open-Box 的任何源码或二进制。

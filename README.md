# Open-Box Patch

为 [Open-Box](https://github.com/liandu2024/Open-Box) 面板添加功能的补丁项目。以「运行时注入 + 升级后自动重放」的方式实现，**不修改上游任何源码或二进制，上游升级后自动恢复**。

目前包含两个功能：

## 一、多后端管理

在面板左下角「运行时长」下方新增「后端」管理区，对齐 [zashboard](https://github.com/Zephyruso/zashboard) 的多后端模型：

- **自动识别当前面板**，作为默认后端（首位、标记「当前」、不可删除）。
- **每个后端各自一个密码**；切换用密码**真认证**（服务端 `POST /api/auth/login`），密码错误不切换并提示重输。
- **原地显示**：点击后端后，在当前页面用一个铺满视口的 iframe 直接把目标面板渲染出来 —— **不跳转、不开新标签，顶层网页地址完全不变**。覆盖层顶部自带后端下拉与「返回本机 / 刷新 / 在新标签打开」，按 `Esc` 也可退出。
- **状态聚合**：在线 / 版本 / 内核运行时长，由服务端代理持续刷新。

## 二、全球连接（地图）

在面板「概览」页的**「域名过滤」卡片正下方**新增一张「全球连接」卡片 —— 从 [zashboard](https://github.com/Zephyruso/zashboard) 的 `EarthGlobeCard` 移植而来：

- **3D 地球 / 2D 平面**双投影（带形变动画），星空与扁平两种视觉风格，可暂停自转、显示/隐藏城市标签、一键展开全屏。
- 把**活跃连接的端点按 IP 归属**打点在地球上，从本机画到各目的地的**连接弧线**（经代理 / 直连分色），带流动特效。
- 悬停端点显示**城市 / 国家 / 连接数 / 下载量 Top 5 Host**。
- 公网 IP 归属支持 `ip.sb` / `ipwho.is` / `ipapi.is` / `ipip.net` 切换。

与上游 zashboard 的差别在于**数据来源**：IP → 城市的解析改用随补丁部署的**服务端代理镜像的 DB-IP 城市库**（局域网内只需下一次，约 62 MB），公网 IP 探测也由代理出网完成，浏览器侧因此没有跨域与混合内容问题。

## 支持的系统

| 平台 | 服务管理 | 补丁重放机制 | 安装位置 |
|---|---|---|---|
| **OpenWrt**（路由器原生形态） | procd | `openbox-multi-backend` 常驻轮询（约 15 秒） | `/etc/init.d/` |
| **Debian / Ubuntu** | systemd | `openbox-patch.path` 监听文件变化（即时） | `/etc/systemd/system/` |

安装脚本会自动识别（判据与上游 `update.sh` 一致：`/run/systemd/system` → systemd，`/etc/openwrt_release` 或 `procd` → OpenWrt），也可用 `--platform openwrt|systemd` 手动指定。

## 架构

补丁由四部分组成：

1. **前端注入脚本**（`multi-backend.js`）——注入到面板 SPA，渲染管理区、管理弹窗与**原地显示覆盖层**。数据模型与 zashboard 一致：`{ uuid, protocol, host, port, secondaryPath, label, password }`，存浏览器 `localStorage`。
2. **后端代理服务**（`proxy.mjs`，procd / systemd 常驻）——四件事：
   - **真认证 + 状态聚合**：在服务端用密码登录目标后端、持有其会话 Cookie，代为读取状态。
   - **反向代理**：把目标面板代理到代理服务自己的根路径下，让当前页面用一个**同站 iframe** 原地渲染它。
   - **城市库镜像**：把 DB-IP City Lite（约 62 MB）缓存到本机 `data/multi-backend/globe-cache/`，局域网内设备只从路由器取一次。
   - **公网 IP 归属**：由代理出网查询，规避浏览器跨域。
3. **重放脚本**（`apply.sh` + 平台各自的触发机制）——上游升级替换 `panel/` 后自动把注入标签与补丁资产补回去。
4. **地球仪前端产物**（`openbox-globe.js` + `globe.bundle.js` + `globe.worker.js` + `globe-assets/`）——由 `globe/` 源码目录用 esbuild 构建（three.js 打包进 bundle，MMDB 解析放在 Worker）。

```
                          ┌─ 认证：POST /api/auth/login（服务端持有会话 Cookie）
浏览器(面板页) ──注入脚本──▶ 代理 :3037
   │                      ├─ 反代：/  →  目标面板（Cookie 只存在于服务端）
   │                      ├─ 城市库镜像：/api/mb/globe/db → 本机缓存
   │                      └─ 公网 IP：/api/mb/globe/public-ip
   ├── iframe(同主机:3037) ──▶ 原地渲染目标面板；顶层地址不变
   └── 概览页「全球连接」──▶ globe.worker.js 本地解析 IP → 经纬度 → three.js 渲染
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

## 使用 · 全球连接

刷新页面后进入「概览」，在「域名过滤」卡片下方即可看到「全球连接」。

- **首次使用需点一次「下载数据库」**（这是上游 zashboard 的既有设计：约 62 MB 的城市库要在浏览器本地解析 IP 归属）。数据库由本机代理转发，因此这一次下载发生在局域网内、不走公网。
- 下载完成后，解析结果缓存在浏览器 IndexedDB（约 127 MB），30 天内不再重复下载。
- **3D / 2D** 切换投影；**星空 / 扁平** 切换地球样式；📍 切换城市名标签；⏸ 暂停自转；⛶ 展开为全屏（`Esc` 退出）。
- 左上角下拉可切换公网 IP 服务；`本机 IP` 旁的 👁 可隐藏明文（默认掩码显示）。
- 鼠标悬停在端点圆点上显示该端点的城市 / 国家 / 连接数与下载量 Top 5 Host。

排障时可在浏览器控制台执行 `__openboxGlobe.state()` 查看当前数据库状态、归属结果、连接线路数等。

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

- **注入点**：`panel/dist/index.html` 末尾追加 `<script src="./multi-backend.js?v=<hash>"></script>` 与 `<script src="./openbox-globe.js?v=<hash>"></script>`，并把自包含脚本与资产放到 `panel/dist/`（地球贴图落在 `panel/dist/globe-assets/earth/`）。
- **缓存穿透**：面板对 `index.html/sw.js` 之外的文件返回一年强缓存（`immutable`），故注入标签带内容哈希；补丁更新后哈希变化、URL 变化，浏览器自动拉新版本。`openbox-globe.js` 的哈希**同时覆盖 `globe.bundle.js` 与 `globe.worker.js`**，否则改了 bundle 而标签哈希不变，浏览器会用旧 bundle。
- **锚点定位**：查找文案为「运行时长 / 運行時長 / Uptime」的叶子 `<span>`，把管理区插到其所在整行下方；配合 `MutationObserver` 应对 SPA 重渲染。
- **自身状态**：当前面板为同源，直接读 `/api/openbox/update/status`、`/api/openbox/service/status`（携带 Cookie）。
- **其它后端状态**：经代理 `POST /api/mb/status {url,password}`；代理不可用时回退为 `no-cors` 可达性探测（仅在线/离线）。
- **原地显示**：注入脚本把 iframe 指向 `代理/__mb/open?t=<base64url(目标地址)>`，代理校验「该目标已有有效服务端会话」后下发绑定 Cookie 并 302 到 `/`，之后 `/` 下的所有请求（HTML、静态资产、`/api/*`、WebSocket `/api/controller-ws`）都反代到目标面板。
- **反向代理细节**：逐跳头剥离、`Location` 改写到代理自身 origin、请求 `Origin/Referer` 改写、上游 `Set-Cookie` 被拦截并在服务端捕获、WebSocket 握手与数据双向中继。
- **地球仪注入点**：概览页卡片容器中「域名过滤」`<section>` 的紧随位置；该页卡片是异步逐张渲染的（面板概览 → 域名过滤 → 流量洞察 …），且**域名过滤关闭时不会渲染**，因此注入脚本每次维护都会校正一次位置，找不到锚点时追加在容器末尾。
- **地球仪样式自带**：面板的 Tailwind 是按用到的类裁剪的，`h-96`、`bg-black`、`bg-base-100/75` 这类原子类在不同上游版本里可能不存在（当前版本就没有 `h-96`）。因此卡片的尺寸 / 定位 / 间距全部由注入脚本自带的 `.ob-globe-*` 样式表提供，只借用面板的 daisyUI 主题变量（`--color-*`）与 `btn` / `select` 组件类保持观感一致。
- **地球仪数据**：连接列表取面板自身的 Clash 兼容接口（`/api/controller-ws/connections`，不可用时退化为轮询 `/api/controller/connections`）；「直连 / 经代理」通过 `/api/controller/proxies` 里的出站类型判定；IP → 经纬度在浏览器 Worker 内用 DB-IP 城市库完成。

## 代理服务接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/mb/health` | 自检，返回 `{ok,service,version,targets}` |
| POST | `/api/mb/status` | 请求体 `{url,password}`；返回 `{online,authenticated,version,uptimeSeconds,...}`，并建立服务端会话 |
| GET | `/__mb/open?t=<base64url>` | 把当前浏览器会话绑定到该后端（**要求该后端已认证**），302 到 `/` |
| GET | `/__mb/close` | 解绑当前浏览器会话 |
| GET | `/api/mb/globe/health` | 地球仪后端探针，返回 `{ok,dbCached,dbBytes,dbUrl}` |
| GET | `/api/mb/globe/public-ip?api=&ip=` | 服务端出网查询公网 IP 归属；`api` 取 `ip.sb` / `ipwho.is` / `ipapi.is` / `ipip.net`，结果缓存 5 分钟 |
| GET | `/api/mb/globe/db` | 镜像并缓存 DB-IP City Lite（约 62 MB，gzip 原样透传）；命中缓存时带响应头 `X-MB-Cache: HIT` |
| 其它任意路径 | — | 反向代理到当前绑定的后端（含 WebSocket） |

代理所调用的上游接口（Open-Box 面板）：

- `POST /api/auth/login`（JSON `{password}`，成功返回 `Set-Cookie`；401 表示密码错）
- `GET  /api/auth/status`（免鉴权，`{enabled,authenticated}`）
- `GET  /api/openbox/update/status`（鉴权，版本；不出网）
- `GET  /api/openbox/service/status`（鉴权，内核运行状态与 `uptimeSeconds`）

代理环境变量：`OPENBOX_MB_PORT`（默认 3037）、`OPENBOX_MB_BIND`（默认 0.0.0.0）、`OPENBOX_MB_TOKEN`（可选，设后 `/api/mb/*` 需请求头 `X-MB-Token` 匹配）、`OPENBOX_MB_TIMEOUT`（默认 6000ms）、`OPENBOX_MB_CACHE`（城市库缓存目录，默认 `data/multi-backend/globe-cache`）、`OPENBOX_MB_DB_URL`（城市库源地址，默认 jsDelivr；离线环境可指向自建镜像）。运行时改配置不必改环境变量：编辑 `data/multi-backend/proxy.conf` 后重启服务即可（`OPENBOX_MB_CACHE` / `OPENBOX_MB_DB_URL` 需写进配置文件或服务单元的环境变量）。

## 目录结构

```
Open-Box-Patch/
├── README.md
├── install.sh                       # 安装（自动识别 OpenWrt / systemd）
├── uninstall.sh                     # 卸载
├── apply.sh                         # 前端重放脚本（幂等）
├── watch.sh                         # OpenWrt 用的变更轮询（systemd 走 path 单元）
├── multi-backend.js                 # 注入到面板 SPA 的前端脚本（多后端）
├── openbox-globe.js                 # 注入到面板 SPA 的前端脚本（全球连接，懒加载 bundle）
├── globe.bundle.js                  # 地球仪前端产物（构建产物，含 three.js）
├── globe.worker.js                  # 地球仪 IP→城市 Worker 产物（MMDB 解析）
├── proxy.mjs                        # 后端代理服务（认证 + 状态 + 反代 + 城市库镜像 + 公网 IP）
├── globe/                           # 地球仪源码（移植自 zashboard）+ 构建脚本
│   ├── src/earth/                   # 上游 earth/* 模块（最小改动）
│   ├── src/helper/                  # 上游 mmdb.ts / geoip-chunk-store.ts
│   ├── src/adapters/                # 本补丁的适配层（连接、归属、主题、运行期配置）
│   ├── src/index.ts                 # 「全球连接」卡片（替代上游 EarthGlobeCard.vue）
│   ├── src/worker.ts                # Worker 入口
│   ├── assets/earth/                # 地球贴图（Solar System Scope · CC BY 4.0）
│   ├── build.mjs                    # esbuild 构建脚本
│   ├── NOTICE.md                    # 第三方来源与许可
│   └── LICENSE.zashboard            # 上游 zashboard 的 MIT 许可
├── openwrt/initd/
│   ├── openbox-multi-backend        # procd：启动即重放 + 常驻轮询
│   └── openbox-mb-proxy             # procd：代理服务
└── systemd/
    ├── openbox-patch.service        # oneshot，执行 apply.sh
    └── openbox-patch.path           # 监听 panel/dist 变化
```

> 地球仪产物已提交，安装时无需构建工具链。要改地球仪源码后重新构建：
> `cd globe && npm install && npm run build`（需 Node 20+，产物直接写到仓库根目录）。

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
8. **城市库镜像**：`/api/mb/globe/db` 会把约 62 MB 的 DB-IP 城市库缓存在本机 `data/multi-backend/globe-cache/`，同网段任何设备都可取。它不含隐私数据（是公开的 IP 归属库），但会占用约 62 MB 磁盘。不想要这个缓存可以删除该目录（下次请求会重新下载）。
9. **IP 归属在浏览器侧完成**：连接端点不会被送到任何第三方接口（使用的只有本机代理与公开城市库）；但**公网 IP 探测**（`/api/mb/globe/public-ip`）会由代理向所选服务（`ip.sb` / `ipwho.is` / `ipapi.is` / `ipip.net`）出网，暴露本机出口 IP 给该服务。

## 已知边界

1. **仅面向「浏览器面板」**（OpenWrt / Debian / Ubuntu 的路由器端面板）。桌面客户端 App（macOS / Windows / Linux）是另一套技术栈，本补丁不适用。
2. **代理需与面板同主机**（默认部署即如此，只差端口）。若把代理地址改成另一台主机，iframe 会处于跨站上下文，`SameSite=Lax` 的绑定 Cookie 不会被发出，原地显示会停在提示页 —— 此时注入脚本会给出一次提示，也可退化为「在新标签打开」。
3. **绑定粒度是每个浏览器的代理 origin**：同一浏览器多个标签共享同一个「当前后端」，切换其中一个标签的目标会影响其它标签；需要并行看两台后端请用「在新标签打开」（每个标签各自独立的后端地址）。
4. **在线状态分级**：经代理且密码正确时为「真状态」（含版本、运行时长）；代理不可用或未填密码时退化为可达性（仅在线/离线）。
5. **混合内容**：面板若以 HTTPS 访问，浏览器会拦截对 HTTP 代理的请求，需为代理配置 HTTPS 或在「代理设置」里填可用的 HTTPS 地址。
6. **锚点依赖文案**：靠「运行时长 / 運行時長 / Uptime」定位插入点；若上游改动侧边栏 footer 结构，需同步微调 `multi-backend.js` 的 `UPTIME_LABELS` 与 `findUptimeRow`。
7. **上游升级会重铺 `/etc/init.d/openbox`、`/etc/init.d/openbox-panel`**，但不会触碰本补丁新增的 `openbox-multi-backend`、`openbox-mb-proxy`，因此补丁在升级后依然常驻。
8. **地球仪的 WebGL 依赖**：需要浏览器支持 WebGL2（面板本身的技术栈也如此）。渲染优先走 WebGPU，不支持时 three.js 自动回退 WebGL2；两者都不可用时卡片会显示「当前浏览器无法使用 3D 渲染」。
9. **地球仪首屏需要一次 62 MB 下载**（上游 zashboard 的既有设计，需用户点确认），之后缓存在浏览器 IndexedDB 30 天。慢速设备上首次下载 + 解压 + 写库可能需要一两分钟。
10. **代理需与面板同主机**（对地球仪同样成立）：城市库与公网 IP 请求都指向 `<面板主机>:3037`，跨主机时浏览器会因 CORS/混合内容拦截；此时卡片会显示「未检测到本机的多后端代理服务」。
11. **概览页卡片顺序会变**：补丁把卡片放在「域名过滤」正下方；若上游增删概览卡片或改名，`openbox-globe.js` 的 `DOMAIN_FILTER_LABELS` 可能需要同步补文案。

## 许可证

本仓库中的补丁脚本、前端注入脚本、代理服务与适配层均为本项目的原创代码，不包含 Open-Box 的任何源码或二进制。

「全球连接」地球仪功能移植自 [zashboard](https://github.com/Zephyruso/zashboard)（**MIT License**，Copyright 2024 Zephyruso），所移植文件与改动清单见 [`globe/NOTICE.md`](globe/NOTICE.md) 与 [`globe/LICENSE.zashboard`](globe/LICENSE.zashboard)。

地球贴图来自 [Solar System Scope](https://www.solarsystemscope.com/textures/)（**CC BY 4.0**），城市数据库为 [DB-IP City Lite](https://db-ip.com/db/lite.php)（**CC BY 4.0**），界面右下角保留了原始出处链接。

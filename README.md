# Open-Box Patch

为 [Open-Box](https://github.com/liandu2024/Open-Box) 面板添加**多后端切换器**的补丁项目。

以「运行时注入 + 升级后自动重放」的方式，在面板左下角「运行时长」下方新增一个「后端」管理区：可添加多台 Open-Box 后端（名称 + 地址），实时显示在线 / 离线状态，点击即在浏览器打开对应面板。**不修改上游任何源码或二进制，上游升级后自动恢复。**

## 效果

面板左下角「运行时长」下方出现「后端」区：

- 点右上角 `+` 添加后端：名称（如「家里路由器」）+ 地址（如 `192.168.1.2:3036`，可省略 `http://`）。
- 每个后端前有状态点：<span style="color:#22c55e">●</span> 在线、<span style="color:#9ca3af">●</span> 离线，每 15 秒自动刷新。
- 点击某个后端即在浏览器新标签页打开对应面板。
- 鼠标悬停后端行，右侧出现 `×` 可删除。

后端列表保存在浏览器 `localStorage`（键 `openbox.multiBackend.v1`），与面板文件、上游升级完全隔离。

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

也可以把仓库文件下载到本地后安装：

```sh
sudo sh install.sh
# 指定镜像前缀：
sudo sh install.sh --mirror https://gh-proxy.com/
```

安装脚本会：

1. 把补丁文件放到 `/opt/open-box/data/multi-backend/`（该目录在上游升级时被保留）；
2. 安装 systemd 单元 `/etc/systemd/system/openbox-patch.{service,path}`；
3. 立即执行一次 `apply.sh`。

装完刷新面板页面即可看到「后端」管理区。

## 卸载

```sh
curl -fsSL https://raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/uninstall.sh | sudo sh
```

会移除 systemd 单元、注入脚本，并还原 `index.html`（优先用备份，否则按行删除注入标签）。

## 升级后是否自动恢复

是。上游 `update.sh` 升级时会整体替换 `/opt/open-box/panel/`，systemd `path` 单元检测到 `panel/dist/index.html` 变化后自动调用 `apply.sh` 重新注入（幂等）。也可随时手动重放：

```sh
sudo sh /opt/open-box/data/multi-backend/apply.sh
```

## 工作原理

- **注入点**：`panel/dist/index.html` 末尾追加一行 `<script src="./multi-backend.js?v=<hash>"></script>`，并把自包含的 `multi-backend.js` 放到 `panel/dist/`。
- **升级自动重放**：补丁资产存在 `/opt/open-box/data/multi-backend/`（`data/` 目录升级时保留）；systemd `path` 单元监听 `panel/dist`，上游替换 `panel/` 后自动重跑 `apply.sh`。
- **缓存穿透**：面板对 `index.html` / `sw.js` 之外的文件返回一年强缓存（`immutable`），因此注入标签带内容哈希 `?v=<hash>`；补丁更新后哈希变化、URL 变化，浏览器自动拉取新版本。
- **不依赖 CORS**：面板未配置 CORS，跨后端读取响应会被浏览器拦截；在线状态改用 `no-cors` 可达性探测（`GET /api/health`，该端点免鉴权），只判断可达 / 不可达，不读取响应体。
- **锚点定位**：脚本在 DOM 中查找文案为「运行时长 / 運行時長 / Uptime」的叶子 `<span>`，把管理区插到其所在整行下方；配合 `MutationObserver` 应对 SPA 重渲染。

## 目录结构

```
Open-Box-Patch/
├── README.md
├── install.sh                # 安装（支持 curl | sh，从本仓库下载）
├── uninstall.sh              # 卸载
├── apply.sh                  # 重放脚本（幂等，安装到 data/multi-backend/）
├── multi-backend.js          # 注入到前端 SPA 的自包含脚本
└── systemd/
    ├── openbox-patch.service # oneshot，执行 apply.sh
    └── openbox-patch.path    # 监听 panel/dist 变化
```

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

## 已知边界与取舍

1. **仅面向「浏览器面板」**（OpenWrt / Debian / Ubuntu 的路由器端面板）。桌面客户端 App（macOS / Windows / Linux）是另一套技术栈，本补丁不适用。
2. **切换语义为「导航跳转」**：点击后端在新标签页打开该面板，由目标面板自身完成登录鉴权。不做「单页聚合」——那需要在一台后端上架设服务端代理并保存其它后端密码，复杂度与安全代价更高。
3. **密码不落地**：导航式切换无需在本地保存后端密码，避免明文凭据风险。
4. **在线状态为「可达性」级别**：仅区分能 / 不能访问面板端口，不读取版本、运行时长等详情（受同源策略限制）。
5. **注入锚点依赖文案**：通过「运行时长 / 運行時長 / Uptime」三种文案定位插入点；若上游未来改动侧边栏 footer 结构，需同步微调 `multi-backend.js` 中的 `UPTIME_LABELS` 与 `findUptimeRow`。

## 许可证

本仓库仅包含补丁脚本与前端注入脚本，不包含 Open-Box 的任何源码或二进制。

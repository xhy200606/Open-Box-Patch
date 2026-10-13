# Open-Box Patch

为 [Open-Box](https://github.com/liandu2024/Open-Box) 浏览器面板提供多后端管理、集中版本维护和概览地图。支持 OpenWrt、Debian 和 Ubuntu。

## 功能

- **多后端切换**：保留主面板的前端页面，读取所选服务器的策略、连接和设置。
- **当前后端标识**：在左下角后端管理器显示名称，并用面板主题强调色选中当前后端。
- **拖动排序**：拖动 ⠿ 调整远程后端顺序，支持鼠标和触屏，自动保存；本机前端固定首位。
- **版本管理**：集中查看各服务器的 OpenBox 和 Patch 版本，支持检查版本、单台及批量更新。
- **批量重启**：勾选服务器后重启其 OpenBox 内核，各服务器分别显示操作结果。
- **设置入口**：OpenBox「设置 → 后端设置」可查看和更新当前后端的 Patch。
- **概览地图**：概览页显示全球连接、端点归属和连接线路；本机 IP 与地图起点取自当前后端，DNS 设置页不显示地图。
- **线路分类**：按实际出站配置把每条连接判为**直连 / 经代理（单跳）/ 经中转（经中转再代理）**。判定只看链路本身，与「显示中转」开关无关；「经中转再代理」里的中转节点与落地节点分开标记，不会和「本机经代理」混成一种颜色。
- **按链路画线**：直连一路画到目的地；经代理 / 经中转只画**流量实际经过的代理链路**（… → 落地节点），终点是最后一个代理节点，不再多画一条到最终目标的线。
- **地图记忆与中转**：自动记住 2D／3D、地图样式、城市标签、自转及中转显示设置；开启「显示中转」后把中转节点画到地图上，图例包括本机、直连、经代理／落地节点、经中转／中转节点。

## 安装与更新

先安装 Open-Box，再以 root 权限运行以下命令。更新补丁使用相同命令，保留已有代理配置。

直连 GitHub：

```sh
curl -fsSL https://raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/install.sh | sh
```

通过镜像下载：

```sh
curl -fsSL https://gh-proxy.com/raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/install.sh | sh -s -- --mirror
```

Debian / Ubuntu 普通用户将上述 `sh` 替换为 `sudo sh`。安装后刷新主面板。

本地安装及常用参数：

```sh
sh install.sh
sh install.sh --proxy-port 3037
sh install.sh --proxy-token <代理口令>
sh install.sh --panel-url http://127.0.0.1:3036
sh install.sh --platform openwrt
```

每台需要远程更新 Patch 的服务器，先安装一次支持版本管理的补丁。代理使用其他端口、HTTPS 或访问口令时，在该后端的编辑页填写对应信息。

## 使用

1. 点击左下角「后端」管理器的 ⚙，添加服务器地址、名称和面板密码。
2. 点击服务器切换后端。左下角名称和强调色同步更新，页面读取该服务器的数据。
3. 打开管理列表，拖动 ⠿ 调整顺序；勾选服务器后选择批量更新或批量重启。
4. 更新和重启前会列出所选服务器供确认。批量重启操作针对 OpenBox 内核。
5. 在「设置 → 后端设置」查看当前后端的 Patch 版本和更新入口。

概览地图首次使用需在卡片中下载城市数据库，然后显示活跃连接的 IP 归属。地图仅出现在概览页。

地图颜色表示线路类别：**青=经代理**（单跳）、**紫=经中转**（经中转再代理）、**橙=直连**，白点为本机。
直连一路画到目的地；经代理 / 经中转只画链路本身（如「本机南京 → 中转上海 → 落地东京」画成
`南京→上海→东京`），**终点停在最后一个代理节点，不再画到最终目标** —— 于是同一代理下的所有连接
会合并成一条线，地图更干净。开启「显示中转」可把**紫色中转节点**也画出来（落地节点是链路终点，始终画）。
把鼠标移到端点上可看到它的角色（本机 / 中转节点 / 落地节点 / 目的地）、所属线路类别、连接数，
以及**流经该落地节点的下载量 Top5 Host**。

## 卸载

以 root 权限运行：

```sh
curl -fsSL https://raw.githubusercontent.com/xhy200606/Open-Box-Patch/main/uninstall.sh | sh
```

本地卸载：`sh uninstall.sh`。

## 开发

修改地图源码后构建：

```sh
cd frontend/globe
npm install
npm run build
cd ../..
```

运行模拟服务器集成测试与语法检查：

```sh
node --test tests/*.test.mjs
node --check frontend/multi-backend.js
node --check backend/proxy.mjs
sh -n install.sh scripts/apply.sh scripts/update-patch.sh
```

安装入口保持在仓库根目录，原有 GitHub 安装、更新链接继续可用。

## 许可证与来源

地图功能移植自 [zashboard](https://github.com/Zephyruso/zashboard)，遵循 MIT 许可证。移植清单见 [NOTICE.md](frontend/globe/NOTICE.md)，许可证见 [LICENSE.zashboard](frontend/globe/LICENSE.zashboard)。地球贴图使用 Solar System Scope 的 CC BY 4.0 资源，城市数据库使用 DB-IP City Lite。

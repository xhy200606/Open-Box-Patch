# globe/ — 「全球连接」地球仪源码

这是补丁里「全球连接」卡片的源码与构建脚本。**运行时不需要这里任何东西** ——
`globe.bundle.js` / `globe.worker.js` / `globe-assets/` 已作为产物提交到仓库根目录，
`install.sh` 直接下载它们。只有在你要修改地球仪本身时才需要构建。

## 构建

```sh
cd globe
npm install
npm run build
```

产物直接写到仓库根目录：

| 产物 | 说明 |
|---|---|
| `../globe.bundle.js` | ESM，含 three.js；由 `openbox-globe.js` 按需 `import()` |
| `../globe.worker.js` | ESM，`type: module` Worker，负责 MMDB 解析 |
| `../globe-assets/earth/*` | 地球贴图（本目录 `assets/earth/` 由 `apply.sh` 拷到面板侧） |

构建后记得重跑 `apply.sh`（或重启重放服务），让注入标签的哈希更新 ——
`openbox-globe.js` 的哈希同时覆盖 bundle 与 worker，否则浏览器会继续用旧 bundle。

## 目录

```
src/
├── earth/         # 移植自 zashboard 的 earth/*（渲染器、分层、投影、路由、geoip worker）
├── helper/        # 移植自 zashboard 的 mmdb.ts（异步 MMDB 读取）与 geoip-chunk-store.ts（分块存储）
├── adapters/      # 本补丁的适配层：连接数据、公网 IP 归属、主题、运行期配置
├── i18n.ts        # 文案（简中 / 繁中 / 英文），与上游 earth* 词条逐条对齐
├── index.ts       # 「全球连接」卡片（等价替换上游 EarthGlobeCard.vue）
└── worker.ts      # Worker 入口
assets/earth/      # 地球贴图（Solar System Scope · CC BY 4.0）
build.mjs          # esbuild 构建脚本（含 zashboard `@/` 别名的适配层映射）
```

## 与上游的差异

改动清单见 [`NOTICE.md`](./NOTICE.md)。要点：

1. `earth/globe-layer.ts`：4 张地球贴图由构建期 `import` 改为运行期按 `assetBase` 解析。
2. `earth/geoip.worker.ts`：`init` 消息可携带 `dbUrl`（默认指向本机代理镜像），
   IndexedDB 键固定为补丁自己的命名空间。
3. 卡片 UI 用原生 DOM 实现，且**布局样式自带**（`.ob-globe-*`）——
   面板的 Tailwind 是按用到的类裁剪的，依赖它的原子类会在上游升级后塌掉。
4. 公网 IP 归属改走本机代理（`/api/mb/globe/public-ip`），浏览器侧无跨域问题。
5. 连接数据取面板自身的 Clash 兼容接口，`/api/controller-ws/connections` 不可用时退化为轮询。

## 许可

- 上游 zashboard：MIT（见 [`LICENSE.zashboard`](./LICENSE.zashboard)）
- 地球贴图：Solar System Scope，CC BY 4.0
- 城市库：DB-IP City Lite，CC BY 4.0

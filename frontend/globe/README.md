# frontend/globe/ — 「全球连接」地球仪源码

这是补丁里「全球连接」卡片的源码与构建脚本。**运行时不需要这里任何东西** ——
`globe.bundle.js` / `globe.worker.js` / `globe-assets/` 已作为产物提交到 `frontend/`，
`install.sh` 直接下载它们。只有在你要修改地球仪本身时才需要构建。

## 构建

```sh
cd frontend/globe
npm install
npm run build
```

产物写到 `frontend/`：

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

## 线路是怎么分类的（直连 / 经代理 / 经中转）

`earth/relays.ts` + `earth/routes.ts` 负责把面板的连接表翻译成三条线路类别：

1. **直连 vs 非直连**：取 `chains[0]` 的出站名，在 `/api/controller/proxies` 的返回里查它的
   `type`；`Direct` / `Reject` / `Compatible` / `Pass` 判为直连（见 `adapters/connections.ts`
   的 `isDirect`）。
2. **经代理 vs 经中转**：把 `chains` 映射回 sing-box 出站配置（`backend/relay-nodes.mjs`
   只提取 `tag / server / detour / outbounds`，不含密码与订阅内容），得到**物理出站链路**：

   - `chains` 里**带 `server` 的 tag 才是物理节点**；策略组 / 选择器没有 server，不是跳点；
   - 链路的**最后一个**是出口（落地）节点 —— 它就是"代理"；排在它**前面**的才是中转节点；
   - 物理节点只有 1 个 → **经代理**（单跳）；两个及以上 → **经中转**（经中转再代理）。

   `detour` 的语义是"连这个节点的服务器要先走谁"，所以递归 detour 得到的顺序天然是入口 → 出口。
3. **落点颜色**：直连橙 / 经代理青 / 经中转紫；中转节点 `relay`（紫）、出口 / 落地节点
   `proxy`（青，与「经代理」同色）、目的地（橙，只出现在直连上）。

## 画到哪里：代理类线路**不画最终目的地**

地图回答的是「这条流量交到哪儿去了」，不是「访问了哪个网站」，所以两类线路的终点不同：

- **直连**：本机 → 目的地，一条线直接连过去；
- **经代理 / 经中转**：本机 → 各物理跳点（… → 落地节点），**终点是最后一个代理节点**，
  不再往后画到最终目的地。

于是「本机南京 → 中转上海 → 中转东京 → 落地洛杉矶」画成 `南京→上海→东京→洛杉矶` 的
代理链路，而不会多出一条到最终目标的线。副作用是**同一代理下的所有连接会合并成一条线**
（几十个走同一落地的目标只剩一条），目的地信息改在**落地节点的悬停卡片**里看
（下载量 Top5 Host 挂在**线路终点**上）。

两个容易踩的点，都已经写进代码与测试：

- **类别只由链路解析结果决定，与「显示中转」开关无关**。开关仅决定要不要把**中转节点**
  画到地图上（落地节点是链路终点，始终画）；关掉之后线路颜色仍能区分两类流量，
  不会退回"一律经代理"，终点也不会凭空消失。
- **中转节点查不到归属地时，类别仍是「经中转」**，不会退化成「经代理」（只在卡片上提示
  路径可能不完整）。早期版本用"路径里有没有紫点"反推类别，一遇到定位失败就退化成经代理，
  两类流量于是混在一起。
- **只有跳点一个都定位不出来时**（例如出站配置取不到），才退化回"本机 → 目的地"，
  免得整条线在地图上凭空消失。

`__openboxGlobe.state()` 会输出 `routeCategories`、`routeShapes`（如 `origin>relay>proxy`）
与 `routeTerminals`（每条线路终点所挂的域名），排障时可直接在控制台确认是否符合预期。

## 许可

- 上游 zashboard：MIT（见 [`LICENSE.zashboard`](./LICENSE.zashboard)）
- 地球贴图：Solar System Scope，CC BY 4.0
- 城市库：DB-IP City Lite，CC BY 4.0

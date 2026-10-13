# 第三方来源与许可

本目录（`globe/`）中的「全球连接」地球仪功能是从 **zashboard** 移植而来。

## 代码

- 来源：https://github.com/Zephyruso/zashboard （`src/components/overview/earth/*`、`src/helper/mmdb.ts`、`src/helper/geoip-chunk-store.ts`）
- 版本：zashboard 3.29.1
- 许可：MIT License，Copyright 2024 Zephyruso（见 `LICENSE.zashboard`）

移植时对下列文件做了**最小改动**（均在文件头以 `[Open-Box Patch]` 注明）：

| 文件 | 改动 |
|---|---|
| `src/earth/globe-layer.ts` | 4 张地球贴图由构建期 import 改为运行期 `earthAssetURL()` 解析 |
| `src/earth/geoip.worker.ts` | `init` 消息可携带 `dbUrl`，数据库地址默认改为本机代理镜像 |

其余文件（`earth-renderer.ts`、`earth-math.ts`、`projection.ts`、`render-snapshot.ts`、
`renderer-types.ts`、`palette.ts`、`types.ts`、`route-layer.ts`、`endpoint-layer.ts`、
`city-label-layer.ts`、`routes.ts`、`src/helper/mmdb.ts`、`src/helper/geoip-chunk-store.ts`）
按原样保留。

## 地球贴图

`assets/earth/` 下的 4 张贴图（`background.jpg`、`earth-day.webp`、`earth-night.webp`、
`earth-surface.webp`）来自 [Solar System Scope](https://www.solarsystemscope.com/textures/)，
采用 **CC BY 4.0** 许可。界面右下角保留了原始出处链接。

## 城市数据库

IP → 城市/经纬度由浏览器端 MMDB 解析完成，数据库为
[DB-IP City Lite](https://db-ip.com/db/lite.php)（CC BY 4.0）。
默认由本补丁的服务端代理镜像到本机，再由浏览器下载，避免每台设备都出网拉取约 62 MB。

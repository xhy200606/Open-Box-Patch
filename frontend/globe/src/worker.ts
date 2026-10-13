/// <reference lib="webworker" />

// [Open-Box Patch] geoip worker 入口：直接复用移植过来的上游实现。
// 上游用 `new Worker(new URL('./earth/geoip.worker.ts', import.meta.url), { type: 'module' })`
// 由打包器处理；补丁把自己的 worker 单独打成 `globe.worker.js`，地址由注入脚本在运行期给出。
import './earth/geoip.worker'

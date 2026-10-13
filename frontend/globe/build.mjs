/**
 * [Open-Box Patch] 构建「全球连接」地球仪补丁资产。
 *
 * 产物（输出到 frontend/，与 install.sh 的下载清单一一对应）：
 *   · globe.bundle.js   —— ESM，注入脚本按需动态 import
 *   · globe.worker.js   —— ESM，GeoIP MMDB 解析 Worker（type: module）
 *
 * 贴图（globe/assets/earth/*）不参与打包，随补丁目录原样分发，
 * 由注入脚本在运行期按脚本自身 URL 解析。
 *
 * 用法：npm install && npm run build
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { statSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')

/**
 * zashboard 源码用的是 `@/` 别名。补丁把上游文件原样 vendor 进来，
 * 只把它指向补丁自己的适配层，尽量不改上游代码。
 */
const ALIASES = {
  '@/helper/geoip-chunk-store': 'src/helper/geoip-chunk-store.ts',
  '@/helper/mmdb': 'src/helper/mmdb.ts',
  '@/assembly/connections': 'src/adapters/connections.ts',
  '@/types': 'src/adapters/types.ts',
}

const aliasPlugin = {
  name: 'openbox-alias',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@\// }, (args) => {
      const target = ALIASES[args.path]
      if (!target) {
        return {
          errors: [
            {
              text: `未映射的 zashboard 别名：${args.path}（请在 build.mjs 的 ALIASES 里补齐适配层）`,
            },
          ],
        }
      }
      return { path: join(here, target) }
    })
  },
}

// zashboard 的浏览器支持基线，见其 README
const TARGET = ['chrome111', 'edge111', 'firefox128', 'safari16.4']

const shared = {
  bundle: true,
  format: 'esm',
  target: TARGET,
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  plugins: [aliasPlugin],
  logLevel: 'info',
}

const outputs = [
  { in: 'src/index.ts', out: join(repoRoot, 'frontend/globe.bundle.js') },
  { in: 'src/worker.ts', out: join(repoRoot, 'frontend/globe.worker.js') },
]

for (const item of outputs) {
  await build({ ...shared, entryPoints: [join(here, item.in)], outfile: item.out })
  const size = statSync(item.out).size
  console.log(`\n  ${item.out.replace(repoRoot + '/', '')}  ${(size / 1024 / 1024).toFixed(2)} MB`)
}

console.log('\n构建完成。')

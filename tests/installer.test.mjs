import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const repo = fileURLToPath(new URL('../', import.meta.url))

for (const mode of ['local', 'download']) test(`categorized ${mode} installer retains installed paths and configuration`, async t => {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-installer-test-'))
  t.after(() => fs.rm(stage, { recursive: true, force: true }))
  const root = path.join(stage, 'open-box')
  const fakeBin = path.join(stage, 'fake-bin')
  const initd = path.join(stage, 'initd')
  const dest = path.join(root, 'data/multi-backend')
  for (const dir of [fakeBin, initd, dest, path.join(root, 'panel/dist')]) await fs.mkdir(dir, { recursive: true })
  // Only the temporary installation is touched. No host services are started.
  await fs.writeFile(path.join(fakeBin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 })
  await fs.writeFile(path.join(fakeBin, 'curl'), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    http*) url=$1; shift ;;
    *) shift ;;
  esac
done
relative=\${url#*/main/}
printf '%s\\n' "$relative" >> "$MOCK_DOWNLOAD_LOG"
cp "$MOCK_REPO/$relative" "$output"
`, { mode: 0o755 })
  await fs.writeFile(path.join(root, 'panel/dist/index.html'), '<html>\n<body>\n<div id="app"></div>\n</body>\n</html>\n')
  await fs.writeFile(path.join(dest, 'proxy.conf'), 'OPENBOX_MB_PORT=2440\nOPENBOX_MB_BIND=127.0.0.1\nOPENBOX_MB_TOKEN=test-token\nOPENBOX_MB_PANEL=http://127.0.0.1:2330\n')
  const installer = mode === 'local' ? path.join(repo, 'install.sh') : path.join(stage, 'install.sh')
  if (mode === 'download') await fs.copyFile(path.join(repo, 'install.sh'), installer)
  const env = { ...process.env, PATH: fakeBin + ':' + process.env.PATH, OPENBOX_ROOT: root, OPENBOX_INITD_DIR: initd,
    OPENBOX_SYSD_DIR: path.join(stage, 'systemd'), MOCK_REPO: repo, MOCK_DOWNLOAD_LOG: path.join(stage, 'downloads') }
  await run('/bin/sh', [installer, '--platform', 'openwrt'], { env })
  for (const [source, installed] of [
    ['frontend/multi-backend.js', 'multi-backend.js'], ['frontend/openbox-globe.js', 'openbox-globe.js'],
    ['frontend/globe.bundle.js', 'globe.bundle.js'], ['backend/proxy.mjs', 'proxy.mjs'],
    ['backend/patch-manager.mjs', 'patch-manager.mjs'], ['scripts/update-patch.sh', 'update-patch.sh'],
    ['scripts/apply.sh', 'apply.sh'], ['scripts/watch.sh', 'watch.sh'], ['version.json', 'version.json'],
  ]) assert.deepEqual(await fs.readFile(path.join(dest, installed)), await fs.readFile(path.join(repo, source)))
  assert.match(await fs.readFile(path.join(dest, 'proxy.conf'), 'utf8'), /OPENBOX_MB_PORT=2440/)
  assert.match(await fs.readFile(path.join(dest, 'proxy.conf'), 'utf8'), /OPENBOX_MB_PANEL=http:\/\/127.0.0.1:2330/)
  assert.match(await fs.readFile(path.join(initd, 'openbox-mb-proxy'), 'utf8'), /OPENBOX_MB_PANEL/)
  await run('/bin/sh', [path.join(dest, 'apply.sh')], { env })
  const html = await fs.readFile(path.join(root, 'panel/dist/index.html'), 'utf8')
  assert.equal((html.match(/<script src="\.\/multi-backend\.js/g) || []).length, 1)
  assert.equal((html.match(/<script src="\.\/openbox-globe\.js/g) || []).length, 1)
  if (mode === 'download') {
    const downloaded = await fs.readFile(path.join(stage, 'downloads'), 'utf8')
    for (const category of ['frontend/', 'backend/', 'scripts/', 'services/']) assert(downloaded.includes(category))
  }
})

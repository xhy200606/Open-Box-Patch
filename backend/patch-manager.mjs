import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = process.env.OPENBOX_ROOT || path.resolve(here, '../..')
const jobDir = path.join(here, 'managed-update')
const lockDir = path.join(here, 'managed-update.lock')
// Installed assets remain flat; repository sources use backend/ alongside the
// root manifest. Support both without changing existing installations.
let manifest
try { manifest = await fs.readFile(new URL('./version.json', import.meta.url), 'utf8') }
catch (error) { if (error.code !== 'ENOENT') throw error; manifest = await fs.readFile(new URL('../version.json', import.meta.url), 'utf8') }
export const PATCH_VERSION = JSON.parse(manifest).version

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export async function patchStatus() {
  let state = 'idle'
  let pid = 0
  try { state = (await fs.readFile(path.join(jobDir, 'state'), 'utf8')).trim() } catch {}
  try { pid = Number(await fs.readFile(path.join(lockDir, 'pid'), 'utf8')) } catch {}
  const running = alive(pid)
  if (!running && ['queued', 'downloading', 'installing'].includes(state)) state = 'interrupted'
  return { patchVersion: PATCH_VERSION, update: { state, running } }
}

export async function startPatchUpdate(channel) {
  if (!['direct', 'mirror'].includes(channel)) throw new Error('invalid-channel')
  try {
    await fs.mkdir(lockDir)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    let pid = 0
    try { pid = Number(await fs.readFile(path.join(lockDir, 'pid'), 'utf8')) } catch {}
    // A missing PID can mean another request is still launching the worker.
    const age = Date.now() - (await fs.stat(lockDir)).mtimeMs
    if (alive(pid) || age < 30000) throw new Error('update-already-running')
    await fs.rm(lockDir, { recursive: true })
    return startPatchUpdate(channel)
  }
  let log
  try {
    await fs.mkdir(jobDir, { recursive: true })
    await fs.copyFile(path.join(here, 'update-patch.sh'), path.join(jobDir, 'runner.sh'))
    await fs.writeFile(path.join(jobDir, 'state'), 'queued\n')
    log = await fs.open(path.join(jobDir, 'update.log'), 'w', 0o600)
    const child = spawn('/bin/sh', [path.join(jobDir, 'runner.sh'), root, jobDir, lockDir, channel], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, OPENBOX_ROOT: root },
    })
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    await fs.writeFile(path.join(lockDir, 'pid'), String(child.pid))
    child.unref()
    return { ok: true, update: { state: 'queued', running: true } }
  } catch (error) {
    await fs.rm(lockDir, { recursive: true, force: true })
    await fs.writeFile(path.join(jobDir, 'state'), 'failed\n').catch(() => {})
    throw error
  } finally {
    await log?.close()
  }
}

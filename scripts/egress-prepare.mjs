import { ROOT, prepare, hook, load, atomic, directory } from './egress.mjs'
try {
  if (process.argv[2] === '--restore') {
    // Keep the wrapper alive until the normal service command is restored.
    await atomic(`${directory(ROOT)}/egress.json`, JSON.stringify({ enabled: false }))
    await hook(ROOT, true)
  } else if (process.argv[2] === '--reapply') {
    if ((await load()).enabled) await hook()
  } else process.stdout.write(await prepare())
} catch (error) {
  console.error('出口分流：' + (error.stderr || error.message)); process.exitCode = 1
}

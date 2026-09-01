import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const electronDir = fileURLToPath(new URL('../', import.meta.url))
const packageManagerEntry = process.env.npm_execpath

if (!packageManagerEntry || !/\.(?:cjs|mjs|js)$/i.test(packageManagerEntry)) {
  throw new Error(
    'start:local must be launched through pnpm so the package-manager entrypoint is explicit'
  )
}

function runScript(script, env) {
  const result = spawnSync(process.execPath, [packageManagerEntry, 'run', script], {
    cwd: electronDir,
    env,
    stdio: 'inherit'
  })

  if (result.error) {
    throw result.error
  }

  if (result.signal) {
    throw new Error(`${script} terminated by ${result.signal}`)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

runScript('build', process.env)

runScript('preview:local', {
  ...process.env,
  LODY_ELECTRON_USE_BUNDLED_CLI: '1'
})

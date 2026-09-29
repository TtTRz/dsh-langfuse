/** Exercise the published tarball through a stock rc.2 CLI and a fresh profile. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

assert.ok(process.argv[2], 'Usage: npm run test:install -- <stock-dsh-install-prefix>')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(resolve(process.argv[2]), 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const home = await mkdtemp(join(tmpdir(), 'dsh-langfuse-install-'))
const env = { PATH: process.env.PATH, HOME: home, DSH_HOME: join(home, 'dsh'), CI: 'true' }
const logs = []
function run(command, args, cwd = home) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout)
  return result.stdout
}
const dsh = (args) => run(process.execPath, [cli, ...args])
let child
let stopped
const received = []
const collector = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    received.push({ url: req.url, body })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
try {
  assert.equal(dsh(['--version']).trim(), '0.1.7-rc.2')
  const packed = JSON.parse(
    run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', home], root),
  )
  const artifact = join(home, packed[0].filename)
  const install = ['plugin', '--profile', 'web', 'add', artifact]
  dsh(install)
  dsh(install)
  const profile = join(env.DSH_HOME, 'profiles/web')
  const manifest = JSON.parse(
    await readFile(join(profile, 'node_modules/dsh-langfuse/package.json'), 'utf8'),
  )
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-session-telemetry'], undefined)
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh-session-telemetry'], '0.1.7-rc.2')
  const workspace = await readFile(join(profile, 'pnpm-workspace.yaml'), 'utf8')
  assert.doesNotMatch(workspace, /^overrides:/m, 'Smoke must not depend on deployment overrides')
  console.log('PASS: packed plugin install and reinstall without deployment overrides')

  collector.listen(0, '127.0.0.1')
  await once(collector, 'listening')
  env.LANGFUSE_HOST = `http://127.0.0.1:${collector.address().port}`
  env.LANGFUSE_PUBLIC_KEY = 'fixture-public'
  env.LANGFUSE_SECRET_KEY = 'fixture-secret'
  env.LANGFUSE_TELEMETRY_MODE = 'FULL'
  child = spawn(process.execPath, [cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: home,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  stopped = once(child, 'close')
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (data) => logs.push(data.toString()))
  let base
  let cookie
  for (let attempt = 0; attempt < 120 && !cookie; attempt++) {
    assert.equal(child.exitCode, null, 'Harness exited before startup')
    const address = logs.join('').match(/dsh web: (http:\/\/\S+)/)?.[1]
    if (address) {
      const url = new URL(address)
      base = url.origin
      try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
        cookie = response.headers
          .getSetCookie()
          .map((v) => v.split(';')[0])
          .join('; ')
      } catch {
        /* Startup can announce the URL before accepting requests. */
      }
    }
    if (!cookie) await delay(250)
  }
  assert.ok(cookie, 'Harness did not become ready')
  async function rpc(method, args = {}) {
    const response = await fetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method,
        payload: { args },
      }),
      signal: AbortSignal.timeout(15000),
    })
    const result = (await response.json()).result
    assert.ok(result?.ok, `${method}: ${JSON.stringify(result?.error)}`)
    return result.value
  }
  let active = false
  for (let attempt = 0; attempt < 40 && !active; attempt++) {
    const inventory = await rpc('pluginInventory/list')
    active = inventory.entries.some(
      (entry) => entry.moduleName === 'dsh-langfuse' && entry.fiberPhase === 'active',
    )
    if (!active) await delay(250)
  }
  assert.ok(active, 'Langfuse plugin must activate in FULL mode')
  const created = await rpc('session/create', { request: { cwd: home } })
  assert.ok(created.sessionId)
  const restored = await rpc('session/create', {
    request: { sessionId: created.sessionId, cwd: home },
  })
  assert.equal(restored.sessionId, created.sessionId)
  assert.doesNotMatch(logs.join(''), /session\.events is not iterable|ERR_MODULE_NOT_FOUND/)
  console.log(
    'PASS: FULL-mode plugin activation, new session, and reopening on stock dsh 0.1.7-rc.2',
  )
} catch (error) {
  console.error(logs.join('').replace(/token=[^\s&]+/g, 'token=[redacted]'))
  throw error
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await stopped
    clearTimeout(timer)
  }
  if (collector.listening) await new Promise((done) => collector.close(done))
  await rm(home, { recursive: true, force: true })
}

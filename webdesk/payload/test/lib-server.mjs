/**
 * WSK-02 — shared test helper: boot the internal Next.js/Payload listener AND the public
 * gateway as real child processes against a live Postgres, tear both down afterward.
 *
 * Windows traps carried forward from the WSK-00 spike's probes/lib-server.mjs (same root
 * causes, same fixes — see that file's comments for the full derivation):
 *   - `spawn()` on this patched Node refuses a `.cmd` shim without `shell:true` (EINVAL).
 *   - a `shell:true`-spawned `next dev` forks its own real server process; `child.kill()` only
 *     signals the cmd.exe wrapper, so `taskkill /PID <pid> /T /F` is required to actually free
 *     the port between runs.
 *   - readiness must check that the body actually parses how THIS app responds, not just that
 *     `res.status` was truthy — a stray unrelated server on the same port range would otherwise
 *     produce a silent false-positive "ready."
 */
import { spawn, execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))
export const payloadRoot = path.resolve(dirname, '..')

export const INTERNAL_PORT = Number(process.env.PAYLOAD_INTERNAL_PORT || 34211)
export const PUBLIC_PORT = Number(process.env.PAYLOAD_PUBLIC_PORT || 34212)
export const INTERNAL_URL = `http://localhost:${INTERNAL_PORT}`
export const PUBLIC_URL = `http://localhost:${PUBLIC_PORT}`

function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve())
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
      resolve()
    }
  })
}

function spawnTracked(cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  return { child, getLog: () => log }
}

export async function startInternal({ databaseUri }) {
  const nextBin = path.join(
    payloadRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'next.cmd' : 'next',
  )
  const { child, getLog } = spawnTracked(nextBin, ['dev', '-p', String(INTERNAL_PORT)], {
    cwd: payloadRoot,
    env: {
      ...process.env,
      DATABASE_URI: databaseUri,
      PAYLOAD_ALLOW_PUSH: 'false',
      PAYLOAD_ALLOW_PUSH_I_UNDERSTAND_THIS_DISABLES_RLS: 'false',
      PAYLOAD_SECRET: 'wsk-02-test-not-a-real-secret',
      PAYLOAD_PUBLIC_SERVER_URL: INTERNAL_URL,
      PAYLOAD_INTERNAL_PORT: String(INTERNAL_PORT),
      NODE_ENV: 'development',
    },
    shell: process.platform === 'win32',
  })

  const deadline = Date.now() + 120_000
  let ready = false
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${INTERNAL_URL}/api/pages`, {
        headers: { 'x-webdesk-tenant': '' },
      })
      const body = await res.text()
      JSON.parse(body) // this app's REST handler always returns JSON; HTML means wrong server
      ready = true
      break
    } catch {
      // not up yet, or answered with something that is not this app — keep polling
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  if (!ready) {
    await killTree(child.pid)
    throw new Error(`internal listener did not become ready within 120s.\n--- log ---\n${getLog().slice(-4000)}`)
  }

  return { child, getLog, stop: () => killTree(child.pid) }
}

export async function startPublicGateway() {
  const { child, getLog } = spawnTracked(process.execPath, [path.join(payloadRoot, 'src', 'public-gateway.mjs')], {
    cwd: payloadRoot,
    env: {
      ...process.env,
      PAYLOAD_PUBLIC_PORT: String(PUBLIC_PORT),
      PAYLOAD_INTERNAL_PORT: String(INTERNAL_PORT),
      PAYLOAD_INTERNAL_HOST: '127.0.0.1',
    },
  })

  const deadline = Date.now() + 30_000
  let ready = false
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${PUBLIC_URL}/healthz`)
      if (res.status === 200) {
        ready = true
        break
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }

  if (!ready) {
    await killTree(child.pid)
    throw new Error(`public gateway did not become ready within 30s.\n--- log ---\n${getLog().slice(-4000)}`)
  }

  return { child, getLog, stop: () => killTree(child.pid) }
}

export const results = []
let pass = 0
let fail = 0

export function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name} -- ${detail ?? ''}`)
  }
}

export function summary(label) {
  console.log(`\n  ${label}: ${pass} passed, ${fail} failed`)
  return fail === 0
}

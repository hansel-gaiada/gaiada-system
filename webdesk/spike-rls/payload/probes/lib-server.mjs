/**
 * Shared helper: boot the actual Next.js server (the same app/(payload)
 * route tree admin + REST probes both hit) as a child process against the
 * webdesk_app role, and tear it down afterward.
 */
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const payloadRoot = path.resolve(dirname, '..');

// PORT TRAP (found resuming this spike): 3111 collided with an unrelated
// platform-ui `next dev` server left running by another concurrent session
// on this shared box (confirmed via `Get-CimInstance Win32_Process`, PID
// bound to platform-ui/node_modules/next/.../start-server.js). The readiness
// probe below only checked `res.status` truthy, so it happily "passed"
// against the WRONG app's login-page HTML instead of ours - a silent
// mis-target, not a real pass. Moved off the common 3xxx range and the
// readiness check now requires the body to actually parse as JSON (this
// app's /api/pages never returns HTML) so a future collision fails loud
// instead of quietly probing someone else's server.
export const PORT = 34117;
export const BASE_URL = `http://localhost:${PORT}`;

export async function startServer({ databaseUri, extraEnv = {} } = {}) {
  // WINDOWS TRAP (found resuming this spike): Node's spawn(), on patched
  // Node versions (the CVE-2024-27980 fix), refuses to exec a .cmd/.bat
  // directly without shell:true and throws EINVAL - not a Payload issue, a
  // Windows batch-shim issue. shell:true routes it through cmd.exe, which is
  // fine here since none of the args are attacker-controlled.
  const nextBin = path.join(payloadRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'next.cmd' : 'next');
  const child = spawn(nextBin, ['dev', '-p', String(PORT)], {
    cwd: payloadRoot,
    env: {
      ...process.env,
      DATABASE_URI: databaseUri,
      PAYLOAD_ALLOW_PUSH: 'false',
      PAYLOAD_SECRET: 'wsk-00-spike-not-a-real-secret',
      PAYLOAD_PUBLIC_SERVER_URL: BASE_URL,
      NODE_ENV: 'development',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/pages`, { headers: { 'x-webdesk-tenant': '' } });
      const body = await res.text();
      JSON.parse(body); // this app's REST handler always returns JSON; HTML means it's the wrong server
      ready = true;
      break;
    } catch {
      // not up yet, or answered with something that isn't our app - keep polling
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  // WINDOWS TRAP (found resuming this spike, round 2): `next dev` spawned via
  // shell:true forks its OWN child node process for the actual dev server;
  // `child.kill()` only signals the cmd.exe wrapper, so the real server
  // process (and the port) survived every probe run that errored before
  // reaching a clean shutdown - the NEXT run then failed EADDRINUSE against
  // a port "someone" (ourselves, a run ago) was still holding. `taskkill /T`
  // kills the whole process tree, not just the immediate child.
  const killTree = (pid) =>
    new Promise((resolve) => {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
      } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
        resolve();
      }
    });

  if (!ready) {
    await killTree(child.pid);
    throw new Error(`next dev did not become ready within 90s.\n--- server log ---\n${log.slice(-4000)}`);
  }

  return {
    child,
    getLog: () => log,
    async stop() {
      await killTree(child.pid);
    },
  };
}

/**
 * AUTH TRAP (found resuming this spike): there is no public REST endpoint
 * that reliably creates an ordinary user for free. Payload 3's default
 * access control for EVERY collection with no explicit `access` block is
 * `({ req: { user } }) => Boolean(user)` (node_modules/payload/dist/auth/
 * defaultAccess.js), and that applies uniformly - including `users` itself -
 * so a plain `POST /api/users` 403s even when the collection is empty.
 *
 * `POST /api/<slug>/first-register` (registerFirstUserOperation, see
 * node_modules/payload/dist/auth/operations/registerFirstUser.js) looked
 * like the answer, but its gate is "does ANY doc exist in the collection",
 * not "does THIS email exist" - so it 403s for every email once a single
 * prior run (P9, P10, or a probe left running by an earlier session) has
 * created any user at all, which this spike's own multi-run history hit
 * immediately. That is order-dependent flakiness between probe runs, not
 * evidence about RLS, so bootstrap goes through Local API instead (which
 * defaults to overrideAccess:true and is genuinely idempotent - find-or-
 * create by email) and only the login itself goes over real REST, since
 * login's own operation is deliberately NOT gated by defaultAccess (it has
 * to be reachable by a logged-out request or nobody could ever log in).
 *
 * CSRF TRAP (found resuming this spike, and the reason the login cookie
 * looked "obtained" yet every subsequent authenticated call still 403'd as
 * if logged out): `config/sanitize.js` unconditionally pushes `serverURL`
 * onto `payload.config.csrf`, so the csrf allowlist is NEVER empty for this
 * app - which means extractJWT's cookie strategy (auth/extractJWT.js) always
 * takes its Origin/Sec-Fetch-Site branch, and a plain Node `fetch()` sends
 * neither header, so the cookie's JWT is silently discarded before
 * signature verification even runs (extractJWT returns null, not an error -
 * every downstream check just sees "no token", identical to a logged-out
 * request). This is Payload's CSRF protection working exactly as designed
 * for a real browser; a bare script has to mimic a same-origin request by
 * sending `Origin: <baseUrl>` on every cookie-authenticated call. Callers
 * MUST add this same header wherever they attach the returned cookie.
 */
export const originHeader = (baseUrl) => ({ Origin: baseUrl });

export async function bootstrapOrLogin(databaseUri, baseUrl, email, password) {
  const { bootPayload } = await import('../src/lib.mjs');
  const admin = await bootPayload({ databaseUri });
  try {
    const existing = await admin.find({ collection: 'users', where: { email: { equals: email } }, limit: 1 });
    if (existing.docs.length === 0) {
      await admin.create({ collection: 'users', data: { email, password } });
    }
  } finally {
    await admin.destroy();
  }

  const loginRes = await fetch(`${baseUrl}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...originHeader(baseUrl) },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = loginRes.headers.get('set-cookie') || '';
  return { cookie: setCookie.split(';')[0], via: 'local-api-ensure+rest-login', status: loginRes.status };
}

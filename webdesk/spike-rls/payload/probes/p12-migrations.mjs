/**
 * P12 - Payload's own migrate path (payload migrate:create / migrate /
 * migrate:status), run as webdesk_migrator - the estate's NOBYPASSRLS
 * migrator role, deliberately NOT the superuser owner. Migrations are
 * schema-level DDL with no tenant of their own; the question worth
 * answering is narrower than "does RLS hold" (it structurally cannot apply
 * to DDL) - it is whether the SAME tenantAwarePg wrapper that sits under
 * every other path interferes with migrations when no ALS tenant context is
 * active (it must not), and whether the migrator role - which never went
 * through setup-schema.ts's push - can actually run the generated SQL.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const payloadRoot = path.resolve(dirname, '..');
const MIGRATOR_URI = 'postgres://webdesk_migrator:spike_migrator_pw@localhost:55432/webdesk_spike';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} -- ${detail ?? ''}`); }
}

function runCli(args) {
  const payloadBin = path.join(payloadRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'payload.cmd' : 'payload');
  const res = spawnSync(payloadBin, args, {
    cwd: payloadRoot,
    env: {
      ...process.env,
      DATABASE_URI: MIGRATOR_URI,
      PAYLOAD_ALLOW_PUSH: 'false',
      PAYLOAD_SECRET: 'wsk-00-spike-not-a-real-secret',
      NODE_ENV: 'production', // production => connect.js takes the migrate path, not dev-push
    },
    encoding: 'utf8',
    input: '\n', // in case anything still prompts, don't hang the probe run
    timeout: 60_000,
    // WINDOWS TRAP - see lib-server.mjs: patched Node throws EINVAL spawning
    // a .cmd shim directly without shell:true.
    shell: process.platform === 'win32',
  });
  return res;
}

const created = runCli(['migrate:create', 'wsk00_probe']);
check(
  'P12 migrate:create runs as webdesk_migrator (no CREATE-privilege error, no hang)',
  created.status === 0,
  `status ${created.status}\n${(created.stdout || '') + (created.stderr || '')}`.slice(0, 2000),
);

const applied = runCli(['migrate']);
check(
  'P12 migrate applies the generated migration as webdesk_migrator',
  applied.status === 0,
  `status ${applied.status}\n${(applied.stdout || '') + (applied.stderr || '')}`.slice(0, 2000),
);

const status = runCli(['migrate:status']);
check(
  'P12 migrate:status confirms it is recorded applied',
  status.status === 0 && /wsk00_probe/.test(status.stdout || ''),
  `status ${status.status}\n${(status.stdout || '') + (status.stderr || '')}`.slice(0, 2000),
);

console.log(`\n  P12 Migrations: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

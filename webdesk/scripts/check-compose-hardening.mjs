#!/usr/bin/env node
/**
 * WebDesk M4 (F2/F3/F4) - the RESOLVED aicenter compose config must stay hardened.
 *
 * WHY THIS READS THE RESOLVED CONFIG, NOT THE YAML: the production stack is base + overlay merged
 * (`docker compose -f docker-compose.yml -f docker-compose.aicenter.yml config`). Merge rules
 * (`!reset`, `!override`, additive lists) are exactly where a hardening line silently disappears and
 * `docker compose config` still exits 0, so scripts/check-compose-ports.mjs's raw-text approach is the
 * wrong tool here. The ops README's rule: ALWAYS audit the RESOLVED config.
 *
 * Fails (exit 1) when, for any service in the resolved config:
 *   - `cap_drop` does not contain ALL                                              (F3)
 *   - `security_opt` lacks no-new-privileges:true                                  (F3 / overlay header)
 *   - the image is not digest-pinned (`@sha256:`) and the service has no `build:`  (F4)
 * or when the default network has no pinned `ipam.config[].subnet`                 (F2).
 *
 * Run:  node scripts/check-compose-hardening.mjs                 (needs the docker CLI; resolves with
 *                                                                 dummy values for the `:?` required vars)
 *       node scripts/check-compose-hardening.mjs --json cfg.json (audit a saved `config --format json`)
 *       node scripts/check-compose-hardening.mjs --selftest      (negative controls, no docker needed)
 *
 * Exit 0 = hardened. 1 = a violation. 2 = could not resolve the config (never a pass).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CIDR = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

/** Pure: audit one resolved compose config object. Returns a list of human-readable violations. */
export function audit(cfg) {
  const out = [];
  const services = cfg && cfg.services ? Object.entries(cfg.services) : [];
  if (services.length === 0) {
    return ['the resolved config has ZERO services - the audit would pass vacuously, so it fails'];
  }
  for (const [name, svc] of services) {
    const drop = (svc.cap_drop || []).map((c) => String(c).toUpperCase().replace(/^CAP_/, ''));
    if (!drop.includes('ALL')) out.push(`${name}: cap_drop does not contain ALL (got ${JSON.stringify(svc.cap_drop || [])})`);
    const sec = (svc.security_opt || []).map(String);
    if (!sec.some((o) => /^no-new-privileges(:|=)true$/.test(o))) out.push(`${name}: security_opt lacks no-new-privileges:true`);
    if (!svc.build && !/@sha256:[0-9a-f]{64}$/.test(String(svc.image || ''))) {
      out.push(`${name}: image "${svc.image || ''}" is not pinned by digest (@sha256:...) and the service has no build`);
    }
  }
  const net = cfg.networks && cfg.networks.default;
  const subnets = net && net.ipam && Array.isArray(net.ipam.config) ? net.ipam.config.map((c) => c && c.subnet).filter(Boolean) : [];
  if (!subnets.length || !subnets.every((s) => CIDR.test(String(s)))) {
    out.push('networks.default has no pinned ipam subnet (the host egress guard reads it at boot; see ops/host/webdesk-egress-guard.sh)');
  }
  return out;
}

function requiredVars(files) {
  const vars = new Set();
  for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/\$\{([A-Z0-9_]+):\?/g)) vars.add(m[1]);
  return [...vars];
}

function resolve(dir) {
  const files = ['docker-compose.yml', 'docker-compose.aicenter.yml'].map((f) => path.join(dir, f));
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`missing ${f}`);
  // Resolve from a TEMP COPY of the two files plus an empty `.env.control`: the overlay's
  // `env_file: .env.control` must exist on disk for `config` to run, and on a CI runner it does not
  // (it is a 0600 box-only file). Nothing is started and no secret is involved; the dummy values only
  // let the `:?` required-variable interpolation succeed.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-hardening-'));
  try {
    for (const f of files) fs.copyFileSync(f, path.join(tmp, path.basename(f)));
    fs.writeFileSync(path.join(tmp, '.env.control'), '');
    const env = { ...process.env };
    for (const v of requiredVars(files)) env[v] = env[v] || 'audit-dummy-value';
    const raw = execFileSync('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.aicenter.yml', 'config', '--format', 'json'], {
      cwd: tmp, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(raw);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function selftest() {
  const good = () => ({
    services: {
      proxy: { image: 'caddy:2-alpine@sha256:' + 'a'.repeat(64), cap_drop: ['ALL'], cap_add: ['NET_BIND_SERVICE'], security_opt: ['no-new-privileges:true'] },
      api: { build: { context: '.' }, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'] },
    },
    networks: { default: { ipam: { config: [{ subnet: '172.19.0.0/16' }] } } },
  });
  const cases = [
    ['a fully hardened config passes', (c) => c, 0],
    ['THE REGRESSION: a service with no cap_drop is caught', (c) => { delete c.services.api.cap_drop; return c; }, 1],
    ['an empty cap_drop list is caught', (c) => { c.services.proxy.cap_drop = []; return c; }, 1],
    ['a partial cap_drop (not ALL) is caught', (c) => { c.services.proxy.cap_drop = ['NET_RAW']; return c; }, 1],
    ['CAP_ALL spelling is accepted', (c) => { c.services.proxy.cap_drop = ['CAP_ALL']; return c; }, 0],
    ['an unpinned default network (no ipam) is caught', (c) => { c.networks = { default: {} }; return c; }, 1],
    ['a missing networks block is caught', (c) => { delete c.networks; return c; }, 1],
    ['an ipam block with no subnet is caught', (c) => { c.networks.default.ipam.config = [{ gateway: '172.19.0.1' }]; return c; }, 1],
    ['a tag-only image on a non-build service is caught', (c) => { c.services.proxy.image = 'caddy:2-alpine'; return c; }, 1],
    ['a missing no-new-privileges is caught', (c) => { c.services.api.security_opt = []; return c; }, 1],
    ['zero services is a failure, not a vacuous pass', () => ({ services: {}, networks: {} }), 1],
  ];
  let fails = 0;
  for (const [name, mutate, expect] of cases) {
    const got = audit(mutate(good())).length ? 1 : 0;
    const ok = got === expect;
    if (!ok) fails++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  }
  console.log(`\n  selftest: ${cases.length - fails} passed, ${fails} failed`);
  return fails === 0 ? 0 : 1;
}

function main() {
  if (process.argv.includes('--selftest')) process.exit(selftest());
  let cfg;
  try {
    const j = process.argv.indexOf('--json');
    cfg = j > -1 ? JSON.parse(fs.readFileSync(process.argv[j + 1], 'utf8')) : resolve(process.cwd());
  } catch (e) {
    console.error(`[compose-hardening] could not resolve the config: ${String(e.stderr || e.message || e).split('\n').filter((l) => l && !/level=warning/.test(l)).slice(-2).join(' | ')}`);
    process.exit(2);
  }
  const violations = audit(cfg);
  const n = Object.keys(cfg.services || {}).length;
  if (violations.length) {
    console.error(`[compose-hardening] FAILED - ${violations.length} violation(s) in the resolved base+aicenter config:`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`[compose-hardening] OK - ${n} service(s): cap_drop ALL, no-new-privileges, digest-pinned or built; default network subnet pinned.`);
  process.exit(0);
}

const invokedDirectly = typeof process.argv[1] === 'string' && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) main();

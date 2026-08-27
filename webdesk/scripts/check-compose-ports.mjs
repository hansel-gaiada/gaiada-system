#!/usr/bin/env node
/**
 * WSK-28 — the published-host-port collision gate.
 *
 * WHY THIS EXISTS (a real defect, found 2026-08-27 while provisioning Zone B):
 *
 *   payload-gateway published "${WEBDESK_PAYLOAD_PUBLIC_PORT:-8384}:3000"
 *   redis           published "${WEBDESK_REDIS_PORT:-8384}:6379"
 *
 * Both services are in the SAME `dev` profile, so `docker compose --profile dev up` dies on a
 * bind conflict for anyone who has not overridden one of those vars in `.env`.
 *
 * The important part: **`docker compose config` cannot catch this.** It validates schema and
 * interpolation, and it exits 0 on a file whose defaults collide — which is exactly what happened.
 * WSK-28 verified compose on exit code (correctly, and better than the `echo` that lied before it)
 * and this still slipped through, because it is a different class of fault: not "is the YAML
 * valid" but "can these services coexist".
 *
 * So this gate answers the question compose does not: within each profile, does any host port get
 * claimed twice? It reads the raw YAML rather than `compose config` output on purpose, because the
 * DEFAULTS are the thing that ships to a fresh box — a local `.env` that happens to avoid the
 * clash hides the bug from the person who has one and breaks the person who does not.
 *
 * Run:  node scripts/check-compose-ports.mjs [path-to-compose.yml]
 *       node scripts/check-compose-ports.mjs --selftest
 *
 * Exit 0 = no collision. Exit 1 = at least one host port claimed twice in a shared profile.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Deliberately a small hand parser over the port/profile lines rather than a YAML dependency:
 * webdesk/scripts has no yaml package, and adding one to a gate that must run in CI before
 * `npm ci` finishes is a worse trade than parsing the two shapes we actually emit.
 *
 * Recognised published-port forms (both used in this file):
 *   - "${VAR:-8380}:80"
 *   - "127.0.0.1:${VAR:-8381}:3000"
 */
export function parseServices(text) {
  const services = [];
  let current = null;
  let inPorts = false;
  let inProfiles = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (/^\s*#/.test(line) || line.trim() === '') continue;

    // A service key is indented exactly two spaces under `services:`.
    const svc = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (svc) {
      current = { name: svc[1], profiles: [], ports: [] };
      services.push(current);
      inPorts = false;
      inProfiles = false;
      continue;
    }
    if (!current) continue;

    if (/^\s{4}ports:\s*$/.test(line)) { inPorts = true; inProfiles = false; continue; }
    if (/^\s{4}profiles:/.test(line)) {
      inProfiles = true;
      inPorts = false;
      // inline form: profiles: ["dev", "ops"]
      for (const m of line.matchAll(/"([^"]+)"/g)) current.profiles.push(m[1]);
      continue;
    }
    // any other 4-space key ends both lists
    if (/^\s{4}[A-Za-z0-9_-]+:/.test(line)) { inPorts = false; inProfiles = false; continue; }

    if (inProfiles) {
      const p = line.match(/^\s{6}-\s*"?([^"\s]+)"?\s*$/);
      if (p) current.profiles.push(p[1]);
      continue;
    }
    if (inPorts) {
      const p = line.match(/^\s{6}-\s*"(.+)"\s*$/);
      if (!p) continue;
      const spec = p[1];
      // Only PUBLISHED ports can collide. A bare container port ("8080") cannot.
      //
      // CAREFUL: a naive spec.split(':') ALSO splits inside `${VAR:-8380}`, which silently yields
      // no usable host port for every interpolated entry — so the gate collected zero ports and
      // reported a clean pass on a file that genuinely collided. My own selftest caught that, which
      // is the whole reason the parser is asserted separately below. Mask the ${...} tokens first.
      const masked = [];
      const safeSpec = spec.replace(/\$\{[^}]*\}/g, (m) => {
        masked.push(m);
        return `@@${masked.length - 1}@@`;
      });
      const unmask = (v) => v.replace(/@@(\d+)@@/g, (_, i) => masked[Number(i)]);
      const parts = safeSpec.split(':').map(unmask);
      if (parts.length < 2) continue;
      const hostPart = parts[parts.length - 2];
      const bindAddr = parts.length >= 3 ? parts.slice(0, parts.length - 2).join(':') : '0.0.0.0';
      const def = hostPart.match(/^\$\{[A-Z_]+:-(\d+)\}$/);
      const literal = hostPart.match(/^(\d+)$/);
      const port = def ? def[1] : literal ? literal[1] : null;
      if (port) current.ports.push({ port, bindAddr, spec, varName: (hostPart.match(/^\$\{([A-Z_]+)/) || [])[1] ?? null });
    }
  }
  return services;
}

/** Pure, so the collision logic is testable without a compose file. */
export function findCollisions(services) {
  const byProfile = new Map(); // profile -> Map<`${bindAddr}:${port}`, service[]>
  for (const svc of services) {
    const profiles = svc.profiles.length ? svc.profiles : ['<no-profile>'];
    for (const profile of profiles) {
      if (!byProfile.has(profile)) byProfile.set(profile, new Map());
      const claims = byProfile.get(profile);
      for (const p of svc.ports) {
        // A loopback bind and a 0.0.0.0 bind on the same port DO still collide on Linux for the
        // loopback address, so treat the port itself as the key rather than addr:port.
        const key = p.port;
        if (!claims.has(key)) claims.set(key, []);
        claims.get(key).push({ service: svc.name, ...p });
      }
    }
  }

  const collisions = [];
  for (const [profile, claims] of byProfile) {
    for (const [port, holders] of claims) {
      // Same service listing a port twice is its own (different) mistake; dedupe by service name
      // so we only report genuine two-service clashes.
      const distinct = [...new Map(holders.map((h) => [h.service, h])).values()];
      if (distinct.length > 1) collisions.push({ profile, port, holders: distinct });
    }
  }
  return collisions;
}

function report(collisions) {
  if (!collisions.length) {
    console.log('[compose-ports] OK — no host port is claimed by two services in the same profile.');
    return 0;
  }
  console.error(`[compose-ports] FAILED — ${collisions.length} host-port collision(s):\n`);
  for (const c of collisions) {
    console.error(`  profile "${c.profile}" — host port ${c.port} claimed by ${c.holders.length} services:`);
    for (const h of c.holders) {
      console.error(`      ${h.service.padEnd(18)} ${h.spec}${h.varName ? `   (${h.varName})` : ''}`);
    }
  }
  console.error(
    '\n  `docker compose up` will die on a bind conflict for anyone who has not overridden one of\n' +
      '  these in .env. `docker compose config` exits 0 on this — it validates schema, not whether\n' +
      '  the services can coexist. Give one of them a different DEFAULT, not just a local override:\n' +
      '  the default is what ships to a fresh box.\n',
  );
  return 1;
}

/** Proves the gate can actually fail — a check that cannot fail is decoration. */
function selftest() {
  const cases = [
    {
      name: 'THE REGRESSION: two dev services defaulting to the same host port is caught',
      services: [
        { name: 'payload-gateway', profiles: ['dev'], ports: [{ port: '8384', bindAddr: '0.0.0.0', spec: '${A:-8384}:3000', varName: 'A' }] },
        { name: 'redis', profiles: ['dev'], ports: [{ port: '8384', bindAddr: '0.0.0.0', spec: '${B:-8384}:6379', varName: 'B' }] },
      ],
      expect: 1,
    },
    {
      name: 'distinct ports pass',
      services: [
        { name: 'a', profiles: ['dev'], ports: [{ port: '8384', bindAddr: '0.0.0.0', spec: 'x', varName: null }] },
        { name: 'b', profiles: ['dev'], ports: [{ port: '8390', bindAddr: '0.0.0.0', spec: 'x', varName: null }] },
      ],
      expect: 0,
    },
    {
      name: 'same port in DIFFERENT profiles is fine (they never run together)',
      services: [
        { name: 'a', profiles: ['dev'], ports: [{ port: '8384', bindAddr: '0.0.0.0', spec: 'x', varName: null }] },
        { name: 'b', profiles: ['ops'], ports: [{ port: '8384', bindAddr: '0.0.0.0', spec: 'x', varName: null }] },
      ],
      expect: 0,
    },
    {
      name: 'a loopback bind still collides with a 0.0.0.0 bind on the same port',
      services: [
        { name: 'a', profiles: ['dev'], ports: [{ port: '8381', bindAddr: '127.0.0.1', spec: 'x', varName: null }] },
        { name: 'b', profiles: ['dev'], ports: [{ port: '8381', bindAddr: '0.0.0.0', spec: 'x', varName: null }] },
      ],
      expect: 1,
    },
    {
      name: 'a service sharing a profile list with itself is not a false positive',
      services: [
        { name: 'a', profiles: ['dev', 'ops'], ports: [{ port: '8384', bindAddr: '0.0.0.0', spec: 'x', varName: null }] },
      ],
      expect: 0,
    },
  ];
  let fails = 0;
  for (const c of cases) {
    const got = findCollisions(c.services).length ? 1 : 0;
    const ok = got === c.expect;
    if (!ok) fails++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  }

  // Also prove the PARSER sees the real shapes this repo emits, not just hand-built objects.
  const parsed = parseServices(
    [
      'services:',
      '  proxy:',
      '    profiles: ["dev"]',
      '    ports:',
      '      - "${WEBDESK_PROXY_HTTP_PORT:-8380}:80"',
      '  payload:',
      '    profiles: ["dev"]',
      '    ports:',
      '      - "127.0.0.1:${WEBDESK_PAYLOAD_INTERNAL_PORT:-8381}:3000"',
      '  imgproxy:',
      '    profiles: ["dev"]',
      '    ports:',
      '      - "8080"',
      '',
    ].join('\n'),
  );
  const proxy = parsed.find((s) => s.name === 'proxy');
  const payload = parsed.find((s) => s.name === 'payload');
  const imgproxy = parsed.find((s) => s.name === 'imgproxy');
  const parserOk =
    proxy?.ports[0]?.port === '8380' &&
    payload?.ports[0]?.port === '8381' &&
    payload?.ports[0]?.bindAddr === '127.0.0.1' &&
    imgproxy?.ports.length === 0; // a bare container port is not published and cannot collide
  if (!parserOk) fails++;
  console.log(`  ${parserOk ? 'PASS' : 'FAIL'}  parser reads both published forms and ignores a bare container port`);

  console.log(`\n  selftest: ${cases.length + 1 - fails} passed, ${fails} failed`);
  return fails === 0 ? 0 : 1;
}

function main() {
  if (process.argv.includes('--selftest')) process.exit(selftest());
  const file = process.argv[2] || path.join(process.cwd(), 'docker-compose.yml');
  if (!fs.existsSync(file)) {
    console.error(`[compose-ports] no such file: ${file}`);
    process.exit(2);
  }
  const services = parseServices(fs.readFileSync(file, 'utf8'));
  if (services.length === 0) {
    // Not a pass. An empty parse means the parser lost sync with the file's shape, which on a
    // gate like this looks identical to "everything is fine".
    console.error('[compose-ports] FAILED — parsed ZERO services. The parser is out of sync with the file, not the file with reality.');
    process.exit(1);
  }
  const published = services.reduce((n, s) => n + s.ports.length, 0);
  if (published === 0) {
    // Also not a pass, and this one nearly shipped: a parser that stops recognising the published
    // form collects nothing and every collision disappears. `webdesk/docker-compose.yml` publishes
    // a dozen ports, so zero means the parser desynced from the file.
    console.error('[compose-ports] FAILED — parsed ZERO published ports across ' + services.length + ' service(s). The parser is out of sync with the file; a collision would be invisible.');
    process.exit(1);
  }
  console.log(`[compose-ports] scanned ${services.length} service(s), ${published} published port(s) in ${path.basename(file)}`);
  process.exit(report(findCollisions(services)));
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) main();

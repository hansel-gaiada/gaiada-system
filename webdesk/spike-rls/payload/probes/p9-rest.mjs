/**
 * P9 - REST API, over real HTTP against the real Next.js route handler in
 * app/(payload)/api/[...slug]/route.ts. This is the file WE authored (see
 * that file's header comment) - the probe's job is to confirm the wrapping
 * actually works end-to-end through Payload's REST implementation, not just
 * in theory.
 */
import { ACME, GLOBEX } from '../src/lib.mjs';
import { startServer, BASE_URL, bootstrapOrLogin, originHeader } from './lib-server.mjs';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} -- ${detail ?? ''}`); }
}

const APP_URI = 'postgres://webdesk_app:spike_app_pw@localhost:55432/webdesk_spike';
const server = await startServer({ databaseUri: APP_URI });

try {
  // AUTH TRAP (found resuming this spike): this probe must authenticate
  // before it can reach the tenant-GUC code path at all - see
  // bootstrapOrLogin's header comment in lib-server.mjs for why plain
  // `POST /api/users` isn't the way to do that.
  const { cookie: authCookie, via, status } = await bootstrapOrLogin(APP_URI, BASE_URL, 'wsk00-shared-admin@example.com', 'wsk-00-spike-password-1');
  check('P9 auth: obtained a session cookie', Boolean(authCookie), `via ${via}, status ${status}`);

  // CSRF TRAP - see bootstrapOrLogin's header comment in lib-server.mjs:
  // every cookie-authenticated call needs Origin set to look same-origin,
  // or Payload's extractJWT silently discards the cookie (no error, just
  // treated as logged-out) before signature verification even runs.
  const tenantHeaders = (id) => ({ cookie: authCookie, ...originHeader(BASE_URL), ...(id ? { 'x-webdesk-tenant': id } : {}) });

  // seed via REST create (POST) for each tenant
  for (const [tid, title] of [[ACME, 'ACME rest page'], [GLOBEX, 'GLOBEX rest page']]) {
    const res = await fetch(`${BASE_URL}/api/pages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tenantHeaders(tid) },
      body: JSON.stringify({ tenantId: tid, title }),
    });
    check(`P9 POST create as ${title.split(' ')[0]}`, res.status < 300, `status ${res.status}: ${await res.text().catch(() => '')}`);
  }

  for (const [label, tid, want] of [['acme', ACME, 'ACME'], ['globex', GLOBEX, 'GLOBEX']]) {
    const res = await fetch(`${BASE_URL}/api/pages?limit=100`, { headers: tenantHeaders(tid) });
    const json = await res.json();
    const titles = (json.docs || []).map((d) => d.title);
    check(
      `P9 GET ${label}: sees only own rows`,
      titles.length > 0 && titles.every((t) => t.startsWith(want)),
      `got ${JSON.stringify(titles)}`,
    );
  }

  // fail-closed: authenticated, but no tenant header at all
  {
    const res = await fetch(`${BASE_URL}/api/pages?limit=100`, { headers: tenantHeaders(null) });
    const json = await res.json();
    check('P9 GET no tenant header: zero rows (fail-closed)', (json.docs || []).length === 0, `got ${JSON.stringify(json.docs)}`);
  }

  // cross-tenant write refusal over REST. Unlike Local API (P8), which
  // surfaces the raw driver error ("row-level security" in the message),
  // Payload's REST layer sanitizes unexpected DB errors into a generic
  // "Something went wrong" 500 - a deliberate no-internals-leaked posture,
  // not a different enforcement outcome. What actually matters (and what
  // the DB-level check below confirms) is that the row never landed.
  {
    const smuggledTitle = 'smuggled via REST';
    const res = await fetch(`${BASE_URL}/api/pages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tenantHeaders(ACME) },
      body: JSON.stringify({ tenantId: GLOBEX, title: smuggledTitle }),
    });
    const body = await res.text();
    check(
      'P9 POST cross-tenant row refused (non-2xx)',
      res.status >= 400,
      `status ${res.status}: ${body.slice(0, 300)}`,
    );
    // confirm via the OTHER tenant's own view that nothing was smuggled in
    const globexCheck = await fetch(`${BASE_URL}/api/pages?limit=100`, { headers: tenantHeaders(GLOBEX) });
    const globexTitles = ((await globexCheck.json()).docs || []).map((d) => d.title);
    check(
      'P9 POST cross-tenant row refused (no row landed, checked from GLOBEX side)',
      !globexTitles.includes(smuggledTitle),
      `globex saw ${JSON.stringify(globexTitles)}`,
    );
  }

  // pooled-connection reuse across two DIFFERENT HTTP requests (server pool
  // default max is >1, so this does not force reuse the way P13 does with
  // max=1 - it is here to prove request isolation holds under REST's own
  // concurrency, not to re-run the forced-reuse case which P13 already
  // covers against Payload's internals directly).
  {
    const [a, b] = await Promise.all([
      fetch(`${BASE_URL}/api/pages?limit=100`, { headers: tenantHeaders(ACME) }).then((r) => r.json()),
      fetch(`${BASE_URL}/api/pages?limit=100`, { headers: tenantHeaders(GLOBEX) }).then((r) => r.json()),
    ]);
    const aTitles = (a.docs || []).map((d) => d.title);
    const bTitles = (b.docs || []).map((d) => d.title);
    check(
      'P9 concurrent REST requests stay isolated (no cross-talk)',
      aTitles.every((t) => t.startsWith('ACME')) && bTitles.every((t) => t.startsWith('GLOBEX')),
      `acme saw ${JSON.stringify(aTitles)}, globex saw ${JSON.stringify(bTitles)}`,
    );
  }
} finally {
  await server.stop();
}

console.log(`\n  P9 REST: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

/**
 * P10 - Admin panel.
 *
 * Driven headlessly over plain HTTP (no browser), on purpose: Payload 3's
 * admin list view is server-rendered by app/(payload)/admin/[[...segments]]/
 * page.tsx (RootPage) - the SAME file this spike authored to wrap the
 * render in tenantStore.run() (see that file's header comment). A raw HTTP
 * GET against it, cookie-authenticated, exercises exactly the code path
 * that matters for the GUC question: does the admin SSR data load carry the
 * tenant context, or does it fall through to whatever the pool's default
 * (no-context) behavior is?
 *
 * What this probe does NOT attempt, and why: clicking through search /
 * pagination / save in the live admin UI needs a real browser, because
 * those are client-side React interactions bundled by @payloadcms/ui. That
 * is out of scope for a backend RLS spike - and it would not add evidence
 * here anyway, because every one of those interactions calls the exact
 * REST endpoint (`/api/pages`) P9 already drove end-to-end through the
 * identical wrapped route.ts. This probe's marginal contribution is
 * specifically the SSR path, which P9 does not touch.
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
  // AUTH TRAP (found resuming this spike): auth must come BEFORE the seed
  // writes, not after - Payload's default access control is
  // `Boolean(user)` for every operation on every collection with no
  // explicit `access` block, so an unauthenticated seed POST 403s silently
  // (the original version of this file never checked that result). See
  // bootstrapOrLogin's header comment in lib-server.mjs for why bootstrap
  // goes through Local API, not a plain `POST /api/users`.
  const { cookie: authCookie, via, status } = await bootstrapOrLogin(APP_URI, BASE_URL, 'wsk00-shared-admin@example.com', 'wsk-00-spike-password-1');
  check('P10 admin auth: obtained a session cookie', Boolean(authCookie), `via ${via}, status ${status}`);

  // seed rows so the admin list has something to (not) show
  // CSRF TRAP - see bootstrapOrLogin's header comment in lib-server.mjs:
  // Origin must be set on every cookie-authenticated call or the cookie is
  // silently discarded (treated as logged-out, not an error).
  for (const [tid, title] of [[ACME, 'ACME admin-ssr page'], [GLOBEX, 'GLOBEX admin-ssr page']]) {
    const res = await fetch(`${BASE_URL}/api/pages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: authCookie, ...originHeader(BASE_URL), 'x-webdesk-tenant': tid },
      body: JSON.stringify({ tenantId: tid, title }),
    });
    check(`P10 seed create as ${title.split(' ')[0]}`, res.status < 300, `status ${res.status}: ${await res.text().catch(() => '')}`);
  }

  const fetchAdminList = async (tenantId) => {
    const cookie = tenantId ? `${authCookie}; webdesk_tenant=${tenantId}` : authCookie;
    const res = await fetch(`${BASE_URL}/admin/collections/pages`, {
      headers: { cookie, ...originHeader(BASE_URL) },
      redirect: 'manual',
    });
    const html = await res.text();
    return { status: res.status, html };
  };

  // FINDING (see FINDINGS.md P10): these two checks are EXPECTED to fail as
  // of this spike. Root-caused via instrumentation during investigation
  // (not left in this file): tenantStore.getStore() reads correctly at
  // every point inside app/(payload)/admin/[[...segments]]/page.tsx's OWN
  // execution, but the actual pool RootPage's data load queries against
  // never observes it and the checkout log for that exact call is empty -
  // strong evidence that Next's Route Handler layer (route.ts, which P9
  // proves DOES work) and this Page/RSC layer end up with separate
  // instantiations of the tenant-pg.mjs/tenant-pool.mjs module graph, and
  // only whichever layer first triggers the shared Payload/pool singleton's
  // construction has its runWithTenant() writes actually seen by that
  // pool's checkout hook. The failure mode is fail-closed (renders "No
  // Results" for every tenant, confirmed by inspecting the raw HTML), not a
  // cross-tenant leak - but it means the admin SSR initial paint cannot
  // show ANY tenant's own content under this mechanism as currently wired.
  const acme = await fetchAdminList(ACME);
  check(
    'P10 admin SSR list as ACME: page renders (200) and contains ACME content, not GLOBEX',
    acme.status === 200 && acme.html.includes('ACME admin-ssr page') && !acme.html.includes('GLOBEX admin-ssr page'),
    `status ${acme.status}, has-acme=${acme.html.includes('ACME admin-ssr page')}, has-globex=${acme.html.includes('GLOBEX admin-ssr page')}`,
  );

  const globex = await fetchAdminList(GLOBEX);
  check(
    'P10 admin SSR list as GLOBEX: contains GLOBEX content, not ACME',
    globex.status === 200 && globex.html.includes('GLOBEX admin-ssr page') && !globex.html.includes('ACME admin-ssr page'),
    `status ${globex.status}, has-acme=${globex.html.includes('ACME admin-ssr page')}, has-globex=${globex.html.includes('GLOBEX admin-ssr page')}`,
  );

  const noTenant = await fetchAdminList(null);
  check(
    'P10 admin SSR list, authenticated but no tenant cookie: fail-closed (neither tenant\'s content)',
    !noTenant.html.includes('ACME admin-ssr page') && !noTenant.html.includes('GLOBEX admin-ssr page'),
    `status ${noTenant.status}, has-acme=${noTenant.html.includes('ACME admin-ssr page')}, has-globex=${noTenant.html.includes('GLOBEX admin-ssr page')}`,
  );
} finally {
  await server.stop();
}

console.log(`\n  P10 Admin: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

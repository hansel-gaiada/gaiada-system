#!/usr/bin/env node
/**
 * WSK-28 -- Zone B public status page generator.
 *
 * Polls each Zone B service's own /healthz (or equivalent) and renders status.json + index.html.
 * A target that cannot be reached reports "unknown", never a fabricated "up" -- see the
 * "an empty list is a claim" discipline (MEMORY: empty-list-is-a-claim.md) applied here to a
 * probe result instead of a query result: a probe that failed to reach its target is not the
 * same fact as a target that is confirmed healthy, and this generator must not conflate them.
 *
 * Run (loop, inside the status-page compose service):
 *   while true; do node gen-status-page.mjs; sleep "${WEBDESK_STATUS_REFRESH_SECONDS:-30}"; done
 *
 * Run (selftest, no network):
 *   node gen-status-page.mjs --selftest
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const OUT_DIR = process.env.WEBDESK_STATUS_OUT_DIR || path.join(process.cwd(), 'webdesk', 'ops', 'status-page', 'dist');

const TARGETS = [
  { name: 'proxy', url: process.env.WEBDESK_STATUS_PROXY_URL || 'http://proxy:80/healthz' },
  { name: 'api', url: process.env.WEBDESK_STATUS_API_URL || 'http://api:3000/healthz' },
  { name: 'payload-gateway', url: process.env.WEBDESK_STATUS_PAYLOAD_GATEWAY_URL || 'http://payload-gateway:3000/healthz' },
];

function probe(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode && res.statusCode < 400 ? 'up' : 'degraded');
    });
    req.on('timeout', () => {
      req.destroy();
      resolve('unknown'); // could not confirm -- NOT "down", we don't have enough evidence to say
    });
    req.on('error', () => resolve('unknown'));
  });
}

function renderHtml(statusDoc) {
  const rows = statusDoc.components
    .map((c) => `<tr><td>${c.name}</td><td class="state-${c.state}">${c.state}</td></tr>`)
    .join('\n');
  const anyDegraded = statusDoc.components.some((c) => c.state === 'degraded');
  const anyUnknown = statusDoc.components.some((c) => c.state === 'unknown');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>WebDesk status</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; }
  table { border-collapse: collapse; }
  td { padding: 0.4rem 1rem; border-bottom: 1px solid #ddd; }
  .state-up { color: #157347; font-weight: 600; }
  .state-degraded { color: #b02a37; font-weight: 600; }
  .state-unknown { color: #997404; font-weight: 600; }
  #stale-banner { display: none; background: #fff3cd; padding: 0.75rem; margin-bottom: 1rem; }
</style></head>
<body>
<div id="stale-banner">Data may be stale -- last refreshed more than 5 minutes ago.</div>
<h1>WebDesk status</h1>
${anyDegraded ? '<p><strong>Degraded:</strong> one or more components are not responding as expected.</p>' : ''}
${anyUnknown ? '<p><strong>Unknown:</strong> one or more components could not be reached to confirm their state.</p>' : ''}
<table>${rows}</table>
<p>generated_at: <span id="generated-at">${statusDoc.generated_at}</span></p>
<script>
  var generatedAt = new Date(document.getElementById('generated-at').textContent);
  if (Date.now() - generatedAt.getTime() > 5 * 60 * 1000) {
    document.getElementById('stale-banner').style.display = 'block';
  }
</script>
</body></html>`;
}

async function generate(fakeStates) {
  const components = [];
  for (const t of TARGETS) {
    const state = fakeStates ? (fakeStates[t.name] ?? 'unknown') : await probe(t.url);
    components.push({ name: t.name, state });
  }
  const statusDoc = { generated_at: new Date().toISOString(), components };
  return statusDoc;
}

function writeOutput(statusDoc, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'status.json'), JSON.stringify(statusDoc, null, 2));
  fs.writeFileSync(path.join(outDir, 'index.html'), renderHtml(statusDoc));
}

// --- selftest -------------------------------------------------------------------------------
async function selftest() {
  let ok = true;

  const allUp = await generate({ proxy: 'up', api: 'up', 'payload-gateway': 'up' });
  if (allUp.components.some((c) => c.state !== 'up')) {
    console.error('SELFTEST FAIL: all-up fixture did not render all-up');
    ok = false;
  } else {
    console.log('SELFTEST: all-up fixture renders correctly');
  }

  const oneDown = await generate({ proxy: 'up', api: 'degraded', 'payload-gateway': 'up' });
  const oneDownHtml = renderHtml(oneDown);
  if (!oneDownHtml.includes('Degraded')) {
    console.error('SELFTEST FAIL: a degraded component did not surface in rendered HTML');
    ok = false;
  } else {
    console.log('SELFTEST: degraded component correctly surfaced');
  }

  const unreachable = await generate({}); // no fixture entries -> every target defaults to unknown
  if (unreachable.components.some((c) => c.state === 'up')) {
    console.error('SELFTEST FAIL: unreachable targets were reported as "up" -- this is the exact fabricated-green failure mode this generator must not produce');
    ok = false;
  } else {
    console.log('SELFTEST: unreachable targets correctly reported as "unknown", never fabricated "up"');
  }
  const unreachableHtml = renderHtml(unreachable);
  if (!unreachableHtml.includes('Unknown')) {
    console.error('SELFTEST FAIL: unknown state did not surface a caveat in rendered HTML');
    ok = false;
  }

  return ok;
}

// --- entry --------------------------------------------------------------------------------
if (process.argv[2] === '--selftest') {
  const ok = await selftest();
  console.log(ok ? '\nSELFTEST: OK' : '\nSELFTEST: FAILED');
  process.exit(ok ? 0 : 1);
}

const statusDoc = await generate();
writeOutput(statusDoc, OUT_DIR);
console.log(`status page written to ${OUT_DIR} (${statusDoc.components.map((c) => `${c.name}=${c.state}`).join(', ')})`);

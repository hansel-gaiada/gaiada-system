// WebDesk public status page renderer (WSK-D64, WSK-D70; M4 T6b).
//
// Runs on sumopod (the observation box) in the `erp-status` compose project. Every INTERVAL_S it asks
// sumopod's own Prometheus for the blackbox probes of WebDesk's public endpoint and writes a static
// index.html + status.json into OUT_DIR, which a hardened Caddy serves. No dependencies; Node 22's fetch.
//
// It never claims "operational" without evidence: a probe that has not reported for STALE_S, or a
// Prometheus that does not answer, renders as "unknown", never as green. Nothing internal (hosts,
// addresses, error text) is published.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PROM = (process.env.PROM_URL || 'http://prometheus:9090').replace(/\/$/, '');
const OUT = process.env.OUT_DIR || '/out';
const INTERVAL_S = Number(process.env.INTERVAL_S || 60);
const STALE_S = Number(process.env.STALE_S || 300);

// Each component is one blackbox probe series (job + instance), labelled in prometheus.remote.yml.
const COMPONENTS = [
  {
    id: 'content-api',
    name: 'Content API',
    what: 'The /v1 API that websites read their content from.',
    sel: 'probe_success{job="blackbox-webdesk-api"}',
  },
  {
    id: 'edge',
    name: 'Public endpoint',
    what: 'The secure (TLS) entry point and edge proxy in front of the API.',
    sel: 'probe_success{job="blackbox-estate",instance="https://api.erp.gaiada.com/healthz"}',
  },
];

async function q(expr) {
  const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(expr)}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`prometheus ${res.status}`);
  const body = await res.json();
  const r = body?.data?.result?.[0];
  return r ? Number(r.value[1]) : null;
}

async function component(c) {
  const [up, age, u24, u7] = await Promise.all([
    q(c.sel),
    q(`time() - timestamp(${c.sel})`),
    q(`avg_over_time(${c.sel}[24h])`),
    q(`avg_over_time(${c.sel}[7d])`),
  ]);
  let state = 'unknown';
  if (up !== null && age !== null && age <= STALE_S) state = up === 1 ? 'operational' : 'down';
  return { id: c.id, name: c.name, what: c.what, state, uptime24h: u24, uptime7d: u7 };
}

async function collect() {
  try {
    const comps = await Promise.all(COMPONENTS.map(component));
    return { monitor: 'reporting', components: comps };
  } catch {
    return {
      monitor: 'not-reporting',
      components: COMPONENTS.map((c) => ({ id: c.id, name: c.name, what: c.what, state: 'unknown', uptime24h: null, uptime7d: null })),
    };
  }
}

function overall(s) {
  if (s.monitor !== 'reporting') return { key: 'unknown', text: 'Status unknown: the monitor is not reporting' };
  const states = s.components.map((c) => c.state);
  if (states.every((x) => x === 'operational')) return { key: 'operational', text: 'All systems operational' };
  if (states.includes('down')) return { key: 'down', text: states.every((x) => x === 'down') ? 'Major outage' : 'Partial outage' };
  return { key: 'unknown', text: 'Status unknown for some components' };
}

const esc = (v) => String(v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const pct = (v) => (v === null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(v >= 0.9995 ? 1 : 2)}%`);
const LABEL = { operational: 'Operational', down: 'Down', unknown: 'Unknown' };

function html(s, o, at) {
  const rows = s.components
    .map(
      (c) => `
      <li class="row">
        <div class="name"><span class="dot ${c.state}" aria-hidden="true"></span><strong>${esc(c.name)}</strong>
          <span class="what">${esc(c.what)}</span></div>
        <div class="state ${c.state}">${LABEL[c.state]}</div>
        <div class="up"><span>24 h</span>${pct(c.uptime24h)}</div>
        <div class="up"><span>7 days</span>${pct(c.uptime7d)}</div>
      </li>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>WebDesk status</title>
<style>
:root { --bg:#f7f7f5; --fg:#1d1d1b; --muted:#6b6b66; --card:#fff; --line:#e4e4df; --ok:#1f7a4d; --bad:#b42318; --unk:#8a6d1a; }
@media (prefers-color-scheme: dark) { :root { --bg:#141413; --fg:#ededea; --muted:#a3a39c; --card:#1e1e1c; --line:#33332f; --ok:#4cc38a; --bad:#f97066; --unk:#e0b84a; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:760px; margin:0 auto; padding:40px 16px 56px; }
h1 { font-size:1.4rem; margin:0 0 20px; }
.banner { padding:16px 20px; border-radius:10px; font-weight:600; margin-bottom:24px; color:#fff; }
.banner.operational { background:var(--ok); } .banner.down { background:var(--bad); } .banner.unknown { background:var(--unk); }
ul { list-style:none; margin:0; padding:0; background:var(--card); border:1px solid var(--line); border-radius:10px; }
.row { display:grid; grid-template-columns:1fr auto auto auto; gap:8px 20px; align-items:center; padding:16px 20px; border-top:1px solid var(--line); }
.row:first-child { border-top:0; }
.name { display:flex; flex-wrap:wrap; align-items:center; gap:4px 10px; }
.what { flex-basis:100%; color:var(--muted); font-size:.875rem; padding-left:20px; }
.dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
.dot.operational { background:var(--ok); } .dot.down { background:var(--bad); } .dot.unknown { background:var(--unk); }
.state { font-weight:600; } .state.operational { color:var(--ok); } .state.down { color:var(--bad); } .state.unknown { color:var(--unk); }
.up { text-align:right; font-variant-numeric:tabular-nums; } .up span { display:block; color:var(--muted); font-size:.75rem; }
footer { margin-top:20px; color:var(--muted); font-size:.875rem; }
@media (max-width:560px) { .row { grid-template-columns:1fr auto; } .up { text-align:left; } }
</style>
</head>
<body>
<main>
  <h1>WebDesk status</h1>
  <div class="banner ${o.key}" role="status">${esc(o.text)}</div>
  <ul>${rows}
  </ul>
  <footer>Checked every minute from an independent server. Updated ${esc(at)} (UTC).</footer>
</main>
</body>
</html>
`;
}

async function writeAtomic(name, data) {
  const tmp = join(OUT, `.${name}.tmp`);
  await writeFile(tmp, data);
  await rename(tmp, join(OUT, name));
}

async function tick() {
  const s = await collect();
  const o = overall(s);
  const at = new Date().toISOString().replace('T', ' ').slice(0, 16);
  await writeAtomic('status.json', JSON.stringify({ updatedAt: new Date().toISOString(), overall: o.key, ...s }, null, 2) + '\n');
  await writeAtomic('index.html', html(s, o, at));
  console.log(`[status-page] ${new Date().toISOString()} ${o.key} ${s.components.map((c) => `${c.id}=${c.state}`).join(' ')}`);
}

let timer;
const stop = () => { clearTimeout(timer); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

await mkdir(OUT, { recursive: true });
const loop = async () => {
  try { await tick(); } catch (e) { console.error(`[status-page] render failed: ${e.message}`); }
  timer = setTimeout(loop, INTERVAL_S * 1000);
};
loop();

#!/usr/bin/env node
/**
 * WSK-28 / WSK-D63 (2) -- the OTLP write-only auditor.
 *
 * WHY THIS EXISTS (design v2 §03 channel 2, "write-only bearer + TLS; rate-limited; no query
 * surface"): WebDesk's telemetry reaches the ERP's otel-collector through ONE extra receiver
 * (`otlp/webdesk`, published on 172.17.0.1 only). That receiver must be able to ACCEPT pushes and
 * must NEVER give the caller a way to read anything back, and an empty token must mean "refuse
 * everything", never "open". A receiver alone is safe by construction; what makes the config unsafe is
 * what sits next to it: a debug/introspection extension, a pipeline that feeds a scrapeable exporter,
 * a port published beyond docker0, a literal secret, or a "placeholder" default token.
 *
 * STATIC auditor, not a live probe (the live proof is the guard harness + containment probe 6, and the
 * rollout's token-refusal check). It carries a small indentation-based YAML reader rather than a YAML
 * dependency this project does not otherwise have; the shapes it must read are fixed and simple.
 *
 * Run:
 *   node check-otlp-write-only.mjs <collector-config.yaml>                       (dedicated instance: every otlp* receiver)
 *   node check-otlp-write-only.mjs <collector-config.yaml> --receiver otlp/webdesk \
 *        [--compose <docker-compose.yml> --service otel-collector]               (shared instance: that one receiver)
 *   node check-otlp-write-only.mjs --selftest
 *
 * Exit 0 = no finding. Exit 1 = at least one. Exit 2 = usage.
 */

// --- a small YAML-subset reader ---------------------------------------------------------------
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(raw) {
  const v = raw.trim();
  if (v === '[]') return [];
  if (v === '{}') return {};
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean).map(scalar);
  }
  // Quoted scalars are kept RAW (escapes unprocessed): the compose check compares source text.
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function splitKey(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ':' && (i === text.length - 1 || text[i + 1] === ' ')) {
      return { key: text.slice(0, i).trim(), rest: text.slice(i + 1).trim() };
    }
  }
  return null;
}

export function parseYaml(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = stripComment(raw);
    if (!t.trim()) continue;
    lines.push({ indent: t.match(/^ */)[0].length, text: t.trim() });
  }
  let i = 0;
  const isItem = (l) => l.text === '-' || l.text.startsWith('- ');
  function block(indent) { return isItem(lines[i]) ? list(indent) : map(indent); }
  function map(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !isItem(lines[i])) {
      const kv = splitKey(lines[i].text);
      if (!kv) { i++; continue; }
      i++;
      // A YAML anchor (`key: &name`) carries its block below, exactly like a bare `key:`.
      if (/^&\S+$/.test(kv.rest)) kv.rest = '';
      if (kv.rest === '') {
        obj[kv.key] = i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && isItem(lines[i])))
          ? block(lines[i].indent) : null;
      } else {
        obj[kv.key] = scalar(kv.rest);
        // Block scalars (`key: |`) continue on deeper lines; they are text, not structure.
        while (i < lines.length && lines[i].indent > indent) i++;
      }
    }
    return obj;
  }
  function list(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && isItem(lines[i])) {
      const item = lines[i].text.slice(1).trim();
      if (item === '') { i++; arr.push(block(lines[i].indent)); continue; }
      const kv = splitKey(item);
      if (kv && !/^["'\[{]/.test(item)) { lines[i] = { indent: indent + 2, text: item }; arr.push(map(indent + 2)); }
      else { arr.push(scalar(item)); i++; }
    }
    return arr;
  }
  return lines.length ? block(lines[0].indent) : {};
}

// --- the audit ----------------------------------------------------------------------------------
const READ_CAPABLE_EXTENSIONS = ['zpages', 'pprof', 'health_check', 'healthcheckv2', 'jaeger_query', 'jaegerquery', 'remotetap', 'expvar'];
const ENV_TOKEN = /^\$\{env:([A-Z][A-Z0-9_]*)\}$/;
// Passed by compose when the operator's variable is empty/unset. U+0001, written as a YAML escape.
const COMPOSE_DEFAULT = (name) => '${' + name + ':-\\x01}';
const BIND = '172.17.0.1';

const typeOf = (id) => String(id).split('/')[0];
const portOf = (endpoint) => { const m = /:(\d+)$/.exec(String(endpoint ?? '')); return m ? m[1] : null; };
const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

export function audit(configText, opts = {}) {
  const cfg = parseYaml(configText);
  const findings = [];
  const receivers = cfg.receivers || {};
  const extensions = cfg.extensions || {};
  const pipelines = (cfg.service && cfg.service.pipelines) || {};
  const targets = opts.receiver
    ? [opts.receiver]
    : Object.keys(receivers).filter((r) => typeOf(r) === 'otlp');

  if (opts.receiver && !receivers[opts.receiver]) findings.push(`receiver "${opts.receiver}" is not defined`);
  if (targets.length === 0) findings.push('no otlp receiver found -- nothing to audit as the write-only listener');

  const envNames = new Set();
  const usedPorts = new Map(); // port -> receiver id, across ALL receivers (a collision is a finding)
  for (const [rid, r] of Object.entries(receivers)) {
    for (const p of Object.values((r && r.protocols) || {})) {
      const port = portOf(p && p.endpoint);
      if (port) { if (usedPorts.has(port) && usedPorts.get(port) !== rid) findings.push(`port ${port} is bound by both "${usedPorts.get(port)}" and "${rid}"`); usedPorts.set(port, rid); }
    }
  }

  for (const rid of targets) {
    const protocols = (receivers[rid] && receivers[rid].protocols) || {};
    if (Object.keys(protocols).length === 0) findings.push(`receiver "${rid}" declares no protocols`);
    for (const [pname, p] of Object.entries(protocols)) {
      const auth = p && p.auth && p.auth.authenticator;
      if (!auth) { findings.push(`receiver "${rid}" protocol ${pname} has no auth.authenticator -- an unauthenticated push endpoint`); continue; }
      if (typeOf(auth) !== 'bearertokenauth') findings.push(`receiver "${rid}" ${pname} authenticator "${auth}" is not a bearertokenauth extension`);
      const ext = extensions[auth];
      if (!ext) { findings.push(`receiver "${rid}" ${pname} names authenticator "${auth}" which is not defined under extensions`); continue; }
      const svcExt = asList(cfg.service && cfg.service.extensions);
      if (!svcExt.includes(auth)) findings.push(`authenticator "${auth}" is not listed in service.extensions -- the receiver would not start`);
      for (const t of [ext.token, ...asList(ext.tokens)].filter((x) => x != null)) {
        const m = ENV_TOKEN.exec(String(t));
        if (!m) findings.push(`extension "${auth}" holds a literal token -- it must be \${env:NAME} (a secret in a public repo)`);
        else envNames.add(m[1]);
      }
      if (ext.token == null && !ext.filename && !ext.tokens) findings.push(`extension "${auth}" has no token source`);
    }
  }

  // Read-capable extensions anywhere on the instance (reachable on whatever port they bind, if published).
  for (const ext of Object.keys(extensions)) {
    if (READ_CAPABLE_EXTENSIONS.includes(typeOf(ext))) findings.push(`read-capable extension "${ext}" is defined on this collector instance`);
  }
  // Dedicated-instance mode only: a pull receiver on the same instance is a read path. (On the shared
  // ERP collector, prometheus/scrape is internal and unpublished; the compose check covers reachability.)
  if (!opts.receiver && Object.keys(receivers).some((r) => typeOf(r) === 'prometheus')) {
    findings.push('a prometheus receiver (scrape / read path) is present on this collector instance');
  }

  // Shared-instance mode: how the webdesk receiver is wired into pipelines.
  if (opts.receiver) {
    const processors = cfg.processors || {};
    let wired = 0;
    for (const [pid, pl] of Object.entries(pipelines)) {
      const recv = asList(pl && pl.receivers);
      if (!recv.includes(opts.receiver)) continue;
      wired++;
      const signal = typeOf(pid);
      if (signal !== 'traces' && signal !== 'logs') findings.push(`pipeline "${pid}" carries ${signal} from "${opts.receiver}": only traces and logs may (a metrics path feeds a scrapeable exporter)`);
      if (recv.length !== 1) findings.push(`pipeline "${pid}" mixes "${opts.receiver}" with other receivers (${recv.join(', ')}) -- webdesk data must travel alone`);
      const procs = asList(pl.processors);
      if (!procs.length || typeOf(procs[0]) !== 'memory_limiter') findings.push(`pipeline "${pid}" does not start with a memory_limiter`);
      const stamps = procs.some((p) => typeOf(p) === 'resource' && asList(processors[p] && processors[p].attributes).some((a) => a && a.key === 'service.namespace' && a.action === 'upsert'));
      if (!stamps) findings.push(`pipeline "${pid}" has no resource processor that upserts service.namespace (a sender could claim any namespace)`);
      for (const e of asList(pl.exporters)) {
        if (typeOf(e) === 'prometheus' || typeOf(e) === 'prometheusremotewrite') findings.push(`pipeline "${pid}" exports to "${e}", a read/scrape surface`);
      }
    }
    if (receivers[opts.receiver] && wired === 0) findings.push(`receiver "${opts.receiver}" is defined but feeds no pipeline`);
  }

  // Compose: what is PUBLISHED decides what is reachable.
  if (opts.compose) {
    const compose = parseYaml(opts.compose);
    const svc = compose.services && compose.services[opts.service || 'otel-collector'];
    if (!svc) findings.push(`compose has no service "${opts.service || 'otel-collector'}"`);
    else {
      const want = opts.receiver ? portOf(((receivers[opts.receiver] || {}).protocols || {}).http?.endpoint) : null;
      if (svc.network_mode === 'host') findings.push('collector uses network_mode: host -- every receiver and extension port is on the host');
      const ports = asList(svc.ports);
      if (opts.receiver && !ports.length) findings.push(`compose publishes nothing for the receiver (expected ${BIND}:${want}:${want})`);
      for (const pt of ports) {
        const s = String(typeof pt === 'object' && pt ? `${pt.host_ip ?? ''}:${pt.published}:${pt.target}` : pt).replace(/\/tcp$/, '');
        if (!want || s !== `${BIND}:${want}:${want}`) findings.push(`compose publishes "${s}" -- only ${BIND}:${want}:${want} (docker0, the webdesk receiver) may be published`);
      }
      const env = svc.environment || {};
      for (const name of envNames) {
        if (env[name] !== COMPOSE_DEFAULT(name)) findings.push(`compose environment ${name} must be exactly "${COMPOSE_DEFAULT(name)}" (empty must refuse everything; a printable default would be an open door), found ${JSON.stringify(env[name])}`);
      }
      if (opts.receiver && envNames.size === 0) findings.push('no ${env:NAME} token variable found to check the compose default against');
    }
  }
  return findings;
}

// --- selftest -----------------------------------------------------------------------------------
const GOOD_CONFIG = `
extensions:
  file_storage:
    directory: /q
  bearertokenauth/webdesk:
    scheme: Bearer
    token: \${env:WEBDESK_OTLP_BEARER_TOKEN}
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
  prometheus/scrape:
    config: {}
  otlp/webdesk:
    protocols:
      http:
        endpoint: 0.0.0.0:4319
        auth:
          authenticator: bearertokenauth/webdesk
processors:
  memory_limiter/webdesk:
    check_interval: 5s
  resource/webdesk:
    attributes:
      - key: service.namespace
        value: webdesk
        action: upsert
  batch: {}
exporters:
  prometheus:
    endpoint: 0.0.0.0:8889
  otlp/tempo:
    endpoint: tempo:4317
service:
  extensions: [file_storage, bearertokenauth/webdesk]
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp/tempo]
    metrics:
      receivers: [otlp]
      exporters: [prometheus]
    traces/webdesk:
      receivers: [otlp/webdesk]
      processors: [memory_limiter/webdesk, resource/webdesk, batch]
      exporters: [otlp/tempo]
`;
const GOOD_COMPOSE = `
services:
  otel-collector:
    ports:
      - "172.17.0.1:4319:4319"
    environment:
      WEBDESK_OTLP_BEARER_TOKEN: "\${WEBDESK_OTLP_BEARER_TOKEN:-\\x01}"
`;

function selftest() {
  const O = { receiver: 'otlp/webdesk', service: 'otel-collector' };
  const run = (cfg, comp, o = O) => audit(cfg, { ...o, compose: comp });
  const cases = [
    // [label, config, compose, options, must-match-substring | null (= must pass clean)]
    ['known-good shared-instance config + compose pass clean', GOOD_CONFIG, GOOD_COMPOSE, O, null],
    ['receiver without auth', GOOD_CONFIG.replace(/        auth:\n          authenticator: bearertokenauth\/webdesk\n/, ''), GOOD_COMPOSE, O, 'no auth.authenticator'],
    ['authenticator not a bearertokenauth', GOOD_CONFIG.replace(/authenticator: bearertokenauth\/webdesk/, 'authenticator: basicauth/webdesk'), GOOD_COMPOSE, O, 'not a bearertokenauth'],
    ['authenticator undefined', GOOD_CONFIG.replace(/  bearertokenauth\/webdesk:\n    scheme: Bearer\n    token: \$\{env:WEBDESK_OTLP_BEARER_TOKEN\}\n/, ''), GOOD_COMPOSE, O, 'not defined under extensions'],
    ['literal token in the config', GOOD_CONFIG.replace('${env:WEBDESK_OTLP_BEARER_TOKEN}', 'wdotlp_realsecret'), GOOD_COMPOSE, O, 'literal token'],
    ['zpages extension on the instance', GOOD_CONFIG.replace('  file_storage:\n', '  zpages:\n    endpoint: 0.0.0.0:55679\n  file_storage:\n'), GOOD_COMPOSE, O, 'read-capable extension'],
    ['health_check extension on the instance', GOOD_CONFIG.replace('  file_storage:\n', '  health_check:\n    endpoint: 0.0.0.0:13133\n  file_storage:\n'), GOOD_COMPOSE, O, 'read-capable extension'],
    ['webdesk receiver in a metrics pipeline', GOOD_CONFIG.replace('    traces/webdesk:\n', '    metrics/webdesk:\n'), GOOD_COMPOSE, O, 'only traces and logs'],
    ['webdesk receiver shares a pipeline', GOOD_CONFIG.replace('receivers: [otlp/webdesk]', 'receivers: [otlp/webdesk, otlp]'), GOOD_COMPOSE, O, 'travel alone'],
    ['webdesk pipeline feeds the prometheus exporter', GOOD_CONFIG.replace('processors: [memory_limiter/webdesk, resource/webdesk, batch]\n      exporters: [otlp/tempo]', 'processors: [memory_limiter/webdesk, resource/webdesk, batch]\n      exporters: [otlp/tempo, prometheus]'), GOOD_COMPOSE, O, 'scrape surface'],
    ['webdesk pipeline lacks the namespace stamp', GOOD_CONFIG.replace('resource/webdesk, ', ''), GOOD_COMPOSE, O, 'service.namespace'],
    ['webdesk pipeline lacks a memory_limiter', GOOD_CONFIG.replace('memory_limiter/webdesk, ', ''), GOOD_COMPOSE, O, 'memory_limiter'],
    ['webdesk port collides with another receiver', GOOD_CONFIG.replace('0.0.0.0:4319', '0.0.0.0:4318'), GOOD_COMPOSE.replace(/4319/g, '4318'), O, 'is bound by both'],
    ['compose publishes on all interfaces', GOOD_CONFIG, GOOD_COMPOSE.replace('172.17.0.1:4319:4319', '0.0.0.0:4319:4319'), O, 'may be published'],
    ['compose publishes without a host address', GOOD_CONFIG, GOOD_COMPOSE.replace('172.17.0.1:4319:4319', '4319:4319'), O, 'may be published'],
    ['compose also publishes the ERP receiver', GOOD_CONFIG, GOOD_COMPOSE.replace('      - "172.17.0.1:4319:4319"\n', '      - "172.17.0.1:4319:4319"\n      - "127.0.0.1:4318:4318"\n'), O, 'may be published'],
    ['compose publishes nothing', GOOD_CONFIG, GOOD_COMPOSE.replace('    ports:\n      - "172.17.0.1:4319:4319"\n', ''), O, 'publishes nothing'],
    ['compose token default is a printable placeholder', GOOD_CONFIG, GOOD_COMPOSE.replace('\\x01', 'placeholder'), O, 'open door'],
    ['compose token default is empty', GOOD_CONFIG, GOOD_COMPOSE.replace(':-\\x01', ''), O, 'open door'],
    ['collector on the host network', GOOD_CONFIG, GOOD_COMPOSE.replace('    ports:', '    network_mode: host\n    ports:'), O, 'network_mode: host'],
    // Dedicated-instance mode (the original WSK-28 shape).
    ['dedicated instance, authenticated, passes clean', DEDICATED, null, {}, null],
    ['dedicated instance without auth', DEDICATED.replace(/        auth:\n          authenticator: bearertokenauth\n/, ''), null, {}, 'no auth.authenticator'],
    ['dedicated instance with a prometheus receiver', DEDICATED.replace('receivers:\n', 'receivers:\n  prometheus:\n    config: {}\n'), null, {}, 'prometheus receiver'],
  ];
  let ok = true;
  let n = 0;
  for (const [label, cfg, comp, o, expect] of cases) {
    const f = comp == null ? audit(cfg, o) : run(cfg, comp, o);
    const pass = expect === null ? f.length === 0 : f.some((x) => x.includes(expect));
    if (pass) { n++; console.log(`SELFTEST ok   ${label}${expect ? '  -> ' + f.find((x) => x.includes(expect)) : ''}`); }
    else { ok = false; console.error(`SELFTEST FAIL ${label}: expected ${expect === null ? 'no findings' : JSON.stringify(expect)}, got ${JSON.stringify(f)}`); }
  }
  // The mutation cases are only meaningful if each mutation actually changed its input.
  for (const [label, cfg, comp] of cases.slice(1)) {
    if (cfg === GOOD_CONFIG && comp === GOOD_COMPOSE) { ok = false; console.error(`SELFTEST FAIL ${label}: the mutation changed nothing (a vacuous case)`); }
  }
  return { ok, n, total: cases.length };
}

const DEDICATED = `
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
        auth:
          authenticator: bearertokenauth
extensions:
  bearertokenauth:
    scheme: Bearer
    token: \${env:TOKEN}
exporters:
  otlp/downstream:
    endpoint: grafana-collector:4317
service:
  extensions: [bearertokenauth]
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp/downstream]
`;

// --- entry ------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv[0] === '--selftest') {
  const { ok, n, total } = selftest();
  console.log(ok ? `\nSELFTEST: ${n}/${total} OK` : `\nSELFTEST: FAILED (${n}/${total})`);
  process.exit(ok ? 0 : 1);
}
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const file = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
if (!file) {
  console.error('usage: node check-otlp-write-only.mjs <config.yaml> [--receiver ID [--compose FILE --service NAME]] | --selftest');
  process.exit(2);
}
const fs = await import('node:fs');
const composeFile = flag('--compose');
const findings = audit(fs.readFileSync(file, 'utf8'), {
  receiver: flag('--receiver'),
  service: flag('--service'),
  compose: composeFile ? fs.readFileSync(composeFile, 'utf8') : undefined,
});
if (findings.length === 0) {
  console.log(`PASS: ${file}${composeFile ? ' + ' + composeFile : ''} -- ${flag('--receiver') || 'otlp receiver(s)'} carry no read-capable surface`);
  process.exit(0);
}
console.error(`FAIL: ${file}`);
for (const f of findings) console.error(`  - ${f}`);
process.exit(1);

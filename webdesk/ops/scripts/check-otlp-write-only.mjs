#!/usr/bin/env node
/**
 * WSK-28 — the OTLP write-only auditor.
 *
 * WHY THIS EXISTS (design §02/§03: "B->A #2: OTLP push (write-only)" / "the listener exposes no
 * query surface"): the Zone A collector that ingests Zone B's telemetry must be able to ACCEPT
 * pushes and must NEVER give a caller a way to read anything back. A receiver alone ("otlp") is
 * safe by construction -- it has no query API. What makes a collector config unsafe is anything
 * ELSE alongside it: a debug/introspection extension (zpages, pprof) reachable on the same
 * network path, or an exporter that turns around and answers reads.
 *
 * This is a STATIC config auditor, not a live probe -- there is no live listener yet (A-12).
 * It parses a minimal YAML subset (collector configs use a small, predictable shape) rather than
 * pulling in a YAML dependency this project doesn't otherwise have.
 *
 * Run:  node check-otlp-write-only.mjs <path-to-collector-config.yaml>
 *       node check-otlp-write-only.mjs --selftest    (no file needed)
 *
 * Exit 0 = the config's otlp receiver(s) carry no read-capable surface. Exit 1 = they do.
 */

// --- minimal, deliberately narrow YAML-shape reader -------------------------------------------
// Collector configs are a predictable two-space-indented block structure. We only need to know,
// per top-level key (receivers/processors/exporters/extensions/service), which second-level keys
// exist and what auth/extensions each declares -- not a general YAML parser.
function parseCollectorConfig(text) {
  const lines = text.split('\n');
  const topLevel = {}; // { receivers: { otlp: { ... } }, extensions: { zpages: {} }, ... }
  let currentTop = null;
  let currentSecond = null;
  let currentSecondIndent = null;
  let inAuthBlock = false; // true while inside a receiver's `auth:` sub-block
  const authRefs = {}; // secondLevelKey -> auth extension name, if declared

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^(\s*)/)[1].length;
    const trimmed = raw.trim();

    if (indent === 0 && trimmed.endsWith(':')) {
      currentTop = trimmed.slice(0, -1);
      topLevel[currentTop] = topLevel[currentTop] || {};
      currentSecond = null;
      inAuthBlock = false;
      continue;
    }
    // Second-level key: the first line seen at a deeper indent than currentTop under
    // receivers/extensions/exporters (real collector configs indent receiver names 2 spaces,
    // but be tolerant of 1 or 4 -- just "the first indent level under the top key").
    if (currentTop && (currentSecond === null || indent <= currentSecondIndent) &&
        trimmed.endsWith(':') && indent > 0 && indent < 6) {
      currentSecond = trimmed.slice(0, -1);
      currentSecondIndent = indent;
      topLevel[currentTop][currentSecond] = topLevel[currentTop][currentSecond] || {};
      inAuthBlock = false;
      continue;
    }

    if (!currentTop || !currentSecond || indent <= currentSecondIndent) continue;

    // `auth:` as its own key (real syntax: `auth:` then `authenticator: <name>` on the next
    // line), OR the more permissive inline `auth: <name>` some configs might use.
    if (/^auth:\s*$/.test(trimmed)) {
      inAuthBlock = true;
      continue;
    }
    const inlineAuthMatch = trimmed.match(/^auth:\s*(\S+)/);
    if (inlineAuthMatch && currentTop === 'receivers') {
      authRefs[currentSecond] = inlineAuthMatch[1];
      continue;
    }
    if (inAuthBlock && currentTop === 'receivers') {
      const authenticatorMatch = trimmed.match(/^authenticator:\s*(\S+)/);
      if (authenticatorMatch) {
        authRefs[currentSecond] = authenticatorMatch[1];
        inAuthBlock = false;
      }
    }
  }
  return { topLevel, authRefs };
}

const READ_CAPABLE_EXTENSIONS = ['zpages', 'zpagesextension', 'pprof', 'pprofextension'];

function audit(text) {
  const { topLevel, authRefs } = parseCollectorConfig(text);
  const findings = [];

  const receivers = Object.keys(topLevel.receivers || {});
  const otlpReceivers = receivers.filter((r) => r === 'otlp' || r.startsWith('otlp/'));

  if (otlpReceivers.length === 0) {
    findings.push('no otlp receiver found -- nothing to audit as the write-only listener');
  }

  for (const r of otlpReceivers) {
    if (!authRefs[r]) {
      findings.push(`receiver "${r}" has no auth: extension -- an unauthenticated push endpoint`);
    }
  }

  // Any read-capable extension present anywhere is a finding, regardless of whether it's wired
  // into the same pipeline -- if it's defined and enabled under `extensions:` on this collector
  // instance, it is reachable on whatever port that instance binds, which is exactly the
  // "query surface alongside the push-only receiver" this checker exists to catch.
  const extensions = Object.keys(topLevel.extensions || {});
  for (const ext of extensions) {
    if (READ_CAPABLE_EXTENSIONS.some((bad) => ext === bad || ext.startsWith(bad + '/'))) {
      findings.push(`read-capable extension "${ext}" is defined on this collector instance`);
    }
  }

  // A prometheus RECEIVER (as opposed to exporter) on the same instance means something can
  // scrape THIS collector for data -- a pull/read path, which the design forbids for this
  // listener ("the listener exposes no query surface").
  if (receivers.includes('prometheus')) {
    findings.push('a prometheus receiver (scrape / read path) is present on this collector instance');
  }

  return findings;
}

// --- selftest -----------------------------------------------------------------------------------
function selftest() {
  const good = `
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
exporters:
  otlp/downstream:
    endpoint: grafana-collector:4317
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp/downstream]
`;
  const bad = `
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
  zpages:
    endpoint: 0.0.0.0:55679
exporters:
  otlp/downstream:
    endpoint: grafana-collector:4317
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp/downstream]
`;
  const noAuth = `
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
exporters:
  otlp/downstream:
    endpoint: grafana-collector:4317
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp/downstream]
`;

  let ok = true;

  const goodFindings = audit(good);
  if (goodFindings.length !== 0) {
    console.error('SELFTEST FAIL: known-good config flagged:', goodFindings);
    ok = false;
  } else {
    console.log('SELFTEST: known-good config passes clean (expected)');
  }

  const badFindings = audit(bad);
  if (badFindings.length === 0) {
    console.error('SELFTEST FAIL: config with a zpages extension was NOT flagged -- the check would miss the exact regression it exists to catch');
    ok = false;
  } else {
    console.log('SELFTEST: zpages-extension config correctly flagged:', badFindings);
  }

  const noAuthFindings = audit(noAuth);
  if (noAuthFindings.length === 0) {
    console.error('SELFTEST FAIL: unauthenticated otlp receiver was NOT flagged');
    ok = false;
  } else {
    console.log('SELFTEST: unauthenticated receiver correctly flagged:', noAuthFindings);
  }

  return ok;
}

// --- entry ----------------------------------------------------------------------------------
const arg = process.argv[2];
if (arg === '--selftest') {
  const ok = selftest();
  console.log(ok ? '\nSELFTEST: 3/3 OK' : '\nSELFTEST: FAILED');
  process.exit(ok ? 0 : 1);
}

if (!arg) {
  console.error('usage: node check-otlp-write-only.mjs <config.yaml> | --selftest');
  process.exit(2);
}

const fs = await import('node:fs');
const text = fs.readFileSync(arg, 'utf8');
const findings = audit(text);
if (findings.length === 0) {
  console.log(`PASS: ${arg} -- otlp receiver(s) carry no read-capable surface`);
  process.exit(0);
} else {
  console.error(`FAIL: ${arg}`);
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}

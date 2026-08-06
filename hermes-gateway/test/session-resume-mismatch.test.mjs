// hermes-gateway/test/session-resume-mismatch.test.mjs — ASST-24 adversarial addition, FIXED.
//
// ORIGINAL QUESTION (ASST-24 QA gate): "if hermes-gateway restarts (loses in-memory state) and the
// platform still holds the old hermes_session_id, what actually happens on the next request? Does
// it fail loudly (typed error) or silently start a fresh, unrelated session while claiming
// continuity?"
//
// This file USED TO characterize a real MEDIUM defect (see the QA gate report,
// docs/superpowers/plans/2026-08-06-asst-24-qa-gate-report.md §1): a stale/unknown
// `providerSession` was silently forked — `event: session` named a different id than requested,
// `event: done` fired, and NOTHING anywhere signalled that continuity had not happened. It now
// asserts the FIX instead of the bug: `event: session` gains two ADDITIVE fields (`resumed`,
// `requestedSession`) — same grammar, no new event name, no `event: error` (the reply itself is a
// perfectly valid answer; only the continuity claim was false, and that is now told honestly).
// See server.mjs's `writeSSESession` + the `finish()` closure, and
// docs/FRONTEND-BFF-CONTRACT.md §18's "ASST-24" addendum.
//
// Three cases, all exercised end-to-end against the real server.mjs as a child process:
//   1. Stale/unknown providerSession -> Hermes forks -> resumed: false, both ids present, reply
//      still completes normally (event: done, no event: error).
//   2. Happy path: providerSession requested and Hermes actually resumes it (echoes the SAME id
//      back) -> resumed: true, requestedSession === the id that was sent.
//   3. No resume requested at all (turn 1, fresh conversation) -> resumed: true, no
//      requestedSession field (never invented, never sent empty — same discipline the wire grammar
//      already applies to providerSession/usage/session themselves).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "server.mjs");
const FAKE_HERMES_PATH = path.join(__dirname, "fixtures", "fake-hermes.mjs");
// fake-hermes.mjs's "happy" mode ECHOES back whatever --resume id it received (or mints
// "fixture-session-abc123" when none was passed) — exactly what's needed for the happy-path and
// no-resume-requested cases below.
const FAKE_HERMES_BIN = `"${process.execPath}" "${FAKE_HERMES_PATH}"`;

// A SEPARATE, standalone fixture (kept out of fake-hermes.mjs so its behaviour stays untouched):
// simulates Hermes having lost/rotated its session store (e.g. a hermes-gateway/host restart) —
// it IGNORES any incoming `--resume <id>` entirely and mints a brand-new, unrelated session id,
// while still exiting 0 with a perfectly well-formed box + footer. This is what a real Hermes CLI
// does when asked to resume an id it no longer has any record of.
function buildForkingFixtureSrc() {
  const BOX_TOP = "╭─ ⚕ Hermes ─╮";
  const BOX_BODY = "│ forked reply │";
  const BOX_BOTTOM = "╰" + "─".repeat(18) + "╯";
  const lines = [
    'const write = (s) => process.stdout.write(s);',
    'async function run() {',
    '  write("Query: (fixture prompt)\\n");',
    '  write("Initializing...\\n");',
    `  write(${JSON.stringify(BOX_TOP + "\n")});`,
    `  write(${JSON.stringify(BOX_BODY + "\n")});`,
    `  write(${JSON.stringify(BOX_BOTTOM + "\n")});`,
    '  write("\\n");',
    '  const forkedId = "forked-session-" + Math.random().toString(36).slice(2, 10);',
    '  write("Session: " + forkedId + "\\n");',
    '  write("Resume with: hermes chat --resume " + forkedId + "\\n");',
    '  process.exit(0);',
    '}',
    'run();',
  ];
  return lines.join("\n");
}
const FORKING_FIXTURE_SRC = buildForkingFixtureSrc();

let portCounter = 33990;
function nextPort() {
  return portCounter++;
}

async function waitForHealth(port, token, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server on port ${port} never became healthy: ${lastErr?.message}`);
}

async function startServer(hermesBin, extraEnv = {}) {
  const port = nextPort();
  const token = "test-token";
  const workDir = mkdtempSync(path.join(tmpdir(), "hermes-gw-fork-work-"));
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      GATEWAY_TOKEN: token,
      HERMES_BIN: hermesBin,
      HERMES_CWD: workDir,
      HERMES_STREAM_TIMEOUT_MS: "240000",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth(port, token);
  return {
    port,
    token,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => child.on("close", r));
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

/** Split a raw SSE body into {event, dataLines} blocks and decode each `data:` line's JSON. */
function parseSSE(body) {
  return body
    .split("\n\n")
    .filter((b) => b.length > 0)
    .map((block) => {
      const lines = block.split("\n");
      let event = "message";
      const dataLines = [];
      for (const line of lines) {
        if (line.startsWith("event: ")) event = line.slice("event: ".length);
        else if (line.startsWith("data: ")) dataLines.push(line.slice("data: ".length));
      }
      return { event, data: dataLines.map((d) => JSON.parse(d)) };
    });
}

async function streamOnce(port, token, body) {
  const res = await fetch(`http://127.0.0.1:${port}/complete/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return parseSSE(await res.text());
}

test("FIXED: a stale/unknown providerSession is forked, but now REPORTED as a failed resume via event:session's resumed:false — never event:error, reply still completes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hermes-gw-fork-"));
  const fixturePath = path.join(dir, "forking-hermes.mjs");
  writeFileSync(fixturePath, FORKING_FIXTURE_SRC);
  const s = await startServer(`"${process.execPath}" "${fixturePath}"`);
  try {
    const staleSessionId = "sess-from-a-hermes-gateway-that-since-restarted";
    const frames = await streamOnce(s.port, s.token, {
      prompt: "continue our earlier conversation",
      providerSession: staleSessionId,
    });

    // The reply still completes normally — this is a valid answer, only the continuity claim
    // is false, so it must NEVER be reported as event:error.
    assert.equal(frames.filter((f) => f.event === "error").length, 0);
    assert.equal(frames.filter((f) => f.event === "done").length, 1);

    const sessionFrame = frames.find((f) => f.event === "session");
    assert.ok(sessionFrame, "expected an event:session frame");
    const { providerSession, requestedSession, resumed } = sessionFrame.data[0];

    // The returned session id is NOT the one that was asked to be resumed — Hermes silently
    // forked a brand-new, unrelated conversation instead of continuing the old one.
    assert.notEqual(providerSession, staleSessionId, "fixture sanity check: forked id must differ");
    // THE FIX: both ids are now on the wire, and resumed is explicitly false.
    assert.equal(requestedSession, staleSessionId);
    assert.equal(resumed, false);
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("happy path: providerSession requested and actually resumed (id returned unchanged) -> resumed: true", async () => {
  const s = await startServer(FAKE_HERMES_BIN);
  try {
    const requested = "an-existing-live-session-id";
    const frames = await streamOnce(s.port, s.token, {
      prompt: "continue our earlier conversation",
      providerSession: requested,
    });

    assert.equal(frames.filter((f) => f.event === "error").length, 0);
    assert.equal(frames.filter((f) => f.event === "done").length, 1);

    const sessionFrame = frames.find((f) => f.event === "session");
    assert.ok(sessionFrame);
    const { providerSession, requestedSession, resumed } = sessionFrame.data[0];
    assert.equal(providerSession, requested, "fake-hermes.mjs echoes the resumed id back verbatim");
    assert.equal(requestedSession, requested);
    assert.equal(resumed, true);
  } finally {
    await s.stop();
  }
});

test("no resume requested (fresh conversation, turn 1) -> resumed: true, requestedSession absent (never invented, never sent empty)", async () => {
  const s = await startServer(FAKE_HERMES_BIN);
  try {
    const frames = await streamOnce(s.port, s.token, { prompt: "brand new conversation, no providerSession sent" });

    assert.equal(frames.filter((f) => f.event === "error").length, 0);
    assert.equal(frames.filter((f) => f.event === "done").length, 1);

    const sessionFrame = frames.find((f) => f.event === "session");
    assert.ok(sessionFrame, "fake-hermes.mjs always mints a session id even on turn 1");
    const payload = sessionFrame.data[0];
    assert.equal(payload.resumed, true, "nothing was requested, so there is nothing to have failed to resume");
    assert.equal("requestedSession" in payload, false, "requestedSession must not appear when no resume was asked for");
    assert.equal(typeof payload.providerSession, "string");
    assert.ok(payload.providerSession.length > 0);
  } finally {
    await s.stop();
  }
});

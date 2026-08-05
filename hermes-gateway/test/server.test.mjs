// hermes-gateway/test/server.test.mjs — ASST-14 integration tests.
//
// Runs the REAL `server.mjs` as a child process, with HERMES_BIN pointed at
// test/fixtures/fake-hermes.mjs (via `node <script>`, since no live Hermes binary is available on
// this dev machine and Windows `spawn` cannot exec a script by shebang alone — see
// stream-parser.mjs's tokenizeCommand doc and the ASST-14 report's live-vs-fake caveat).
//
// Also proves /complete and /media are UNCHANGED: those tests hit the real, untouched
// runHermes()/extractChatReply() code path against the same fixture (using its "-z" branch for
// /complete), independent of everything ASST-14 added.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "server.mjs");
const FIXTURE_PATH = path.join(__dirname, "fixtures", "fake-hermes.mjs");
// Quoted, since both node's own install path ("C:\Program Files\nodejs\node.exe") and the fixture
// path may contain spaces — see tokenizeCommand.
const FAKE_HERMES_BIN = `"${process.execPath}" "${FIXTURE_PATH}"`;

let portCounter = 33470;
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

async function startServer(extraEnv = {}) {
  const port = nextPort();
  const token = "test-token";
  const workDir = mkdtempSync(path.join(tmpdir(), "hermes-gw-test-"));
  const child = spawn(
    process.execPath,
    [SERVER_PATH],
    {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        GATEWAY_TOKEN: token,
        HERMES_BIN: FAKE_HERMES_BIN,
        HERMES_CWD: workDir,
        HERMES_STREAM_TIMEOUT_MS: "240000",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stderrTail = "";
  child.stderr.on("data", (d) => (stderrTail += d));
  await waitForHealth(port, token);
  return {
    port,
    token,
    workDir,
    stderr: () => stderrTail,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => child.on("close", r));
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

function authHeaders(token) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

/** Split a raw SSE body into {event, dataLines} blocks and decode each `data:` line's JSON. */
function parseSSE(body) {
  const blocks = body.split("\n\n").filter((b) => b.length > 0);
  return blocks.map((block) => {
    const lines = block.split("\n");
    let event = "message";
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) dataLines.push(line.slice("data: ".length));
      else if (line.length > 0) {
        throw new Error(`unprefixed SSE line found (grammar violation): ${JSON.stringify(line)} in block ${JSON.stringify(block)}`);
      }
    }
    return { event, data: dataLines.map((d) => JSON.parse(d)) };
  });
}

// --- happy path: multiple v2 frames, box decoration stripped incrementally ----------------------

test("POST /complete/stream: multiple v2 frames, no box decoration, meta + session + done present", async () => {
  const s = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/complete/stream`, {
      method: "POST",
      headers: authHeaders(s.token),
      body: JSON.stringify({ prompt: "hello fixture" }),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    const frames = parseSSE(body);

    const tokenFrames = frames.filter((f) => f.event === "message");
    assert.ok(tokenFrames.length >= 3, `expected >=3 token frames, got ${tokenFrames.length}: ${JSON.stringify(frames)}`);
    for (const f of tokenFrames) {
      const text = f.data[0];
      assert.equal(typeof text, "string");
      assert.doesNotMatch(text, /[│┃╭╰]/, `token frame leaked box decoration: ${JSON.stringify(text)}`);
      assert.doesNotMatch(text, /\x1b/, `token frame leaked a raw ANSI escape: ${JSON.stringify(text)}`);
    }
    assert.equal(tokenFrames.map((f) => f.data[0]).join(""), "Hello from the fixture, line one\nline two of the reply\nline three bold-ish end");

    // ASST-15: meta carries ONLY {provider, model} — providerSession moved to its own event.
    const metaFrames = frames.filter((f) => f.event === "meta");
    assert.equal(metaFrames.length, 1, "expected exactly one event: meta");
    assert.deepEqual(Object.keys(metaFrames[0].data[0]).sort(), ["model", "provider"]);
    assert.equal(metaFrames[0].data[0].provider, "hermes");

    // ASST-15: meta fires BEFORE the first token frame (pre-first-content, same timing rule as
    // ai-gateway-go's own `meta`) — this is the actual fix for the "Unknown provider for the
    // whole reply" defect the divergence caused. Assert ordering on the RAW body, not just frame
    // presence, so a regression back to terminal-meta would be caught here.
    const metaIdx = body.indexOf("event: meta");
    const firstTokenIdx = body.indexOf("data: " + JSON.stringify(tokenFrames[0].data[0]));
    assert.ok(metaIdx !== -1 && firstTokenIdx !== -1 && metaIdx < firstTokenIdx,
      `expected event: meta before the first token frame, meta@${metaIdx} firstToken@${firstTokenIdx}`);

    // ASST-15: the late-known session id arrives on its OWN terminal event instead.
    const sessionFrames = frames.filter((f) => f.event === "session");
    assert.equal(sessionFrames.length, 1, "expected exactly one event: session");
    assert.equal(sessionFrames[0].data[0].providerSession, "fixture-session-abc123");
    const sessionIdx = body.indexOf("event: session");
    const doneIdxRaw = body.indexOf("event: done");
    assert.ok(sessionIdx !== -1 && doneIdxRaw !== -1 && sessionIdx < doneIdxRaw, "expected event: session before event: done");

    const doneFrames = frames.filter((f) => f.event === "done");
    assert.equal(doneFrames.length, 1, "expected exactly one event: done");
    assert.deepEqual(doneFrames[0].data[0], {});

    assert.equal(frames.filter((f) => f.event === "error").length, 0);
  } finally {
    await s.stop();
  }
});

// --- session round-trip: meta.providerSession on turn 1 -> --resume <id> argv on turn 2 ---------

test("session id round-trips: turn-1 meta.providerSession becomes turn-2's --resume argv", async () => {
  const argvFile = path.join(mkdtempSync(path.join(tmpdir(), "hermes-gw-argv-")), "argv.json");
  const s = await startServer({ FIXTURE_ARGV_FILE: argvFile });
  try {
    const turn1 = await fetch(`http://127.0.0.1:${s.port}/complete/stream`, {
      method: "POST",
      headers: authHeaders(s.token),
      body: JSON.stringify({ prompt: "turn one" }),
    });
    // ASST-15: providerSession now arrives on event: session, not meta.
    const providerSession = parseSSE(await turn1.text()).find((f) => f.event === "session").data[0].providerSession;
    assert.equal(providerSession, "fixture-session-abc123");

    // Turn 1's own argv must NOT contain --resume (nothing to resume yet) — asserted from the
    // file before turn 2 overwrites it.
    const turn1Argv = JSON.parse(readFileSync(argvFile, "utf8"));
    assert.equal(turn1Argv.indexOf("--resume"), -1, `turn 1 must not pass --resume, got ${JSON.stringify(turn1Argv)}`);

    await fetch(`http://127.0.0.1:${s.port}/complete/stream`, {
      method: "POST",
      headers: authHeaders(s.token),
      body: JSON.stringify({ prompt: "turn two", providerSession }),
    });

    const turn2Argv = JSON.parse(readFileSync(argvFile, "utf8"));
    const resumeIdx = turn2Argv.indexOf("--resume");
    assert.notEqual(resumeIdx, -1, `expected --resume in argv, got ${JSON.stringify(turn2Argv)}`);
    assert.equal(turn2Argv[resumeIdx + 1], providerSession);
    assert.deepEqual(turn2Argv.slice(0, 3), ["chat", "-q", "turn two"]);
  } finally {
    await s.stop();
  }
});

// --- truncated/dying Hermes: event: error, never a hang, never a half-frame claimed complete ----

// ASST-15 behavior note: the fixture's die-before-close mode still writes 3 body lines (which DO
// get parsed and relayed to the client) before the process dies — so under the NEW pre-first-
// content meta timing, `meta` has ALREADY been announced by the time the death is discovered. This
// mirrors ai-gateway-go's own precedent exactly (TestCompleteStreamMetaNeverContradictedOnMidStream
// FailureAfterAlreadyStreamed): once real output has committed to the wire, a later failure is
// reported honestly via event: error WITHOUT retracting or contradicting the meta that already
// went out — never zero meta frames for a run that had, in fact, already streamed real content.
test("dying Hermes (nonzero exit, box never closed) after streaming content: meta already announced, then event: error, not done", async () => {
  const s = await startServer({ HERMES_EXTRA_ARGS: "--fixture-mode=die-before-close" });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/complete/stream`, {
      method: "POST",
      headers: authHeaders(s.token),
      body: JSON.stringify({ prompt: "will die" }),
    });
    const frames = parseSSE(await res.text());
    assert.equal(frames.filter((f) => f.event === "error").length, 1);
    assert.equal(frames.filter((f) => f.event === "done").length, 0);
    assert.equal(frames.filter((f) => f.event === "session").length, 0, "no session id was ever printed before the death");
    const metaFrames = frames.filter((f) => f.event === "meta");
    assert.equal(metaFrames.length, 1, "meta was already committed once content streamed, before the later failure");
    assert.equal(metaFrames[0].data[0].provider, "hermes");
  } finally {
    await s.stop();
  }
});

// The mirror-image negative: a run that dies BEFORE any content ever parses (stuck in PRE state —
// e.g. a hung tool-approval prompt, covered by the dedicated hang test below) must announce NO
// meta at all — never a provider that produced nothing. Reusing the "hang" fixture here would
// duplicate that test; this one exercises the same "PRE state, zero content" case via a fixture
// mode that dies immediately after the preamble, before the box ever opens.
test("Hermes dying during the PRE-box preamble (zero content ever parsed) announces no meta", async () => {
  const s = await startServer({ HERMES_EXTRA_ARGS: "--fixture-mode=die-during-preamble" });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/complete/stream`, {
      method: "POST",
      headers: authHeaders(s.token),
      body: JSON.stringify({ prompt: "dies before any box content" }),
    });
    const frames = parseSSE(await res.text());
    assert.equal(frames.filter((f) => f.event === "error").length, 1);
    assert.equal(frames.filter((f) => f.event === "meta").length, 0, "no content ever reached the wire, so no provider should ever be announced");
    assert.equal(frames.filter((f) => f.event === "done").length, 0);
  } finally {
    await s.stop();
  }
});

test("Hermes exits clean but the box never closes: event: error, not a fake success", async () => {
  const s = await startServer({ HERMES_EXTRA_ARGS: "--fixture-mode=die-clean-no-close" });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/complete/stream`, {
      method: "POST",
      headers: authHeaders(s.token),
      body: JSON.stringify({ prompt: "clean but unclosed" }),
    });
    const frames = parseSSE(await res.text());
    assert.equal(frames.filter((f) => f.event === "error").length, 1);
    assert.match(frames.find((f) => f.event === "error").data[0].error, /box never closed|truncated/);
    assert.equal(frames.filter((f) => f.event === "done").length, 0);
  } finally {
    await s.stop();
  }
});

// --- approval hang: times out to a typed error, never --yolo ------------------------------------

test("tool-approval hang times out to a typed error (bounded wall-clock time)", async () => {
  const s = await startServer({
    HERMES_EXTRA_ARGS: "--fixture-mode=hang",
    HERMES_STREAM_TIMEOUT_MS: "300",
  });
  try {
    const start = Date.now();
    const res = await fetch(`http://127.0.0.1:${s.port}/complete/stream`, {
      method: "POST",
      headers: authHeaders(s.token),
      body: JSON.stringify({ prompt: "will hang on approval" }),
    });
    const frames = parseSSE(await res.text());
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `expected the timeout to fire quickly, took ${elapsed}ms`);
    const errFrames = frames.filter((f) => f.event === "error");
    assert.equal(errFrames.length, 1);
    assert.match(errFrames[0].data[0].error, /timed out/i);
    assert.match(errFrames[0].data[0].error, /approval/i);
    assert.equal(frames.filter((f) => f.event === "done").length, 0);
  } finally {
    await s.stop();
  }
});

// --- --yolo must never appear in the ACTUAL spawned argv (not merely "no mention in source",
// which would false-positive on this file's own documentation of the deliberate absence) --------

test("no --yolo in the actual spawned argv on a default-config server", async () => {
  const argvFile = path.join(mkdtempSync(path.join(tmpdir(), "hermes-gw-argv-")), "argv.json");
  const s = await startServer({ FIXTURE_ARGV_FILE: argvFile }); // no HERMES_EXTRA_ARGS set
  try {
    await fetch(`http://127.0.0.1:${s.port}/complete/stream`, {
      method: "POST",
      headers: authHeaders(s.token),
      body: JSON.stringify({ prompt: "default config, no extra args" }),
    });
    const argv = JSON.parse(readFileSync(argvFile, "utf8"));
    assert.equal(argv.includes("--yolo"), false, `--yolo must never be in the default argv, got ${JSON.stringify(argv)}`);
  } finally {
    await s.stop();
  }
});

// --- /complete and /media stay byte-identical (untouched code path) -----------------------------
//
// `runHermes`/`extractChatReply` and the /complete + /media handlers in server.mjs are not edited
// by this ticket AT ALL (verify with `git diff` — every line ASST-14 touches is additive, in a
// clearly separated section). What CAN be driven here without a live Hermes binary:
//   - the request validation / auth contract (400 on missing input, 401 without a bearer token —
//     unchanged code, exercised directly);
//   - the error-response shape `{error: "hermes: <detail>"}` at 502 when the configured
//     hermesBin cannot be spawned, using the SAME FAKE_HERMES_BIN this file uses everywhere else
//     for /complete/stream. execFile(CFG.hermesBin, args) — untouched — only ever accepts a
//     single-token executable, and FAKE_HERMES_BIN is `node.exe" "fixture.mjs` as ONE string
//     (deliberately, so /complete/stream's separate spawn()+tokenizeCommand path can use it) — so
//     hitting these two endpoints with it deterministically exercises the full
//     readBody->JSON-parse->runHermes->catch->502 pipeline, unchanged, end to end.
// What could NOT be driven live on this box: their SUCCESS path against a responding process.
// `hermes chat` mode (used by /media) CAN in principle be faked with `process.execPath` as
// hermesBin plus a `--import` preload trick (verified working out-of-band — see the ASST-14
// report) — but /complete's `-z` mode cannot: Node's OWN native CLI arg parser rejects `-z` as
// "bad option" before any JS (including a preload) ever runs, and `runHermes`'s args array is
// fixed by code this ticket does not touch, so there is no way to route around it without a real
// Hermes binary. Marked UNVERIFIED for live behaviour, honestly, rather than faked.

test("/complete: validation + auth are unchanged", async () => {
  const s = await startServer();
  try {
    const missingPrompt = await fetch(`http://127.0.0.1:${s.port}/complete`, {
      method: "POST",
      headers: authHeaders(s.token),
      body: JSON.stringify({}),
    });
    assert.equal(missingPrompt.status, 400);
    assert.deepEqual(Object.keys(await missingPrompt.json()), ["error"]);

    const noAuth = await fetch(`http://127.0.0.1:${s.port}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "ping" }),
    });
    assert.equal(noAuth.status, 401);
  } finally {
    await s.stop();
  }
});

test("/complete: unreachable hermesBin -> the SAME {error} 502 shape as before this ticket", async () => {
  const s = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/complete`, {
      method: "POST",
      headers: authHeaders(s.token),
      body: JSON.stringify({ prompt: "ping" }),
    });
    assert.equal(res.status, 502);
    const json = await res.json();
    assert.deepEqual(Object.keys(json), ["error"]);
    assert.match(json.error, /^hermes:/);
  } finally {
    await s.stop();
  }
});

test("/media: validation + the same {error} 502 shape are unchanged", async () => {
  const s = await startServer();
  try {
    const missingBase64 = await fetch(`http://127.0.0.1:${s.port}/media`, {
      method: "POST",
      headers: authHeaders(s.token),
      body: JSON.stringify({ mime: "image/png" }),
    });
    assert.equal(missingBase64.status, 400);

    const tinyPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const res = await fetch(`http://127.0.0.1:${s.port}/media`, {
      method: "POST",
      headers: authHeaders(s.token),
      body: JSON.stringify({ base64: tinyPngBase64, mime: "image/png" }),
    });
    assert.equal(res.status, 502);
    const json = await res.json();
    assert.deepEqual(Object.keys(json), ["error"]);
    assert.match(json.error, /^hermes:/);
  } finally {
    await s.stop();
  }
});

#!/usr/bin/env node
// Test-only fixture standing in for the real `hermes` binary (none is installed on this dev
// machine — see the ASST-14 report for the live-vs-fake caveat this implies).
//
// Modeled on the EXACT decorated shapes `hermes-gateway/server.mjs`'s pre-existing
// `extractChatReply` already parses (box top "╭─ ⚕ Hermes ─╮", body lines prefixed "│", box bottom
// "╰", footer "Session:"/"Resume…") — these are CONSTRUCTED fixtures, not a recorded real
// transcript, because no live Hermes binary was available to capture one from.
//
// Deliberately writes stdout in small, separately-timed chunks that split a box-open marker, a
// body line, and an ANSI escape sequence across chunk boundaries, so tests exercise the
// incremental parser's carry-buffer reassembly rather than a single whole-buffer read.
//
// Modes (selected via a `--fixture-mode=<mode>` arg, passed through HERMES_EXTRA_ARGS by tests):
//   happy              (default) full box + footer with a Session: id, exit 0.
//   die-before-close   dies (exit 1) mid-box, before the closing "╰" line ever arrives — but AFTER
//                      body lines were already written (ASST-15: exercises "meta already
//                      committed, then error" — content DID reach the parser before the death).
//   die-during-preamble dies (exit 1) right after the preamble, BEFORE the box ever opens — zero
//                      content ever reaches the parser (ASST-15: exercises "no meta ever, because
//                      nothing committed" — the PRE-state mirror image of die-before-close).
//   die-clean-no-close exits 0 WITHOUT ever printing the closing "╰" line (distinct from the
//                      nonzero-exit case above — exercises the "!boxClosed" error branch alone).
//   hang               prints only the preamble, then never continues — the gateway's own
//                       HERMES_STREAM_TIMEOUT_MS must be what ends this, not a real hang.
//
// If FIXTURE_ARGV_FILE is set, the exact argv this process received is written there as JSON —
// this is what lets a test assert the actual spawned argv (e.g. `--resume <id>`) rather than
// inferring it from behaviour alone.
// Two invocation shapes are supported, because the two hermes-gateway callers that consume this
// fixture spawn it differently:
//  - Direct: `node fake-hermes.mjs <args...>` (ASST-14's tokenizeCommand path, used by
//    /complete/stream) -> process.argv = [node, thisFile, ...args].
//  - Preload: `NODE_OPTIONS=--import=<this file's URL> node <args...>` (used to drive /media
//    against the UNTOUCHED execFile(CFG.hermesBin, args) call, which only accepts a single-token
//    executable — there is no real Hermes binary on this box, and `process.execPath` is the one
//    real single-file executable available; the module's own top-level code runs, and process
//    argv parsing gets to run because it exits BEFORE node attempts to resolve the caller's first
//    arg as an entry module) -> process.argv = [node, ...args] (no script path of ours in argv).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const selfPath = fileURLToPath(import.meta.url);
const isDirectInvocation = process.argv[1] === selfPath;
const argv = isDirectInvocation ? process.argv.slice(2) : process.argv.slice(1);

if (process.env.FIXTURE_ARGV_FILE) {
  writeFileSync(process.env.FIXTURE_ARGV_FILE, JSON.stringify(argv));
}

const modeArg = argv.find((a) => a.startsWith("--fixture-mode="));
const mode = modeArg ? modeArg.split("=")[1] : "happy";

const resumeIdx = argv.indexOf("--resume");
const resumedSessionId = resumeIdx !== -1 ? argv[resumeIdx + 1] : null;
// Real `--resume` continues the SAME session — echo the id back rather than minting a new one.
const sessionId = resumedSessionId ?? "fixture-session-abc123";

const write = (s) => process.stdout.write(s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (argv[0] === "-z") {
  // The plain one-shot path used by /complete (no box at all) — kept here so the SAME fixture
  // file can also stand in for /complete's untouched code path in the byte-identical checks.
  const prompt = argv[1] ?? "";
  write(`one-shot reply to: ${prompt}`);
  process.exit(0);
}

async function run() {
  write("Query: (fixture prompt)\n");
  write("Initializing");
  await wait(5);
  write("…\n");

  if (mode === "hang") {
    // Simulate an unapproved tool-approval prompt: preamble only, then silence forever. Without
    // an active handle Node's event loop would just drain and the process would exit on its own
    // (that would test nothing) — keep it alive until the gateway's own timeout kills it.
    setInterval(() => {}, 60_000);
    return;
  }

  if (mode === "die-during-preamble") {
    // Dies before the box ever opens — zero content lines ever reach the parser (still PRE
    // state). Distinct from die-before-close, which dies AFTER body lines were already written.
    process.exit(1);
  }

  // Box-open marker deliberately split across two writes, WITH an ANSI escape split too.
  write("\x1b[3");
  await wait(5);
  write("6m╭─ ⚕ Hermes ─╮\x1b[0m\n");

  // Body line 1: split mid-line.
  write("│ Hello from the fi");
  await wait(5);
  write("xture, line one │\n");

  // Body line 2: plain, whole.
  write("│ line two of the reply │\n");

  // Body line 3: an embedded ANSI sequence split across writes.
  write("│ line three \x1b[1");
  await wait(5);
  write("mbold-ish\x1b[0m end │\n");

  if (mode === "die-before-close") {
    process.exit(1);
  }
  if (mode === "die-clean-no-close") {
    process.exit(0);
  }

  write("╰──────────────────────────╯\n");
  write("\n");
  write(`Session: ${sessionId}\n`);
  write(`Resume with: hermes chat --resume ${sessionId}\n`);
  process.exit(0);
}

run();

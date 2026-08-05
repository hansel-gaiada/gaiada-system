// hermes-gateway/test/parser.test.mjs — ASST-14 unit tests for the incremental box parser.
//
// Fixtures here are CONSTRUCTED from the exact decorated shapes `extractChatReply` in
// hermes-gateway/server.mjs already parses (box top/bottom glyphs, "│" body borders, a
// "Session:" footer line) — not a recorded real Hermes transcript, because no live `hermes`
// binary is available on this dev machine (see the ASST-14 report).
import test from "node:test";
import assert from "node:assert/strict";
import {
  HermesBoxStreamParser,
  tokenizeCommand,
  buildHermesChatStreamArgs,
} from "../stream-parser.mjs";

const HAPPY_TRANSCRIPT =
  "Query: (fixture prompt)\n" +
  "Initializing" +
  "…\n" +
  "\x1b[36m╭─ ⚕ Hermes ─╮\x1b[0m\n" +
  "│ Hello from the fixture, line one │\n" +
  "│ line two of the reply │\n" +
  "│ line three \x1b[1mbold-ish\x1b[0m end │\n" +
  "╰──────────────────────────╯\n" +
  "\n" +
  "Session: fixture-session-abc123\n" +
  "Resume with: hermes chat --resume fixture-session-abc123\n";

const EXPECTED_TEXT = "Hello from the fixture, line one\nline two of the reply\nline three bold-ish end";

function collect(feedFn) {
  const tokens = [];
  const parser = new HermesBoxStreamParser((piece) => tokens.push(piece));
  feedFn(parser);
  parser.end();
  return { tokens, parser };
}

function assertNoDecoration(tokens) {
  for (const t of tokens) {
    assert.doesNotMatch(t, /[│┃╭╰]/, `token leaked a box glyph: ${JSON.stringify(t)}`);
    assert.doesNotMatch(t, /\x1b/, `token leaked a raw ANSI escape: ${JSON.stringify(t)}`);
  }
}

test("happy path fed as one whole chunk: content emitted, box closed, session captured", () => {
  const { tokens, parser } = collect((p) => p.feed(HAPPY_TRANSCRIPT));
  assert.ok(tokens.length >= 3, `expected >=3 token frames, got ${tokens.length}: ${JSON.stringify(tokens)}`);
  assertNoDecoration(tokens);
  assert.equal(tokens.join(""), EXPECTED_TEXT);
  assert.equal(parser.boxClosed, true);
  assert.equal(parser.sessionId, "fixture-session-abc123");
});

test("happy path fed one character at a time: identical result (chunk-boundary independence)", () => {
  const { tokens, parser } = collect((p) => {
    for (const ch of HAPPY_TRANSCRIPT) p.feed(ch);
  });
  assert.ok(tokens.length >= 3, `expected >=3 token frames, got ${tokens.length}`);
  assertNoDecoration(tokens);
  assert.equal(tokens.join(""), EXPECTED_TEXT);
  assert.equal(parser.boxClosed, true);
  assert.equal(parser.sessionId, "fixture-session-abc123");
});

test("box-open marker split exactly at the ANSI escape boundary is still recognized", () => {
  // Split "\x1b[36m╭─ ⚕ Hermes ─╮\x1b[0m\n" into two feeds, mid-escape, mid-glyph — the worst
  // case a chunk boundary can produce.
  const { tokens, parser } = collect((p) => {
    p.feed("Query: x\n");
    p.feed("\x1b[3");
    p.feed("6m╭─ ⚕ Herm");
    p.feed("es ─╮\x1b[0m\n");
    p.feed("│ only line │\n");
    p.feed("╰───╯\n");
  });
  assert.equal(tokens.join(""), "only line");
  assertNoDecoration(tokens);
  assert.equal(parser.boxClosed, true);
});

test("truncated stream (no closing box marker, process died) never claims success", () => {
  const { tokens, parser } = collect((p) => {
    p.feed(HAPPY_TRANSCRIPT.split("╰")[0]); // everything up to (not including) the closing marker
  });
  // Content that DID stream before the death is still delivered — that part is real...
  assert.ok(tokens.length >= 3, `expected the pre-death content to still have streamed, got ${tokens.length}`);
  assertNoDecoration(tokens);
  // ...but the box never closed, so the caller must treat this as an error, never a completion.
  assert.equal(parser.boxClosed, false);
  assert.equal(parser.sessionId, null);
});

test("box never opens at all (no Hermes marker seen): no content emitted, not closed", () => {
  const { tokens, parser } = collect((p) => {
    p.feed("Query: x\nInitializing…\nsomething went wrong, no box at all\n");
  });
  assert.equal(tokens.length, 0);
  assert.equal(parser.boxClosed, false);
});

test("a lone unterminated ANSI escape at end-of-stream is stripped, never leaked", () => {
  const { tokens } = collect((p) => {
    p.feed("Query: x\n\x1b[36m╭─ ⚕ Hermes ─╮\x1b[0m\n│ partial line cut off mid-escape \x1b[1");
    // no more data ever arrives — end() must flush this trailing carry without leaking the ESC.
  });
  for (const t of tokens) assert.doesNotMatch(t, /\x1b/);
});

// --- tokenizeCommand ------------------------------------------------------------------------

test("tokenizeCommand: bare single token (the production default) is unaffected", () => {
  assert.deepEqual(tokenizeCommand("hermes"), ["hermes"]);
});

test("tokenizeCommand: quoted multi-token command line, tokens may contain spaces", () => {
  assert.deepEqual(
    tokenizeCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\path with space\\fixture.mjs"'),
    ["C:\\Program Files\\nodejs\\node.exe", "C:\\path with space\\fixture.mjs"]
  );
});

// --- buildHermesChatStreamArgs --------------------------------------------------------------

test("buildHermesChatStreamArgs: turn 1 (no providerSession) has no --resume", () => {
  const args = buildHermesChatStreamArgs({ prompt: "hi there" });
  assert.deepEqual(args, ["chat", "-q", "hi there"]);
});

test("buildHermesChatStreamArgs: turn 2 (providerSession given) inserts --resume <id>", () => {
  const args = buildHermesChatStreamArgs({ prompt: "hi again", providerSession: "sess-42" });
  assert.deepEqual(args, ["chat", "-q", "hi again", "--resume", "sess-42"]);
});

test("buildHermesChatStreamArgs: modelArgs/extraArgs are appended after the resume pair", () => {
  const args = buildHermesChatStreamArgs({
    prompt: "p",
    providerSession: "s1",
    modelArgs: ["-m", "gemma-mm"],
    extraArgs: ["--fixture-mode=happy"],
  });
  assert.deepEqual(args, ["chat", "-q", "p", "--resume", "s1", "-m", "gemma-mm", "--fixture-mode=happy"]);
});

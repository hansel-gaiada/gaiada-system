// hermes-gateway — a drop-in AI Gateway that uses the local Hermes agent as the brain.
//
// It speaks the exact HTTP contract the wa-chat-bot expects from its Gateway
// (see wa-chat-bot/src/llm.ts): POST /complete {prompt}->{text} and
// POST /media {base64,mime}->{text}. Point the bot's GATEWAY_URL at this and the
// bot's whole AI surface (Q&A, /summarize, digests, LLM intent) runs on Hermes —
// local ollama + Hermes' full tools/skills/memory — with zero bot code changes.
//
// Backend (/complete, /media): spawns `hermes -z <prompt>` or `hermes chat -q <prompt> --image
// <path>` per request (one-shot agent run), buffers stdout, and parses it in one shot afterward
// (`runHermes`/`extractChatReply`). Tool/progress noise goes to stderr and is discarded.
//
// Backend (/complete/stream, ASST-14): a SEPARATE streaming path — `spawn` instead of buffered
// `execFile`, stdout parsed incrementally line-by-line through stream-parser.mjs's
// HermesBoxStreamParser as it arrives, and the Hermes `Session:` id captured + round-tripped via
// `providerSession` (`--resume`) so an ERP thread and a Hermes session stay one conversation.
// /complete and /media are untouched by this — see the long comment above handleCompleteStream.
//
// Zero runtime dependencies (Node built-ins only).

import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HermesBoxStreamParser, tokenizeCommand, buildHermesChatStreamArgs } from "./stream-parser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CFG = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? process.env.GATEWAY_PORT ?? 3002),
  // Must match the bot's GATEWAY_TOKEN. Empty disables auth (dev only).
  token: process.env.GATEWAY_TOKEN ?? "",
  hermesBin: process.env.HERMES_BIN ?? "hermes",
  // UNSET means "use whatever Hermes itself is configured for" — the shim omits -m/--provider
  // entirely rather than guessing. On a box where Hermes runs deepseek with a Gemini fallback,
  // forcing a local ollama model here would both pick a model that isn't installed AND defeat
  // the operator's fallback chain. Set these only to deliberately override Hermes.
  model: process.env.HERMES_MODEL ?? "",
  provider: process.env.HERMES_PROVIDER ?? "",
  timeoutMs: Number(process.env.HERMES_TIMEOUT_MS ?? 240_000),
  // Vision/media runs are much slower on the iGPU (observed ~4-5 min for a first image).
  mediaTimeoutMs: Number(process.env.HERMES_MEDIA_TIMEOUT_MS ?? 600_000),
  // /complete/stream (ASST-14) uses `hermes chat` like /media's image path, but for TEXT — no
  // vision cost — so it defaults to the text timeout, not the media one. This is also the timeout
  // that catches a hung tool-approval prompt (headless Hermes cannot approve; see extraArgs below):
  // the child is killed and the client gets a typed `event: error`, never an open-ended hang.
  streamTimeoutMs: Number(process.env.HERMES_STREAM_TIMEOUT_MS ?? process.env.HERMES_TIMEOUT_MS ?? 240_000),
  // Agent working dir — isolates any file/terminal tool use away from the repo.
  cwd: process.env.HERMES_CWD ?? path.join(__dirname, "work"),
  // Extra hermes flags. EMPTY by default: the brain answers with text and tool/hook
  // approvals stay ON, so a headless run can never auto-execute tools. If you knowingly
  // want autonomous tool use in this trial, set HERMES_EXTRA_ARGS=--yolo yourself (your
  // call, your risk) — a tool the agent can't get approved just times out to a 502.
  extraArgs: (process.env.HERMES_EXTRA_ARGS ?? "").split(/\s+/).filter(Boolean),
  maxBuffer: Number(process.env.HERMES_MAX_BUFFER ?? 12 * 1024 * 1024),
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES ?? 32 * 1024 * 1024),
};

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const clean = (s) => s.replace(ANSI, "").trim();

/** `hermes chat` prints a decorated transcript: a "╭─ ⚕ Hermes ─╮" box holds the reply,
 *  wrapped by a "Query:"/"Initializing…" preamble and a "Session:"/"Resume…" footer.
 *  Pull the boxed reply out; fall back to the raw cleaned text if the box isn't found. */
function extractChatReply(stdout) {
  const lines = clean(stdout).split(/\r?\n/);
  const top = lines.findIndex((l) => /^\s*╭.*Hermes/.test(l));
  if (top === -1) return clean(stdout);
  const rest = lines.slice(top + 1);
  const bottom = rest.findIndex((l) => /^\s*╰/.test(l));
  const inner = (bottom === -1 ? rest : rest.slice(0, bottom))
    .map((l) => l.replace(/^\s*[│┃]?\s?/, "").replace(/\s*[│┃]\s*$/, "").trimEnd());
  return inner.join("\n").trim();
}

const extForMime = (mime = "") => {
  const m = mime.toLowerCase().split(";")[0].trim();
  return (
    {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
      "application/pdf": "pdf",
      "audio/ogg": "ogg",
      "audio/mpeg": "mp3",
      "audio/mp4": "m4a",
      "audio/wav": "wav",
      "video/mp4": "mp4",
    }[m] ?? "bin"
  );
};

/** Run one Hermes agent turn; resolve with its final text (stdout).
 *  Text prompts go through the global one-shot `-z`; when an image is given we use
 *  `hermes chat -q <prompt> --image <path>` (the only invocation that attaches an image). */
function runHermes(prompt, image) {
  // Image input requires `hermes chat --image` (decorated output, slower); text uses `-z` (clean).
  const isChat = Boolean(image);
  // Only pass -m/--provider when explicitly configured; otherwise Hermes uses its own default
  // (and its own fallback chain), which is what we want when someone else owns that config.
  const modelArgs = [
    ...(CFG.model ? ["-m", CFG.model] : []),
    ...(CFG.provider ? ["--provider", CFG.provider] : []),
  ];
  const args = isChat
    ? ["chat", "-q", prompt, "--image", image, ...modelArgs, ...CFG.extraArgs]
    : ["-z", prompt, ...modelArgs, ...CFG.extraArgs];
  const timeout = isChat ? CFG.mediaTimeoutMs : CFG.timeoutMs;
  return new Promise((resolve, reject) => {
    execFile(
      CFG.hermesBin,
      args,
      { cwd: CFG.cwd, timeout, maxBuffer: CFG.maxBuffer, windowsHide: true },
      (err, stdout, stderr) => {
        const text = isChat ? extractChatReply(stdout ?? "") : clean(stdout ?? "");
        if (err) {
          // Timeout or non-zero exit. Surface stderr tail for debugging.
          const detail = clean(stderr ?? "").slice(-300) || err.message;
          return reject(new Error(detail));
        }
        resolve(text);
      }
    );
  });
}

// --- ASST-14: POST /complete/stream — streamed spawn + incremental box parser -------------------
//
// `runHermes`/`extractChatReply` above are UNTOUCHED: /complete and /media still buffer via
// `execFile` and parse the whole reply in one shot after the process exits. This is a deliberately
// separate code path (spawn + HermesBoxStreamParser from ./stream-parser.mjs) so nothing here can
// change /complete or /media's behaviour by accident.
//
// Wire grammar v2 (ASST-10/11), matching ai-gateway-go/internal/server/server.go's
// writeSSEData/writeSSEMeta/writeSSEError/writeSSEDone byte-for-byte: every `data:` line is exactly
// one line of JSON. Token frames are the default (unnamed) SSE event, data = the JSON string of
// the piece. `event: meta` carries {provider:"hermes", model, providerSession?}. `event: error`
// carries {"error": string}. `event: done` (data "{}" ) is the ONLY clean-completion terminal —
// absent on every error path, so a consumer can always tell a clean end from a dropped connection.
//
// Deliberate timing deviation from ai-gateway-go's `meta` (documented, not an oversight): that
// gateway emits `meta` BEFORE the first token, because its concern is which failover survivor
// committed bytes to the wire. This shim has no failover and its `providerSession` is a genuinely
// TERMINAL fact — Hermes only prints "Session:" in the footer, after the box closes — so `meta`
// here is emitted once, right before `done`, carrying the session id this turn just established
// (or resumed). A future ai-gateway-go "hermes" provider (ASST-15) re-times this at the relay layer
// however ASST-11 requires; this file's job is only to make the fact (the session id) available.
function writeSSEData(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function writeSSEMeta(res, meta) {
  res.write(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`);
}
function writeSSEError(res, message) {
  res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
}
function writeSSEDone(res) {
  res.write(`event: done\ndata: {}\n\n`);
}

/** Split CFG.hermesBin into {cmd, prefixArgs} — see tokenizeCommand's doc comment. For the
 *  production default ("hermes") this is just {cmd:"hermes", prefixArgs:[]}, identical to how
 *  execFile(CFG.hermesBin, args) already treats it above. */
function resolveHermesCommand() {
  const tokens = tokenizeCommand(CFG.hermesBin);
  return { cmd: tokens[0], prefixArgs: tokens.slice(1) };
}

/** POST /complete/stream — {prompt, providerSession?} -> SSE. `providerSession`, when given, is
 *  passed to Hermes as `--resume <id>` so an ERP thread and a Hermes session stay the same
 *  conversation across turns (this is what makes `meta.providerSession` meaningful). Approvals
 *  stay ON (no --yolo, ever) — an unapproved tool hangs Hermes, which this endpoint turns into a
 *  typed `event: error` via CFG.streamTimeoutMs rather than an open-ended hang. */
function handleCompleteStream(req, res, payload) {
  const prompt = String(payload.prompt ?? "");
  const providerSession = payload.providerSession ? String(payload.providerSession) : "";
  if (!prompt) return send(res, 400, { error: "missing prompt" });

  const modelArgs = [
    ...(CFG.model ? ["-m", CFG.model] : []),
    ...(CFG.provider ? ["--provider", CFG.provider] : []),
  ];
  const args = buildHermesChatStreamArgs({ prompt, providerSession, modelArgs, extraArgs: CFG.extraArgs });
  const { cmd, prefixArgs } = resolveHermesCommand();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const t0 = Date.now();
  let settled = false;
  let timedOut = false;
  let stderrTail = "";

  const parser = new HermesBoxStreamParser((piece) => writeSSEData(res, piece));

  const child = spawn(cmd, [...prefixArgs, ...args], { cwd: CFG.cwd, windowsHide: true });

  const killTimer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    // Belt-and-suspenders: some tool-approval hangs may swallow SIGTERM. Force it after a grace
    // period so a stuck Hermes can never keep this response (or the process) open indefinitely.
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 2000);
  }, CFG.streamTimeoutMs);

  child.on("error", (err) => finish(null, err));
  child.on("close", (code) => finish(code, null));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (!settled) parser.feed(chunk);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d).slice(-2000);
  });

  req.on("close", () => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  });

  function finish(exitCode, spawnErr) {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    parser.end();
    const elapsed = Date.now() - t0;

    if (spawnErr) {
      console.error(`[complete/stream] FAILED ${elapsed}ms spawn error:`, spawnErr.message);
      writeSSEError(res, `hermes: ${spawnErr.message}`);
      return res.end();
    }
    if (timedOut) {
      const detail = clean(stderrTail).slice(-300);
      console.error(`[complete/stream] TIMEOUT ${elapsed}ms`, detail || "(no stderr)");
      writeSSEError(
        res,
        `hermes: timed out after ${CFG.streamTimeoutMs}ms without completing ` +
          `(a pending tool-approval prompt is the most likely cause — headless Hermes cannot ` +
          `approve, and --yolo is intentionally never set)`
      );
      return res.end();
    }
    if (exitCode !== 0) {
      const detail = clean(stderrTail).slice(-300) || `hermes exited with code ${exitCode}`;
      console.error(`[complete/stream] FAILED ${elapsed}ms exit=${exitCode}:`, detail);
      writeSSEError(res, `hermes: ${detail}`);
      return res.end();
    }
    if (!parser.boxClosed) {
      console.error(`[complete/stream] FAILED ${elapsed}ms: hermes exited cleanly but the reply box never closed`);
      writeSSEError(res, "hermes: stream ended before the reply box closed (truncated output)");
      return res.end();
    }

    console.log(`[complete/stream] ${elapsed}ms session=${parser.sessionId ?? "<none>"}`);
    writeSSEMeta(res, {
      provider: "hermes",
      model: CFG.model || "",
      ...(parser.sessionId ? { providerSession: parser.sessionId } : {}),
    });
    writeSSEDone(res);
    res.end();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > CFG.maxBodyBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
};

function authed(req) {
  if (!CFG.token) return true;
  const h = req.headers["authorization"] ?? "";
  return h === `Bearer ${CFG.token}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, brain: "hermes", model: CFG.model, provider: CFG.provider });
  }

  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  if (!authed(req)) return send(res, 401, { error: "unauthorized" });

  let payload;
  try {
    const raw = await readBody(req);
    payload = raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch (e) {
    return send(res, 400, { error: `bad request: ${e.message}` });
  }

  // --- /complete : text prompt -> text ---
  if (url.pathname === "/complete") {
    const prompt = String(payload.prompt ?? "");
    if (!prompt) return send(res, 400, { error: "missing prompt" });
    const t0 = Date.now();
    try {
      const text = await runHermes(prompt);
      console.log(`[complete] ${Date.now() - t0}ms  ${text.length} chars`);
      return send(res, 200, { text });
    } catch (e) {
      console.error(`[complete] FAILED ${Date.now() - t0}ms:`, e.message);
      return send(res, 502, { error: `hermes: ${e.message}` });
    }
  }

  // --- /complete/stream : text prompt (+ optional providerSession) -> SSE (ASST-14) ---
  if (url.pathname === "/complete/stream") {
    return handleCompleteStream(req, res, payload);
  }

  // --- /media : base64 + mime -> description text ---
  if (url.pathname === "/media") {
    const b64 = String(payload.base64 ?? "");
    const mime = String(payload.mime ?? "");
    if (!b64) return send(res, 400, { error: "missing base64" });
    let tmp;
    const t0 = Date.now();
    try {
      await mkdir(CFG.cwd, { recursive: true });
      const ext = extForMime(mime);
      const isImage = mime.toLowerCase().startsWith("image/");
      tmp = path.join(CFG.cwd, `media-${randomUUID()}.${ext}`);
      await writeFile(tmp, Buffer.from(b64, "base64"));
      const prompt =
        `Describe this ${mime || "media"} in detail. ` +
        `Transcribe any spoken or visible text verbatim. Respond with only the description, no preamble.`;
      // Images attach via `chat --image`; non-image media (audio/pdf) is referenced by path
      // so Hermes' file/transcription tools can open it.
      const text = isImage
        ? await runHermes(prompt, tmp)
        : await runHermes(`${prompt} The file is at "${tmp}".`);
      console.log(`[media] ${mime} ${Date.now() - t0}ms  ${text.length} chars`);
      if (!text) return send(res, 502, { error: "hermes returned no text" });
      return send(res, 200, { text });
    } catch (e) {
      console.error(`[media] FAILED ${Date.now() - t0}ms:`, e.message);
      return send(res, 502, { error: `hermes: ${e.message}` });
    } finally {
      if (tmp) await unlink(tmp).catch(() => {});
    }
  }

  return send(res, 404, { error: "not found" });
});

await mkdir(CFG.cwd, { recursive: true });
server.listen(CFG.port, CFG.host, () => {
  console.log(
    `hermes-gateway listening on http://${CFG.host}:${CFG.port}  ` +
      `(brain=hermes model=${CFG.model || "<hermes default>"} ` +
      `provider=${CFG.provider || "<hermes default>"} auth=${CFG.token ? "on" : "off"})`
  );
  console.log(`  agent cwd: ${CFG.cwd}`);
});

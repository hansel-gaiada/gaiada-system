// hermes-gateway — a drop-in AI Gateway that uses the local Hermes agent as the brain.
//
// It speaks the exact HTTP contract the wa-chat-bot expects from its Gateway
// (see wa-chat-bot/src/llm.ts): POST /complete {prompt}->{text} and
// POST /media {base64,mime}->{text}. Point the bot's GATEWAY_URL at this and the
// bot's whole AI surface (Q&A, /summarize, digests, LLM intent) runs on Hermes —
// local ollama + Hermes' full tools/skills/memory — with zero bot code changes.
//
// Backend: spawns `hermes -z <prompt>` per request (one-shot agent run). Stdout is
// the final assistant message; tool/progress noise goes to stderr and is discarded.
//
// Zero runtime dependencies (Node built-ins only).

import http from "node:http";
import { execFile } from "node:child_process";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CFG = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? process.env.GATEWAY_PORT ?? 3002),
  // Must match the bot's GATEWAY_TOKEN. Empty disables auth (dev only).
  token: process.env.GATEWAY_TOKEN ?? "",
  hermesBin: process.env.HERMES_BIN ?? "hermes",
  model: process.env.HERMES_MODEL ?? "gemma-mm",
  provider: process.env.HERMES_PROVIDER ?? "ollama",
  timeoutMs: Number(process.env.HERMES_TIMEOUT_MS ?? 240_000),
  // Vision/media runs are much slower on the iGPU (observed ~4-5 min for a first image).
  mediaTimeoutMs: Number(process.env.HERMES_MEDIA_TIMEOUT_MS ?? 600_000),
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
  const args = isChat
    ? ["chat", "-q", prompt, "--image", image, "-m", CFG.model, "--provider", CFG.provider, ...CFG.extraArgs]
    : ["-z", prompt, "-m", CFG.model, "--provider", CFG.provider, ...CFG.extraArgs];
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
      `(brain=hermes model=${CFG.model} provider=${CFG.provider} auth=${CFG.token ? "on" : "off"})`
  );
  console.log(`  agent cwd: ${CFG.cwd}`);
});

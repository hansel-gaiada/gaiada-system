// The HTTP surface. Three routes, no framework — the estate's UI has held four runtime
// dependencies through several large programmes, and a service that executes untrusted code is the
// last place to add a dependency tree nobody has read.
//
// Contract (blueprint §5.2):
//   POST /runs      { challengeId, image, files[], command?, limits?, gradingSpec } -> { runId }
//   GET  /runs/:id                                                                  -> the result
//   GET  /health                                                                    -> posture
//
// ⚠ NO ERP NETWORK PATH, NO IDENTITY, NO DATABASE. This service never learns who a learner is and
//   never reaches Postgres. It takes files and a grading spec and returns a graded result; the
//   platform owns everything else. That is what keeps a compromise here from being a compromise of
//   the ERP.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { LabQueue, QueueFullError } from "./queue.js";
import { dockerAvailable, type RunRequest } from "./runner.js";

const queue = new LabQueue();

/** Constant-time compare. A byte-by-byte `===` on a shared secret is a timing oracle. */
function tokenOk(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(config.token);
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Read a bounded body. An unbounded read is how a service with a memory limit gets OOM-killed. */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Shape-check the submission.
 *
 * Validated HERE rather than trusted because the caller is our platform but the CONTENT came from
 * a learner. Every message names what was wrong: a challenge author reading "bad request" learns
 * nothing, and this endpoint is one they will be debugging against.
 */
function parseRunRequest(raw: unknown): RunRequest {
  const b = raw as Partial<RunRequest> | null;
  if (!b || typeof b !== "object") throw new BadRequest("body must be a JSON object");
  if (typeof b.challengeId !== "string" || !b.challengeId) throw new BadRequest("challengeId is required");
  if (typeof b.image !== "string" || !b.image) throw new BadRequest("image is required — it is a KEY into the allow-list, not an image reference");
  if (!Array.isArray(b.files) || b.files.length === 0) throw new BadRequest("files[] is required and must not be empty");
  for (const [i, f] of b.files.entries()) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
      throw new BadRequest(`files[${i}] must be { path: string, content: string }`);
    }
  }
  if (b.command !== undefined) {
    if (!Array.isArray(b.command) || b.command.some((c) => typeof c !== "string")) {
      throw new BadRequest("command must be an array of strings (argv — never a shell string)");
    }
  }
  const spec = b.gradingSpec;
  if (!spec || !Array.isArray(spec.checks)) throw new BadRequest("gradingSpec.checks[] is required");
  // A spec with no checks would score zero for everybody (grade.ts refuses to treat "nothing to
  // check" as "passed"), which is correct but useless — so it is refused at the door instead.
  if (spec.checks.length === 0) throw new BadRequest("gradingSpec.checks[] is empty — nothing would be graded");
  return b as RunRequest;
}

class BadRequest extends Error {}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://runner");
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") {
    // Reports the POSTURE, not merely "ok". "We thought gVisor was on" is a question somebody will
    // ask after an incident, and it should be answerable without reading the deploy.
    const docker = await dockerAvailable();
    return send(res, docker ? 200 : 503, {
      ok: docker,
      docker,
      runtime: config.runtime,
      hardenedRuntime: config.runtime !== "runc",
      concurrency: { max: config.maxConcurrent, running: queue.running, queued: queue.depth, maxQueued: config.maxQueued },
      images: Object.keys(config.images),
      limits: {
        timeoutSec: config.defaultTimeoutSec, maxTimeoutSec: config.maxTimeoutSec,
        memoryMb: config.defaultMemoryMb, maxMemoryMb: config.maxMemoryMb,
        cpus: config.defaultCpus, maxCpus: config.maxCpus, pidsLimit: config.pidsLimit,
      },
      // Said out loud because it is the single most important fact about this deployment.
      note: "No KVM on this host: containers are the only isolation boundary.",
    });
  }

  // Everything below is authenticated. /health is not, deliberately: a health check that needs the
  // shared secret is one the platform's monitoring cannot run without holding it.
  if (!tokenOk(req.headers.authorization)) return send(res, 401, { error: "unauthorized" });

  if (req.method === "POST" && path === "/runs") {
    let body: string;
    try {
      body = await readBody(req, config.maxSubmissionBytes * 2);
    } catch (e) {
      return send(res, 413, { error: e instanceof Error ? e.message : "body too large" });
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return send(res, 400, { error: "body is not valid JSON" }); }
    try {
      const request = parseRunRequest(parsed);
      const { runId } = queue.submit(request);
      return send(res, 202, { runId });
    } catch (e) {
      if (e instanceof QueueFullError) return send(res, 429, { error: e.message });
      if (e instanceof BadRequest) return send(res, 400, { error: e.message });
      return send(res, 400, { error: e instanceof Error ? e.message : "bad request" });
    }
  }

  const runMatch = path.match(/^\/runs\/([A-Za-z0-9-]+)$/);
  if (req.method === "GET" && runMatch) {
    const entry = queue.get(runMatch[1]!);
    // A 404 for an unknown OR expired id. The platform stores the grade; a result that has aged out
    // here is not a lost fact, and pretending otherwise would make this service a store.
    if (!entry) return send(res, 404, { error: "unknown run id, or its result has expired" });
    if (entry.state !== "done") return send(res, 200, { status: entry.state });
    return send(res, 200, { status: entry.result?.status ?? "error", ...entry.result });
  }

  return send(res, 404, { error: "not found" });
}

export function createLabServer() {
  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      // Never leak an internal message to the caller; the caller is our platform, but this is the
      // last-resort path and it should not become the one that says something interesting.
      console.error("[lab-runner] unhandled:", e);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    });
  });
}

// `import.meta.url` guard so the module can be imported by tests without binding a port.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "")) {
  const server = createLabServer();
  server.listen(config.port, config.host, () => {
    console.log(
      `[lab-runner] listening on ${config.host}:${config.port} · runtime=${config.runtime} · ` +
      `concurrency=${config.maxConcurrent} · images=${Object.keys(config.images).join(",")}`,
    );
    if (config.host === "0.0.0.0") {
      // Loud, because on SumoPod this is the difference between "internal" and "on the internet":
      // Docker's DNAT is evaluated before ufw's, so a 0.0.0.0 publish is reachable on a box whose
      // firewall claims otherwise.
      console.warn("[lab-runner] ⚠ BOUND TO 0.0.0.0. On SumoPod this is internet-reachable regardless of ufw.");
    }
  });
}

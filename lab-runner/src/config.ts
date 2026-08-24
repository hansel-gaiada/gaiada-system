import "dotenv/config";

// Lab-runner configuration.
//
// Design: ../../docs/blueprints/lms-foundation.md §5. Every default here is chosen against SumoPod
// AS MEASURED (2026-08-24): 4 vCPU, 7.3GB RAM available, swap already exhausted, load 6.39, and
// 19 containers of the owner's PRIVATE PRODUCTION on the same box. Starving those is a production
// incident somewhere else, which is why this service is a queue with a hard cap rather than a
// thing that runs what it is told when it is told.
//
// ⚠ NO KVM ON THIS HOST — confirmed by the owner 2026-08-25. No Firecracker, no microVM, no
//   hardware isolation. Containers are the ONLY boundary, so the hardening below is not defence in
//   depth on top of a hypervisor; it is the whole defence.

/** Fail loudly at boot rather than at the first run. A misconfigured runner that starts is worse. */
function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is required. The lab runner refuses to boot without it — a runner that starts ` +
      `half-configured executes untrusted code with a setting somebody assumed was applied.`,
    );
  }
  return v;
}

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  // `${VAR:-}` in compose yields an EMPTY STRING, and `Number("") === 0`. That exact shape once
  // produced a zero interval and a busy loop at 46% CPU in this estate. Empty means "not set".
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number; got ${JSON.stringify(raw)}`);
  }
  return n;
};

export const config = {
  /** NEVER 0.0.0.0 on SumoPod. Docker's DNAT is evaluated before ufw's, so a 0.0.0.0 publish is
   *  internet-reachable on a box whose firewall says otherwise. Bind loopback; front it with the
   *  existing nginx if it ever needs to be reachable. */
  host: process.env.LAB_RUNNER_HOST ?? "127.0.0.1",
  port: num("LAB_RUNNER_PORT", 4310),

  /** Shared secret. An unauthenticated lab endpoint is free compute for whoever finds it. */
  token: required("LAB_RUNNER_TOKEN"),

  /** Concurrency cap. TWO on a 4-vCPU box already carrying load 6.39 — the queue is the feature. */
  maxConcurrent: num("LAB_RUNNER_CONCURRENCY", 2),
  /** Beyond this the runner refuses rather than queues. An unbounded queue is a memory leak with
   *  a politer name, and a learner told "queued" for twenty minutes assumes it is broken. */
  maxQueued: num("LAB_RUNNER_MAX_QUEUED", 20),

  /** Per-run caps. The wall clock is the one that always fires — an infinite loop consumes CPU
   *  quota happily and never exits on its own. */
  defaultTimeoutSec: num("LAB_RUNNER_TIMEOUT_SEC", 90),
  maxTimeoutSec: num("LAB_RUNNER_MAX_TIMEOUT_SEC", 300),
  defaultMemoryMb: num("LAB_RUNNER_MEMORY_MB", 512),
  maxMemoryMb: num("LAB_RUNNER_MAX_MEMORY_MB", 1024),
  defaultCpus: num("LAB_RUNNER_CPUS", 1),
  maxCpus: num("LAB_RUNNER_MAX_CPUS", 2),
  pidsLimit: num("LAB_RUNNER_PIDS_LIMIT", 128),
  /** Output is captured into memory. A runaway `yes` fills a disk otherwise. */
  maxOutputBytes: num("LAB_RUNNER_MAX_OUTPUT_BYTES", 256 * 1024),
  /** Total bytes of submitted files. Small on purpose: this takes source, not archives. */
  maxSubmissionBytes: num("LAB_RUNNER_MAX_SUBMISSION_BYTES", 256 * 1024),

  /**
   * THE IMAGE ALLOW-LIST — the single most important setting in this file.
   *
   * The caller names an image. If that name were honoured, anybody who could reach this endpoint
   * could run ANY image on a host carrying Postiz's social OAuth tokens and two unrelated
   * projects' data. So the caller's `image` is a KEY into this map, never a reference.
   *
   * Pinned by digest where possible in deployment; the default below is deliberately minimal.
   */
  images: parseImages(process.env.LAB_RUNNER_IMAGES),

  /**
   * Container runtime. `runsc` (gVisor, ptrace mode) is the intended setting for the untrusted-code
   * path: it puts a user-space kernel between the submission and the host, which matters more here
   * than anywhere because there is no hypervisor underneath.
   *
   * Defaults to runc — the standard runtime — because a runner that refuses to start when gVisor is
   * absent cannot be tried at all. `GET /health` reports which one is in force, so "we thought
   * gVisor was on" is answerable rather than assumed.
   */
  runtime: process.env.LAB_RUNNER_RUNTIME ?? "runc",

  /** How long a finished run stays readable before it is dropped. Results are not durable state —
   *  the platform records the grade; this service is a compute surface, not a store. */
  resultTtlSec: num("LAB_RUNNER_RESULT_TTL_SEC", 900),
} as const;

/**
 * `key=image[,key=image]` — e.g. `node20=node:20-alpine,python312=python:3.12-alpine`.
 *
 * Parsed strictly. A malformed entry is a boot error rather than a silently-dropped image, because
 * the failure it produces otherwise is "that lab says image not allowed" long after deploy.
 */
function parseImages(raw: string | undefined): Readonly<Record<string, string>> {
  const spec = raw ?? "node20=node:20-alpine";
  const out: Record<string, string> = {};
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq <= 0) throw new Error(`LAB_RUNNER_IMAGES entry is not key=image: ${JSON.stringify(part)}`);
    const key = part.slice(0, eq).trim();
    const image = part.slice(eq + 1).trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
      throw new Error(`LAB_RUNNER_IMAGES key must be lowercase alphanumeric: ${JSON.stringify(key)}`);
    }
    if (!image) throw new Error(`LAB_RUNNER_IMAGES entry has no image: ${JSON.stringify(part)}`);
    out[key] = image;
  }
  if (Object.keys(out).length === 0) throw new Error("LAB_RUNNER_IMAGES resolved to no images");
  return Object.freeze(out);
}

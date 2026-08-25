// Building the `docker run` argument list for one lab attempt.
//
// This file is the security boundary of the whole service, so it is written to be READ rather than
// to be short. Every flag below is load-bearing and the reason is stated; a flag whose reason
// nobody remembers is a flag somebody removes to fix an unrelated problem.
//
// ⚠ THERE IS NO HYPERVISOR UNDERNEATH. SumoPod has no KVM (owner-confirmed 2026-08-25), so this
//   argument list IS the isolation — not a second layer beneath a microVM. It also shares a kernel
//   with 19 containers of the owner's private production, including Postiz's social OAuth tokens.
import { config } from "./config.js";

export interface Limits {
  timeoutSec?: number;
  memoryMb?: number;
  cpus?: number;
  /** Opt-in, per challenge. Default is NO network at all. */
  network?: "none" | "isolated";
}

export interface ResolvedLimits {
  timeoutSec: number;
  memoryMb: number;
  cpus: number;
  network: "none" | "isolated";
}

/**
 * Clamp caller-supplied limits into the configured ceiling.
 *
 * CLAMPS rather than rejects, deliberately: the caller is our own platform, and a challenge author
 * who asks for 4GB should get the maximum with the real figure reported back, not a 400 they have
 * to decode. What it must never do is HONOUR the request — an attempt that could name its own
 * memory limit could take the box down and the box is not ours alone.
 */
export function resolveLimits(l: Limits | undefined): ResolvedLimits {
  const clamp = (v: number | undefined, def: number, max: number) => {
    if (v === undefined || !Number.isFinite(v) || v <= 0) return def;
    return Math.min(v, max);
  };
  return {
    timeoutSec: clamp(l?.timeoutSec, config.defaultTimeoutSec, config.maxTimeoutSec),
    memoryMb: clamp(l?.memoryMb, config.defaultMemoryMb, config.maxMemoryMb),
    cpus: clamp(l?.cpus, config.defaultCpus, config.maxCpus),
    // Anything that is not the literal "isolated" is "none". Fail closed: a typo in a challenge
    // spec must not open a network.
    network: l?.network === "isolated" ? "isolated" : "none",
  };
}

/**
 * The image the caller named, resolved through the ALLOW-LIST.
 *
 * The caller sends a KEY, never a reference. Honouring a caller-supplied image name on a host that
 * carries somebody else's production is the whole ballgame — it turns this endpoint into "run
 * arbitrary code as whatever that image's entrypoint is".
 */
export function resolveImage(key: string): string {
  const image = (config.images as Record<string, string>)[key];
  if (!image) {
    throw new Error(
      `unknown image key ${JSON.stringify(key)}. Allowed: ${Object.keys(config.images).join(", ")}. ` +
      `The caller names a KEY, not an image reference.`,
    );
  }
  return image;
}

/**
 * The `docker run` args for one attempt.
 *
 * `workdir` is a host directory holding the submission; it is mounted READ-ONLY and the container
 * writes only to a tmpfs. That asymmetry matters: a submission that could rewrite its own test
 * files could make any grading assertion pass.
 */
export function buildRunArgs(opts: {
  image: string;
  workdir: string;

  command: string[];
  limits: ResolvedLimits;
  networkName?: string;
  containerName: string;
  /**
   * A companion target's alias, baked into /etc/hosts at container creation instead of relying on
   * Docker's embedded DNS resolver (127.0.0.11).
   *
   * ⚠ FOUND BY DRIVING L6a FOR REAL (2026-08-25), not by the unit tests: under `runsc` (gVisor,
   *   ptrace platform), a container on a `--internal` bridge network gets a correct
   *   `/etc/resolv.conf` pointing at 127.0.0.11, but the lookup itself fails — `getaddrinfo EAI_AGAIN`
   *   — even though the SAME network + SAME target resolve fine under `runc`, and a request to the
   *   target's raw IP succeeds under `runsc` too. So the break is specifically gVisor's netstack not
   *   proxying the embedded UDP resolver, not routing in general.
   *   `--add-host` sidesteps it entirely: Docker writes the mapping into /etc/hosts as a bind-mounted
   *   file at container start, before the container's own read-only rootfs applies and before any
   *   runtime network syscall is needed, so it works identically under runc and runsc. This is the
   *   fix, not a workaround pending a gVisor upgrade — resolving a companion target by DNS alias is
   *   not something this design needs; a fixed, runner-known IP is all `alias` ever promised.
   */
  addHost?: { alias: string; ip: string };
}): string[] {
  const { image, workdir, command, limits, networkName, containerName, addHost } = opts;

  const args = [
    "run",
    "--rm",
    "--name", containerName,

    // ── Identity ────────────────────────────────────────────────────────────────────────────
    // A non-root uid inside the container. With userns-remap configured on the daemon this is a
    // second, independent reduction rather than the only one — but the daemon's configuration is
    // not something this process can verify, so it does its own.
    "--user", "65534:65534",

    // ── Privilege ───────────────────────────────────────────────────────────────────────────
    // Drop EVERY capability and forbid regaining any. `no-new-privileges` is what stops a setuid
    // binary inside the image from undoing the line above it.
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",

    // ── Filesystem ──────────────────────────────────────────────────────────────────────────
    // Read-only rootfs; the only writable places are tmpfs mounts that vanish with the container.
    // `noexec` on /tmp: a submission may write there, but must not then execute what it wrote.
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--tmpfs", "/run:rw,noexec,nosuid,size=8m",
    // The submission, READ-ONLY. See the doc comment above.
    "-v", `${workdir}:/lab:ro`,
    // The one writable working area, and it is NOT the submission.
    //
    // A tmpfs WITH AN EXPLICIT uid/gid, and the route here is worth recording because two obvious
    // designs fail:
    //   * a plain `--tmpfs /work` is created ROOT-OWNED, so `--user 65534` cannot write a byte to
    //     it. Every run failed with "cp: can't create '/work/...': Permission denied" — the first
    //     end-to-end drive of this service.
    //   * a docker VOLUME chowned by a prep container looked like the fix and is not portable:
    //     Docker Desktop masks volume ownership per container, so the chown appears to take and the
    //     next container still sees root. Verified directly; `chmod 0777` behaves the same way.
    // `uid=65534,gid=65534,mode=1777` needs no prep step, no cleanup, and behaves identically on
    // Docker Desktop and on the Linux box this is going to.
    "--tmpfs", "/work:rw,nosuid,size=128m,mode=1777,uid=65534,gid=65534",
    "-w", "/work",

    // ── Resources ───────────────────────────────────────────────────────────────────────────
    // `--memory-swap` equal to `--memory` disables swap for this container specifically. SumoPod's
    // swap is ALREADY EXHAUSTED; letting a lab swap would degrade the whole box, and the box runs
    // somebody's production.
    "--memory", `${limits.memoryMb}m`,
    "--memory-swap", `${limits.memoryMb}m`,
    "--cpus", String(limits.cpus),
    "--pids-limit", String(config.pidsLimit),
    // A fork bomb is the cheapest attack on a shared box and pids-limit is what stops it.

    // ── Environment ─────────────────────────────────────────────────────────────────────────
    // Nothing inherited. The runner's own env holds LAB_RUNNER_TOKEN, and a lab that could read
    // the process environment could read that.
    "--env", "HOME=/work",
    "--env", "NODE_OPTIONS=--max-old-space-size=256",
  ];

  // ── Network ───────────────────────────────────────────────────────────────────────────────
  // Default NONE. `isolated` joins a per-run internal bridge with no route out — that is the Cyber
  // shape (an attacker container and a deliberately vulnerable target, talking to each other and
  // to nothing else). It is never the host network and never the default bridge, either of which
  // would put a lab on the same network as production containers.
  if (limits.network === "isolated" && networkName) {
    args.push("--network", networkName);
  } else {
    args.push("--network", "none");
  }

  // See the doc comment on `addHost` above: this is how the attacker container finds its companion
  // target. Not DNS.
  if (addHost) {
    args.push("--add-host", `${addHost.alias}:${addHost.ip}`);
  }

  if (config.runtime && config.runtime !== "runc") {
    // gVisor when available. Slower than native; correct — see the blueprint §5.
    args.push("--runtime", config.runtime);
  }

  args.push(image, ...command);
  return args;
}

/**
 * Args for the per-run isolated network.
 *
 * `--internal` is the flag that matters: it removes the route out. Without it, "isolated" would be
 * a network that still reaches the internet and every published port on the host — which is the
 * opposite of what a Cyber lab needs, and would look identical from inside the container.
 */
export function buildNetworkArgs(name: string): string[] {
  return ["network", "create", "--internal", "--driver", "bridge", name];
}

/**
 * The COMPANION TARGET — the second half of a Cyber lab (L6).
 *
 * A deliberately vulnerable service the learner is asked to break, on the same internal-only
 * network as their attacker container and reachable from nowhere else. The industry shape
 * (Juice Shop / DVWA lineage), with two differences that matter on a host running other
 * people's production:
 *
 *   1. IT IS AS LOCKED DOWN AS THE ATTACKER. Non-root, all capabilities dropped,
 *      no-new-privileges, read-only rootfs, memory and pid caps. "It is meant to be vulnerable"
 *      is a statement about its APPLICATION logic, not a licence to give it host privileges —
 *      the learner is about to get code execution inside it, and that is the point.
 *   2. NO PUBLISHED PORT, EVER. It is reachable on the internal bridge by container name and
 *      from nowhere else. A published vulnerable service on this box would be an actual
 *      vulnerability, not a lab.
 *
 * Detached: the runner starts it, runs the attacker against it, then removes both.
 */
export function buildTargetArgs(opts: {
  image: string;
  networkName: string;
  containerName: string;
  /** The name the attacker resolves it by, on the internal bridge. */
  alias: string;
  memoryMb: number;
  env?: Record<string, string>;
}): string[] {
  const { image, networkName, containerName, alias, memoryMb, env } = opts;
  const args = [
    "run", "-d", "--rm",
    "--name", containerName,
    "--network", networkName,
    "--network-alias", alias,
    // Same hardening as the attacker. See the doc comment.
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
    "--tmpfs", "/run:rw,nosuid,size=8m",
    "--tmpfs", "/var/log:rw,nosuid,size=8m",
    "--memory", `${memoryMb}m`,
    "--memory-swap", `${memoryMb}m`,
    "--cpus", "0.5",
    "--pids-limit", "64",
  ];
  for (const [k, v] of Object.entries(env ?? {})) args.push("--env", `${k}=${v}`);
  if (config.runtime && config.runtime !== "runc") args.push("--runtime", config.runtime);
  args.push(image);
  return args;
}

// The sandbox argument list is the security boundary of this service, so it is PINNED.
//
// Every assertion here corresponds to a flag whose absence has a specific consequence on SumoPod —
// a box with no KVM, 19 containers of the owner's private production, and Postiz's social OAuth
// tokens. A flag removed to fix an unrelated problem should turn this file red, loudly.
import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.LAB_RUNNER_TOKEN ??= "test-token";
  process.env.LAB_RUNNER_IMAGES ??= "node20=node:20-alpine,python312=python:3.12-alpine";
});

const load = async () => {
  const sandbox = await import("./sandbox.js");
  return sandbox;
};

describe("resolveImage — the allow-list", () => {
  it("resolves a KEY, never a caller-supplied image reference", async () => {
    const { resolveImage } = await load();
    expect(resolveImage("node20")).toBe("node:20-alpine");
    // THE assertion. Honouring a caller-supplied image on a host carrying somebody else's
    // production turns this endpoint into "run arbitrary code as whatever that entrypoint is".
    expect(() => resolveImage("alpine:latest")).toThrow(/unknown image key/);
    expect(() => resolveImage("ubuntu")).toThrow(/unknown image key/);
    expect(() => resolveImage("../../etc/passwd")).toThrow(/unknown image key/);
  });

  it("names what IS allowed, so a challenge author can fix it", async () => {
    const { resolveImage } = await load();
    expect(() => resolveImage("nope")).toThrow(/node20/);
  });
});

describe("resolveLimits — clamp, never honour", () => {
  it("clamps an over-large request instead of trusting it", async () => {
    const { resolveLimits } = await load();
    const r = resolveLimits({ timeoutSec: 99999, memoryMb: 999999, cpus: 64 });
    expect(r.timeoutSec).toBeLessThanOrEqual(300);
    expect(r.memoryMb).toBeLessThanOrEqual(1024);
    expect(r.cpus).toBeLessThanOrEqual(2);
  });

  it("falls back to defaults for absent, zero or nonsense values", async () => {
    const { resolveLimits } = await load();
    expect(resolveLimits(undefined).memoryMb).toBe(512);
    expect(resolveLimits({ memoryMb: 0 }).memoryMb).toBe(512);
    expect(resolveLimits({ memoryMb: Number.NaN }).memoryMb).toBe(512);
    expect(resolveLimits({ cpus: -4 }).cpus).toBe(1);
  });

  it("defaults the network to NONE, and only the literal 'isolated' opens one", async () => {
    const { resolveLimits } = await load();
    expect(resolveLimits(undefined).network).toBe("none");
    expect(resolveLimits({}).network).toBe("none");
    // Fail closed: a typo in a challenge spec must not open a network.
    expect(resolveLimits({ network: "Isolated" as "isolated" }).network).toBe("none");
    expect(resolveLimits({ network: "isolated" }).network).toBe("isolated");
  });
});

describe("buildRunArgs — the flags that are the isolation", () => {
  const base = async () => {
    const { buildRunArgs, resolveLimits } = await load();
    return buildRunArgs({
      image: "node:20-alpine", workdir: "/tmp/src", command: ["node", "x.js"],
      limits: resolveLimits(undefined), containerName: "lab-test",
    });
  };
  const pair = (args: string[], flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  it("drops every capability and forbids regaining one", async () => {
    const args = await base();
    expect(pair(args, "--cap-drop")).toBe("ALL");
    // Without no-new-privileges, a setuid binary in the image undoes the line above.
    expect(args).toContain("--security-opt");
    expect(args).toContain("no-new-privileges");
  });

  it("runs as a non-root uid", async () => {
    expect(pair(await base(), "--user")).toBe("65534:65534");
  });

  it("mounts the submission READ-ONLY, and gives the container a separate writable area", async () => {
    const args = await base();
    // A submission that could rewrite its own test files could make any assertion pass.
    expect(args).toContain("/tmp/src:/lab:ro");
    // /work is a BIND MOUNT, not a tmpfs — a tmpfs is root-owned (so uid 65534 cannot write) and
    // vanishes with the container (so `fileExists` could never pass). Both were found by driving it.
    // A tmpfs WITH AN EXPLICIT uid. A plain tmpfs is root-owned and uid 65534 cannot write to it —
    // that is how the first end-to-end drive of this service failed, and it is the single easiest
    // line to "simplify" back into a bug.
    expect(args.join(" ")).toContain("--tmpfs /work:rw,nosuid,size=128m,mode=1777,uid=65534,gid=65534");
    // No host path is exposed writable to a learner's container.
    expect(args.join(" ")).not.toContain(":/work:rw");
    expect(pair(args, "-w")).toBe("/work");
    expect(args).toContain("--read-only");
  });

  it("mounts /tmp noexec — writable, but not a place to run what you wrote", async () => {
    expect((await base()).join(" ")).toContain("/tmp:rw,noexec,nosuid");
  });

  it("disables swap for the container", async () => {
    const args = await base();
    // SumoPod's swap is ALREADY EXHAUSTED. Letting a lab swap degrades a box running somebody
    // else's production, so memory-swap must equal memory rather than be absent.
    expect(pair(args, "--memory")).toBe("512m");
    expect(pair(args, "--memory-swap")).toBe("512m");
  });

  it("caps pids — a fork bomb is the cheapest attack on a shared box", async () => {
    expect(pair(await base(), "--pids-limit")).toBe("128");
  });

  it("has NO network by default", async () => {
    expect(pair(await base(), "--network")).toBe("none");
  });

  it("uses the per-run isolated bridge only when asked, and never the host or default bridge", async () => {
    const { buildRunArgs, resolveLimits } = await load();
    const args = buildRunArgs({
      image: "node:20-alpine", workdir: "/tmp/src", command: ["sh"],
      limits: resolveLimits({ network: "isolated" }), networkName: "lab-net-abc", containerName: "lab-x",
    });
    expect(pair(args, "--network")).toBe("lab-net-abc");
    expect(args).not.toContain("host");
    expect(pair(args, "--network")).not.toBe("bridge");
  });

  it("falls back to no network when isolated was asked for but no network was created", async () => {
    const { buildRunArgs, resolveLimits } = await load();
    const args = buildRunArgs({
      image: "node:20-alpine", workdir: "/tmp/src", command: ["sh"],
      limits: resolveLimits({ network: "isolated" }), containerName: "lab-x",
    });
    // Fail closed rather than defaulting to the bridge, which would put a lab on the same network
    // as production containers.
    expect(pair(args, "--network")).toBe("none");
  });

  it("passes no host environment through", async () => {
    const args = await base();
    const envs = args.filter((a, i) => args[i - 1] === "--env");
    // The runner's own environment holds LAB_RUNNER_TOKEN.
    expect(envs.every((e) => e.startsWith("HOME=") || e.startsWith("NODE_OPTIONS="))).toBe(true);
    expect(args.join(" ")).not.toContain("LAB_RUNNER_TOKEN");
  });

  it("always removes the container", async () => {
    expect(await base()).toContain("--rm");
  });

  it("bakes a companion target's alias into /etc/hosts, never relies on DNS", async () => {
    const { buildRunArgs, resolveLimits } = await load();
    const args = buildRunArgs({
      image: "node:20-alpine", workdir: "/tmp/src", command: ["sh"],
      limits: resolveLimits({ network: "isolated" }), networkName: "lab-net-x",
      containerName: "lab-x", addHost: { alias: "target", ip: "172.30.0.2" },
    });
    // Found by driving L6a for real: gVisor's runsc does not proxy Docker's embedded DNS resolver
    // (127.0.0.11) on an --internal bridge network, so the attacker's alias lookup for "target"
    // must not depend on it. --add-host writes the mapping straight into /etc/hosts.
    expect(pair(args, "--add-host")).toBe("target:172.30.0.2");
  });

  it("omits --add-host entirely when there is no companion target", async () => {
    const args = await base();
    expect(args).not.toContain("--add-host");
  });
});

describe("buildNetworkArgs", () => {
  it("creates an INTERNAL bridge — the flag that removes the route out", async () => {
    const { buildNetworkArgs } = await load();
    const args = buildNetworkArgs("lab-net-1");
    // Without --internal, "isolated" would still reach the internet and every published port on
    // the host, and it would look identical from inside the container.
    expect(args).toContain("--internal");
    expect(args).toContain("bridge");
    expect(args).toContain("lab-net-1");
  });
});

describe("buildTargetArgs — the Cyber lab's disposable target", () => {
  const build = async () => {
    const { buildTargetArgs } = await load();
    return buildTargetArgs({
      image: "vuln:1", networkName: "lab-net-x", containerName: "lab-x-target",
      alias: "target", memoryMb: 256,
    });
  };
  const pair = (args: string[], flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  it("is as locked down as the attacker — 'meant to be vulnerable' is about its APP, not the host", async () => {
    const args = await build();
    // The learner is about to get code execution inside this container. That is the exercise, and
    // it is exactly why it gets no capabilities and no writable rootfs.
    expect(pair(args, "--cap-drop")).toBe("ALL");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("--read-only");
    expect(pair(args, "--memory")).toBe("256m");
    expect(pair(args, "--memory-swap")).toBe("256m");
    expect(pair(args, "--pids-limit")).toBe("64");
  });

  it("NEVER publishes a port", async () => {
    const args = await build();
    // A published vulnerable service on a box carrying seven other projects is an actual
    // vulnerability rather than a lab.
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--publish");
    expect(args.join(" ")).not.toMatch(/\d+:\d+/);
  });

  it("joins the per-run internal network under a resolvable alias, and nothing else", async () => {
    const args = await build();
    expect(pair(args, "--network")).toBe("lab-net-x");
    expect(pair(args, "--network-alias")).toBe("target");
    expect(args).not.toContain("host");
  });

  it("is detached and self-removing", async () => {
    const args = await build();
    expect(args).toContain("-d");
    expect(args).toContain("--rm");
  });
});

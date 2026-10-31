// M5-P5b2 — infra/scripts/ai-crawler-pull.sh, run for real with stubs: AI_CRAWLER_SSH runs the "remote" command locally
// against a fixture log, AI_CRAWLER_INGEST captures what the script pipes to the ingest. No network, no Docker, no database.
// Skipped cleanly where bash, jq or sha256sum is missing (a plain Windows dev machine); it RUNS in CI (Linux). Where
// `flock` is missing (Git Bash) a no-op shim stands in for it, so the rest of the script is still exercised.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Paths handed to bash: forward slashes, and on Windows the /c/... form Git Bash understands.
const fwd = (p: string): string =>
  p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d: string) => (process.platform === "win32" ? `/${d.toLowerCase()}` : `${d}:`));
const BASH = process.env.BASH_FOR_TESTS ?? "bash";
const SCRIPT = fwd(resolve(__dirname, "../../../../infra/scripts/ai-crawler-pull.sh"));

const has = (cmd: string): boolean => {
  const r = spawnSync(BASH, ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  return !r.error && r.status === 0;
};
const bashOk = ((): boolean => {
  const r = spawnSync(BASH, ["-c", "echo ok"], { encoding: "utf8" });
  return !r.error && r.status === 0 && r.stdout.trim() === "ok";
})();
const canRun = bashOk && has("jq") && has("sha256sum") && has("stat") && has("grep");
const hasFlock = canRun && has("flock");

vi.setConfig({ testTimeout: 60_000 }); // each case spawns bash several times; Git Bash on Windows is slow
const TENANT = "0190aaaa-0000-7000-8000-000000000001";
const PROP = "0190aaaa-0000-7000-8000-000000000002";
const PROP2 = "0190aaaa-0000-7000-8000-000000000003";
const HUMAN = '203.0.113.9 - - [31/Oct/2026:10:00:00 +0000] "GET /home HTTP/1.1" 200 5 "-" "Mozilla/5.0 Chrome/126.0"';
const gpt = (n: number): string => `203.0.113.55 - - [31/Oct/2026:10:00:0${n} +0000] "GET /p${n}/ HTTP/1.1" 200 5 "-" "Mozilla/5.0 (compatible; GPTBot/1.1)"`;
const claude = (n: number): string => `203.0.113.56 - - [31/Oct/2026:10:01:0${n} +0000] "GET /c${n}/ HTTP/1.1" 200 5 "-" "Mozilla/5.0 (compatible; ClaudeBot/1.0)"`;

const SSH_STUB = `#!/bin/sh
printf '%s\\n' "$@" >> "$STUB_SSH_LOG"
printf -- '--call--\\n' >> "$STUB_SSH_LOG"
[ -n "$STUB_SSH_FAIL" ] && exit "$STUB_SSH_FAIL"
for last; do :; done
exec sh -c "$last"
`;
const INGEST_STUB = `#!/bin/sh
if [ "$1" = "--grep-pattern" ]; then echo 'GPTBot|ClaudeBot'; exit 0; fi
n=$(ls "$STUB_INGEST_DIR" | wc -l)
printf '%s\\n' "$@" > "$STUB_INGEST_DIR/args-$n"
cat > "$STUB_INGEST_DIR/call-$n"
exit "\${STUB_INGEST_RC:-0}"
`;
const FLOCK_SHIM = "#!/bin/sh\nexit 0\n";

describe.skipIf(!canRun)("M5-P5b2 · ai-crawler-pull.sh", () => {
  let root: string;
  let work: string;
  let logFile: string;
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    PATH: hasFlock ? process.env.PATH : `${fwd(join(root, "bin"))}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    AI_CRAWLER_SOURCES: fwd(join(work, "sources.json")),
    AI_CRAWLER_KEY: "/test/key/id_ed25519",
    AI_CRAWLER_KNOWN_HOSTS: "/test/known_hosts",
    AI_CRAWLER_STATE: fwd(join(work, "state")),
    AI_CRAWLER_LOCK: fwd(join(work, "lock")),
    AI_CRAWLER_SSH: fwd(join(root, "bin", "ssh-stub")),
    AI_CRAWLER_INGEST: fwd(join(root, "bin", "ingest-stub")),
    STUB_SSH_LOG: fwd(join(work, "ssh.log")),
    STUB_INGEST_DIR: fwd(join(work, "ingest")),
    ...extra,
  });
  const run = (extra: Record<string, string> = {}) => spawnSync(BASH, [SCRIPT], { env: env(extra), encoding: "utf8", timeout: 60_000 });
  const calls = (): string[] => readdirSync(join(work, "ingest")).filter((f) => f.startsWith("call-")).sort().map((f) => readFileSync(join(work, "ingest", f), "utf8"));
  const sshLog = (): string => { try { return readFileSync(join(work, "ssh.log"), "utf8"); } catch { return ""; } };
  const sources = (list: unknown[]): void => writeFileSync(join(work, "sources.json"), JSON.stringify(list));
  const source = (over: Record<string, unknown> = {}) => ({
    name: "site-a", tenantId: TENANT, propertyId: PROP, host: "web1.example.test", port: 22, user: "crawler",
    logs: [fwd(logFile)], enabled: true, ...over,
  });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "aicp-bin-"));
    mkdirSync(join(root, "bin"));
    for (const [n, body] of [["ssh-stub", SSH_STUB], ["ingest-stub", INGEST_STUB], ["flock", FLOCK_SHIM]] as const) {
      writeFileSync(join(root, "bin", n), body, { mode: 0o755 });
      chmodSync(join(root, "bin", n), 0o755);
    }
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "aicp-work-"));
    mkdirSync(join(work, "ingest"));
    logFile = join(work, "access.log");
    writeFileSync(logFile, [HUMAN, gpt(1), HUMAN, claude(1), HUMAN].join("\n") + "\n");
    sources([source()]);
  });

  it("the first run sends only the bot lines, and nothing a human made", () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toEqual([`${gpt(1)}\n${claude(1)}\n`]);
    expect(calls().join("")).not.toContain("Chrome");
    const args = readFileSync(join(work, "ingest", "args-0"), "utf8");
    expect(args).toContain(`--tenant\n${TENANT}\n--property\n${PROP}`);
  });

  it("an immediate second run sends nothing", () => {
    expect(run().status).toBe(0);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toHaveLength(1);
  });

  it("appended lines send only the new ones", () => {
    run();
    appendFileSync(logFile, [HUMAN, gpt(2), HUMAN].join("\n") + "\n");
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toEqual([`${gpt(1)}\n${claude(1)}\n`, `${gpt(2)}\n`]);
  });

  it("a truncated log restarts from the start", () => {
    run();
    writeFileSync(logFile, `${gpt(3)}\n`);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(calls()[1]).toBe(`${gpt(3)}\n`);
  });

  it("a rotated log (a new file, larger than the old offset) restarts from the start", () => {
    run();
    renameSync(logFile, `${logFile}.1`);
    writeFileSync(logFile, [HUMAN, HUMAN, HUMAN, gpt(4), HUMAN, HUMAN, claude(4), HUMAN, HUMAN, HUMAN, gpt(5), HUMAN].join("\n") + "\n");
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(calls()[1]).toBe(`${gpt(4)}\n${claude(4)}\n${gpt(5)}\n`);
  });

  it("a failing ingest does not advance the state, so the next run sends the same lines again", () => {
    const bad = run({ STUB_INGEST_RC: "1" });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("FAIL source=site-a");
    expect(bad.stderr).not.toContain("GPTBot");
    const again = run();
    expect(again.status, again.stderr).toBe(0);
    expect(calls()).toEqual([`${gpt(1)}\n${claude(1)}\n`, `${gpt(1)}\n${claude(1)}\n`]);
  });

  it("one failed source does not stop the next, and the exit status is non-zero", () => {
    const log2 = join(work, "b.log");
    writeFileSync(log2, `${gpt(7)}\n`);
    sources([source({ name: "site-bad", host: "web9.example.test", logs: [fwd(join(work, "nope.log"))], enabled: true }),
      source({ name: "site-b", propertyId: PROP2, logs: [fwd(log2)] })]);
    const r = run({ STUB_SSH_FAIL: "" });
    // the missing file is a skip, not a failure
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("SKIP source=site-bad");
    expect(calls()).toEqual([`${gpt(7)}\n`]);
    // an ssh failure (for example an unpinned host key) fails that source and leaves its state alone
    const f = run({ STUB_SSH_FAIL: "255" });
    expect(f.status).not.toBe(0);
    expect(f.stderr).toContain("ssh exit 255");
  });

  it("a disabled source is skipped, and an empty or all-disabled config does nothing", () => {
    sources([source({ enabled: false })]);
    expect(run().status).toBe(0);
    sources([]);
    expect(run().status).toBe(0);
    expect(sshLog()).toBe("");
    expect(calls()).toEqual([]);
  });

  it("calls ssh with a pinned host key check and the job's own key, one call per log path", () => {
    const second = join(work, "other.log");
    writeFileSync(second, `${claude(2)}\n`);
    sources([source({ logs: [fwd(logFile), fwd(second)], proxyJump: "jump@bastion.example.test" })]);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    const log = sshLog();
    const perCall = log.split("--call--\n").filter(Boolean);
    expect(perCall).toHaveLength(2);
    for (const c of perCall) {
      const a = c.split("\n");
      expect(a).toContain("StrictHostKeyChecking=yes");
      expect(a).toContain("IdentitiesOnly=yes");
      expect(a).toContain("BatchMode=yes");
      expect(a).toContain("UserKnownHostsFile=/test/known_hosts");
      expect(a[a.indexOf("-i") + 1]).toBe("/test/key/id_ed25519");
      expect(a[a.indexOf("-J") + 1]).toBe("jump@bastion.example.test");
      expect(a).toContain("crawler@web1.example.test");
    }
  });

  it("refuses an entry whose host, name or path is not plain, and never calls ssh for it", () => {
    sources([source({ host: "-oProxyCommand=evil" }), source({ name: "../x" }), source({ logs: ["relative.log"] })]);
    const r = run();
    expect(r.status).not.toBe(0);
    expect(sshLog()).toBe("");
  });

  it.skipIf(!hasFlock)("two overlapping runs: the second finds the lock held and does nothing", () => {
    const holder = spawnSync(BASH, ["-c", `exec 8>"${fwd(join(work, "lock"))}"; flock -n 8 && ( env AI_CRAWLER_SOURCES="${fwd(join(work, "sources.json"))}" AI_CRAWLER_LOCK="${fwd(join(work, "lock"))}" AI_CRAWLER_SSH=/bin/false AI_CRAWLER_INGEST=/bin/true bash "${SCRIPT}" 2>&1 )`], { encoding: "utf8" });
    expect(holder.stdout).toContain("holds the lock");
  });
});

import { describe, expect, it, vi } from "vitest";
import { SshRsyncDeployDriver } from "./ssh-rsync-driver";
import type { ExecFn, ExecResult, HostConfig } from "./types";
import { MissingHostConfig } from "./config";

// grep -c real-exec ssh-rsync-driver.test.ts => 0 : this file's only relationship to real-exec.ts
// is this comment. Every exec call below is the fake defined per-test.
function ok(stdout = ""): ExecResult { return { code: 0, stdout, stderr: "", timedOut: false }; }
function fail(code: number, stderr: string): ExecResult { return { code, stdout: "", stderr, timedOut: false }; }
function timeout(): ExecResult { return { code: null, stdout: "", stderr: "", timedOut: true }; }

const STAGING_CFG: HostConfig = {
  target: "staging", host: "72.61.142.88", sshUser: "root", sshKeyPath: "/keys/delphi",
  connectTimeoutSec: 8,
};
const STAGING_CFG_WITH_PATH: HostConfig = { ...STAGING_CFG, remoteBasePath: "/home/gaiada-fe/sites/acme" };

describe("SshRsyncDeployDriver.probe", () => {
  it("reports reachable:true ONLY on a real exit code 0", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue(ok());
    const driver = new SshRsyncDeployDriver(exec, () => STAGING_CFG);
    const res = await driver.probe("staging");
    expect(res).toMatchObject({ target: "staging", host: "72.61.142.88", reachable: true, detail: "ssh exited 0" });
    expect(res.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The exact invocation shape — this is the "real driver" half of the seam: prove it calls ssh
    // the way an operator reading this file would expect, not just that it returns something.
    expect(exec).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining(["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-i", "/keys/delphi", "root@72.61.142.88", "true"]),
      expect.objectContaining({ timeoutMs: 13000 }),
    );
  });

  it("labels a timeout as unreachable, never as an error the caller must catch", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue(timeout());
    const driver = new SshRsyncDeployDriver(exec, () => STAGING_CFG);
    const res = await driver.probe("staging");
    expect(res.reachable).toBe(false);
    expect(res.detail).toContain("timed out after 8s");
  });

  it("labels a non-zero ssh exit as unreachable and carries the real stderr", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue(fail(255, "Permission denied (publickey)."));
    const driver = new SshRsyncDeployDriver(exec, () => STAGING_CFG);
    const res = await driver.probe("staging");
    expect(res.reachable).toBe(false);
    expect(res.detail).toBe("ssh exited 255: Permission denied (publickey).");
  });

  it("never invokes exec when the host is unconfigured — fails closed before spawning anything", async () => {
    const exec = vi.fn<ExecFn>();
    const driver = new SshRsyncDeployDriver(exec, () => {
      throw new MissingHostConfig("production", "HELIOS_SSH_HOST and HELIOS_SSH_USER");
    });
    const res = await driver.probe("production");
    expect(res.reachable).toBe(false);
    expect(res.host).toBe("(unconfigured)");
    expect(res.detail).toContain("HELIOS_SSH_HOST");
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("SshRsyncDeployDriver.deploy", () => {
  it("refuses with a named, actionable message when remoteBasePath is unset — reachable is not enough", async () => {
    const exec = vi.fn<ExecFn>();
    const driver = new SshRsyncDeployDriver(exec, () => STAGING_CFG); // no remoteBasePath
    const res = await driver.deploy("staging", "/tmp/build");
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("DELPHI_REMOTE_BASE_PATH");
    expect(res.detail).toContain("shared-hosting");
    expect(exec).not.toHaveBeenCalled(); // never attempts rsync with a path it doesn't have
  });

  it("rsyncs to releases/<id>/ then swaps the current symlink, in that order, on success", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec: ExecFn = async (cmd, args) => { calls.push({ cmd, args }); return ok(); };
    const driver = new SshRsyncDeployDriver(exec, () => STAGING_CFG_WITH_PATH);
    const res = await driver.deploy("staging", "/tmp/build/", { releaseId: "rel-test-1" });

    expect(res).toMatchObject({ ok: true, releaseId: "rel-test-1", remotePath: "/home/gaiada-fe/sites/acme/releases/rel-test-1" });
    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe("rsync");
    expect(calls[0].args).toEqual(
      expect.arrayContaining(["-az", "--delete", "/tmp/build/", "root@72.61.142.88:/home/gaiada-fe/sites/acme/releases/rel-test-1/"]),
    );
    // the rsync source keeps its trailing slash (copies CONTENTS, not a nested build/ dir)
    expect(calls[0].args).toContain("/tmp/build/");
    expect(calls[1].cmd).toBe("ssh");
    expect(calls[1].args.join(" ")).toContain("ln -sfn '/home/gaiada-fe/sites/acme/releases/rel-test-1' '/home/gaiada-fe/sites/acme/current'");
  });

  it("never swaps the symlink when rsync fails — the previous release stays live", async () => {
    let sshCalled = false;
    const exec: ExecFn = async (cmd) => {
      if (cmd === "ssh") sshCalled = true;
      return cmd === "rsync" ? fail(23, "rsync: some files/attrs were not transferred") : ok();
    };
    const driver = new SshRsyncDeployDriver(exec, () => STAGING_CFG_WITH_PATH);
    const res = await driver.deploy("staging", "/tmp/build", { releaseId: "rel-test-2" });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("rsync exited 23");
    expect(sshCalled).toBe(false); // the load-bearing assertion: no activation attempt after a failed transfer
  });

  it("reports the symlink-swap failure honestly and states the previous release is still live", async () => {
    const exec: ExecFn = async (cmd) => (cmd === "rsync" ? ok() : fail(1, "no such file or directory"));
    const driver = new SshRsyncDeployDriver(exec, () => STAGING_CFG_WITH_PATH);
    const res = await driver.deploy("staging", "/tmp/build", { releaseId: "rel-test-3" });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("current");
    expect(res.detail).toContain("PREVIOUS release is still live");
    expect(res.remotePath).toBe("/home/gaiada-fe/sites/acme/releases/rel-test-3");
  });

  it("mints a timestamp-derived releaseId when none is supplied", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue(ok());
    const driver = new SshRsyncDeployDriver(exec, () => STAGING_CFG_WITH_PATH);
    const res = await driver.deploy("staging", "/tmp/build");
    expect(res.releaseId).toMatch(/^rel-\d{4}-\d{2}-\d{2}T/);
  });
});

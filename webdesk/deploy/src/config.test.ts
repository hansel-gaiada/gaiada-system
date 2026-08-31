import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissingHostConfig, resolveHostConfig } from "./config";

const ENV_KEYS = [
  "DELPHI_SSH_HOST", "DELPHI_SSH_USER", "DELPHI_SSH_KEY_PATH", "DELPHI_SSH_PORT", "DELPHI_REMOTE_BASE_PATH",
  "HELIOS_SSH_HOST", "HELIOS_SSH_USER", "HELIOS_SSH_KEY_PATH", "HELIOS_SSH_PORT", "HELIOS_REMOTE_BASE_PATH",
  "DEPLOY_USE_SSH_ALIAS", "WEBDESK_DEPLOY_CONNECT_TIMEOUT_SEC",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe("resolveHostConfig", () => {
  it("fails closed with no vars and no alias opt-in — never guesses a host", () => {
    expect(() => resolveHostConfig("staging")).toThrow(MissingHostConfig);
    try {
      resolveHostConfig("staging");
    } catch (err) {
      expect((err as Error).message).toContain("DELPHI_SSH_HOST");
      expect((err as Error).message).toContain("DELPHI_SSH_USER");
    }
  });

  it("resolves production from explicit HELIOS_* vars", () => {
    process.env.HELIOS_SSH_HOST = "187.77.116.133";
    process.env.HELIOS_SSH_USER = "root";
    process.env.HELIOS_SSH_KEY_PATH = "/keys/helios";
    process.env.HELIOS_REMOTE_BASE_PATH = "/home/gaiada-fe/sites/example";
    const cfg = resolveHostConfig("production");
    expect(cfg).toMatchObject({
      target: "production",
      host: "187.77.116.133",
      sshUser: "root",
      sshKeyPath: "/keys/helios",
      remoteBasePath: "/home/gaiada-fe/sites/example",
    });
  });

  it("explicit vars win even when the alias opt-in is also set", () => {
    process.env.DEPLOY_USE_SSH_ALIAS = "1";
    process.env.DELPHI_SSH_HOST = "explicit-host";
    process.env.DELPHI_SSH_USER = "explicit-user";
    expect(resolveHostConfig("staging").host).toBe("explicit-host");
  });

  it("falls back to the ssh-config alias only when explicitly opted in", () => {
    process.env.DEPLOY_USE_SSH_ALIAS = "1";
    const cfg = resolveHostConfig("staging");
    expect(cfg.host).toBe("delphi");
    expect(cfg.sshUser).toBe(""); // carried by the alias's own ~/.ssh/config entry
  });

  it("does NOT fall back to the alias without the opt-in, even though the alias exists locally", () => {
    expect(() => resolveHostConfig("production")).toThrow(/HELIOS_SSH_HOST/);
  });

  it("remoteBasePath is optional — probe() must be callable before an account is provisioned", () => {
    process.env.DEPLOY_USE_SSH_ALIAS = "1";
    const cfg = resolveHostConfig("production");
    expect(cfg.remoteBasePath).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { config } from "./config";
import { saveCaptureToDrive, driveEnabled } from "./drive";

const DIR = "data/test-drive";

describe("governed Drive connector (5a.11 / D8.4)", () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    config.driveAuditFile = `${DIR}/drive-audit.jsonl`;
    config.driveAccessToken = "";
    config.driveFolderId = "";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is disabled (graceful no-op) until a token is configured", async () => {
    expect(driveEnabled()).toBe(false);
    const r = await saveCaptureToDrive("buy cement", "wamid-1");
    expect(r.saved).toBe(false);
    expect(r.reason).toContain("not configured");
  });

  it("uploads through the governed boundary with the bearer token and audits the write", async () => {
    config.driveAccessToken = "oauth-abc";
    config.driveFolderId = "folder-9";
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      expect(url).toContain("/upload/drive/v3/files");
      expect(init?.headers?.Authorization).toBe("Bearer oauth-abc");
      expect(init?.body).toContain("folder-9"); // parent folder in metadata
      expect(init?.body).toContain("buy cement");
      return { ok: true, json: async () => ({ id: "drive-file-1" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await saveCaptureToDrive("buy cement", "wamid-1");
    expect(r).toEqual({ saved: true, fileId: "drive-file-1" });

    const audit = readFileSync(config.driveAuditFile, "utf8").trim();
    expect(JSON.parse(audit)).toMatchObject({ action: "drive.save", owner: "wamid-1", ok: true, fileId: "drive-file-1" });
  });

  it("a Drive API failure is a graceful, audited non-fatal result", async () => {
    config.driveAccessToken = "oauth-abc";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })));
    const r = await saveCaptureToDrive("note", "wamid-2");
    expect(r.saved).toBe(false);
    expect(r.reason).toContain("403");
    expect(existsSync(config.driveAuditFile)).toBe(true);
  });

  it("the audit records the owner ref only — never additional PII", async () => {
    config.driveAccessToken = "oauth-abc";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ id: "f" }) })));
    await saveCaptureToDrive("my NIK is 3201150812001234", "wamid-3");
    const audit = readFileSync(config.driveAuditFile, "utf8");
    expect(audit).not.toContain("3201150812001234"); // capture body never enters the audit
  });
});

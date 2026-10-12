// WSK-19 — the driver level, against a REAL local HTTP server (no mocked `fetch`) plus the
// fail-closed-without-config contract every egress seam in this codebase shares.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebdevControlHttpDriver } from "./contract-fetch-http";
import { ContractControlNotConfiguredError, WebdevControlEgressError } from "./contract-fetch-provider";

const VALID_BUNDLE = {
  version: "1.0.0",
  vocabularyVersion: "1.2.0",
  blockLibrary: { package: "@gaiada/webdesk-blocks", version: "1.3.2", range: "^1.3" },
  artifacts: {
    sdkTsUrl: "http://SERVER/artifacts/sdk.ts.tgz",
    sdkPhpUrl: null,
    openapiUrl: "http://SERVER/artifacts/openapi.v1.json",
    contractMdUrl: "http://SERVER/artifacts/CONTENT-CONTRACT.md",
  },
  contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  generatedAt: "2026-08-27T00:00:00.000Z",
};

const GOOD_SHA = "0123456789abcdef".repeat(4);
/** M6-P4b0b - the `blockLibrarySha256` value a slug asks the fake far side to send (absent for a slug without `sha-`). */
const SHA_BY_SLUG: Record<string, unknown> = {
  "sha-valid": GOOD_SHA,
  "sha-null": null,
  "sha-upper": GOOD_SHA.toUpperCase(),
  "sha-short": GOOD_SHA.slice(0, 63),
  "sha-long": `${GOOD_SHA}0`,
  "sha-prefixed": `sha256:${GOOD_SHA}`,
  "sha-nothex": "g".repeat(64),
  "sha-empty": "",
  "sha-number": 12345,
};

let server: Server;
let origin: string;
let lastAuthHeader: string | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/control/v1/tenants/")) {
      lastAuthHeader = req.headers.authorization;
      if (req.url.includes("missing-slug")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      // M6-P4b0: blockLibraryUrl is sent only for a slug naming one, so the default bundle models an OLDER pointer
      // (the key is absent), and null-blocks models a far side that sends an explicit null.
      const blocks = req.url.includes("with-blocks")
        ? { blockLibraryUrl: `${origin}/artifacts/gaiada-webdesk-blocks-1.3.2.tgz` }
        : req.url.includes("null-blocks") ? { blockLibraryUrl: null } : {};
      const shaSlug = Object.keys(SHA_BY_SLUG).find((k) => req.url!.includes(`/${k}/`));
      const sha = shaSlug ? { blockLibrarySha256: SHA_BY_SLUG[shaSlug] } : {};
      res.end(JSON.stringify({
        ...VALID_BUNDLE,
        artifacts: {
          ...VALID_BUNDLE.artifacts,
          ...blocks,
          ...sha,
          sdkTsUrl: `${origin}/artifacts/sdk.ts.tgz`,
          openapiUrl: `${origin}/artifacts/openapi.v1.json`,
          contractMdUrl: `${origin}/artifacts/CONTENT-CONTRACT.md`,
        },
      }));
      return;
    }
    if (req.url === "/artifacts/sdk.ts.tgz") {
      res.writeHead(200);
      res.end("sdk-bytes");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("WSK-19 — WebdevControlHttpDriver", () => {
  it("getContractBundle: parses a valid bundle and attaches the bearer token", async () => {
    const driver = new WebdevControlHttpDriver({
      baseUrl: origin, bearerToken: "test-token-abc", timeoutMs: 2000, retryAttempts: 1, retryBaseDelayMs: 1,
    });
    const meta = await driver.getContractBundle("acme");
    expect(meta.version).toBe("1.0.0");
    expect(meta.artifacts.sdkPhpUrl).toBeNull();
    expect(lastAuthHeader).toBe("Bearer test-token-abc");
  });

  it("M6-P4b0 getContractBundle: blockLibraryUrl is null when the key is absent (older pointer) or null, and the URL when present", async () => {
    const driver = new WebdevControlHttpDriver({
      baseUrl: origin, bearerToken: "", timeoutMs: 2000, retryAttempts: 1, retryBaseDelayMs: 1,
    });
    expect((await driver.getContractBundle("acme")).artifacts.blockLibraryUrl).toBeNull();
    expect((await driver.getContractBundle("null-blocks")).artifacts.blockLibraryUrl).toBeNull();
    const withBlocks = await driver.getContractBundle("with-blocks");
    expect(withBlocks.artifacts.blockLibraryUrl).toBe(`${origin}/artifacts/gaiada-webdesk-blocks-1.3.2.tgz`);
    // The other four are parsed exactly as before.
    expect(withBlocks.artifacts.sdkPhpUrl).toBeNull();
    expect(withBlocks.artifacts.sdkTsUrl).toBe(`${origin}/artifacts/sdk.ts.tgz`);
  });

  describe("M6-P4b0b getContractBundle: artifacts.blockLibrarySha256", () => {
    const driver = () => new WebdevControlHttpDriver({
      baseUrl: origin, bearerToken: "", timeoutMs: 2000, retryAttempts: 1, retryBaseDelayMs: 1,
    });

    it("is null when the key is absent (an older WebDesk) and when it is an explicit null", async () => {
      expect((await driver().getContractBundle("acme")).artifacts.blockLibrarySha256).toBeNull();
      expect((await driver().getContractBundle("sha-null")).artifacts.blockLibrarySha256).toBeNull();
    });

    it("is the value when it is 64 lowercase hex, and the other artifacts parse as before", async () => {
      const meta = await driver().getContractBundle("sha-valid");
      expect(meta.artifacts.blockLibrarySha256).toBe(GOOD_SHA);
      expect(meta.artifacts.sdkTsUrl).toBe(`${origin}/artifacts/sdk.ts.tgz`);
      expect(meta.contentHash).toBe(VALID_BUNDLE.contentHash);
    });

    it.each(["sha-upper", "sha-short", "sha-long", "sha-prefixed", "sha-nothex", "sha-empty", "sha-number"])(
      "a malformed value (%s) is a protocol error, like any other malformed field: nothing half-parsed is passed on",
      async (slug) => {
        const err = await driver().getContractBundle(slug).then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(WebdevControlEgressError);
        expect((err as Error).message).toMatch(/unrecognized shape/);
      },
    );
  });

  it("downloadArtifact: returns the real bytes over a real socket", async () => {
    const driver = new WebdevControlHttpDriver({
      baseUrl: origin, bearerToken: "", timeoutMs: 2000, retryAttempts: 1, retryBaseDelayMs: 1,
    });
    const bytes = await driver.downloadArtifact(`${origin}/artifacts/sdk.ts.tgz`);
    expect(bytes.toString("utf8")).toBe("sdk-bytes");
  });

  it("getContractBundle: a non-200 (e.g. unknown slug) throws WebdevControlEgressError, not a silent null", async () => {
    const driver = new WebdevControlHttpDriver({
      baseUrl: origin, bearerToken: "", timeoutMs: 2000, retryAttempts: 1, retryBaseDelayMs: 1,
    });
    await expect(driver.getContractBundle("missing-slug")).rejects.toThrow(WebdevControlEgressError);
  });

  it("the token never appears in a thrown error message (redaction)", async () => {
    const driver = new WebdevControlHttpDriver({
      baseUrl: origin, bearerToken: "super-secret-token", timeoutMs: 2000, retryAttempts: 1, retryBaseDelayMs: 1,
    });
    try {
      await driver.getContractBundle("missing-slug");
      throw new Error("expected a throw");
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("super-secret-token");
    }
  });

  it("fail-closed: an empty baseUrl throws ContractControlNotConfiguredError, no default endpoint", () => {
    // `createWebdevControlHttpDriver()` (the production entrypoint) delegates this exact check to
    // the constructor — asserted directly here so the test does not depend on process.env timing
    // relative to config.ts's own module-load-time read.
    expect(() => new WebdevControlHttpDriver({ baseUrl: "", bearerToken: "", timeoutMs: 1, retryAttempts: 1, retryBaseDelayMs: 1 }))
      .toThrow(ContractControlNotConfiguredError);
  });
});

// M6-P4j (WSK-D81) -- the real-channel provider and its selector, against a FAKE `WebdeskControlClient` (no network,
// no database). The wire behaviour of the client itself (bodyBytes, the binary read) is in
// `../webdev/webdesk-control-client.test.ts`; the refresh through the snapshot service is in
// `contract-snapshot-via-webdesk-channel.db.test.ts`.
import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { config } from "../../config";
import {
  EditorialUnavailableError,
  WebdeskControlNotConfiguredError,
  WebdeskControlTokenError,
  WebdeskControlTransportError,
  type WebdeskControlResponse,
} from "../webdev/webdesk-control-client";
import { WebdeskChannelContractProvider, type ContractChannelClient } from "./contract-fetch-webdesk";
import { resolveContractControlProvider } from "./contract-control-provider";
import { WebdevControlHttpDriver } from "./contract-fetch-http";
import { ContractControlNotConfiguredError, WebdevControlEgressError } from "./contract-fetch-provider";

const TGZ = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08]), Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from([0xc3, 0x28, 0xff])]);
const BODIES: Record<string, Buffer> = {
  sdkTs: Buffer.from("export declare const sdk: unknown;\n"),
  sdkPhp: Buffer.from("<?php\nclass Sdk {}\n"),
  openapi: Buffer.from('{"openapi":"3.1.0"}'),
  contractMd: Buffer.from("# Content contract\n"),
  blockLibrary: TGZ,
};
const PRESIGN = "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef";
// URLs that name WebDesk's container-internal store, exactly as the live body does: unreachable from the ERP.
const url = (file: string, n = 1) => `http://rustfs:9000/artifacts/contracts/acme/1.0.0/${file}?n=${n}&${PRESIGN}`;

function bundle(over: { sdkPhpUrl?: string | null; blockLibraryUrl?: string | null; n?: number } = {}) {
  const n = over.n ?? 1;
  return {
    version: "1.0.0",
    vocabularyVersion: "1.5.0",
    blockLibrary: { package: "@gaiada/webdesk-blocks", version: "0.1.0", range: "^0.1.0" },
    artifacts: {
      sdkTsUrl: url("sdk.d.ts", n),
      sdkPhpUrl: over.sdkPhpUrl === undefined ? url("sdk.php", n) : over.sdkPhpUrl,
      openapiUrl: url("openapi.v1.json", n),
      contractMdUrl: url("CONTENT-CONTRACT.md", n),
      blockLibraryUrl: over.blockLibraryUrl === undefined ? `http://rustfs:9000/artifacts/blocks/0.1.0/x/lib.tgz?n=${n}&${PRESIGN}` : over.blockLibraryUrl,
      blockLibrarySha256: createHash("sha256").update(TGZ).digest("hex"),
    },
    contentHash: `sha256:${"a".repeat(64)}`, // the provider does not verify it; the snapshot service does
    generatedAt: "2026-10-13T00:00:00.000Z",
  };
}

const json = (status: number, body: unknown): WebdeskControlResponse => {
  const bodyText = JSON.stringify(body);
  return { status, contentType: "application/json", json: body, bodyText, bodyBytes: Buffer.from(bodyText) };
};
const bytes = (status: number, b: Buffer): WebdeskControlResponse => ({ status, contentType: "application/octet-stream", json: null, bodyText: b.toString("utf8"), bodyBytes: b });

interface Fake extends ContractChannelClient {
  contractCalls: string[];
  artifactCalls: Array<[string, string, string]>;
}

function fake(opts: {
  contract?: (slug: string) => Promise<WebdeskControlResponse>;
  artifact?: (slug: string, version: string, artifact: string) => Promise<WebdeskControlResponse>;
} = {}): Fake {
  const f = {
    contractCalls: [] as string[],
    artifactCalls: [] as Array<[string, string, string]>,
    getContract: async (slug: string) => {
      f.contractCalls.push(slug);
      return opts.contract ? opts.contract(slug) : json(200, bundle());
    },
    getContractArtifact: async (slug: string, version: string, artifact: string) => {
      f.artifactCalls.push([slug, version, artifact]);
      return opts.artifact ? opts.artifact(slug, version, artifact) : bytes(200, BODIES[artifact]);
    },
  };
  return f as unknown as Fake;
}

describe("WebdeskChannelContractProvider", () => {
  it("is keyed 'webdesk-control'", () => {
    expect(new WebdeskChannelContractProvider(fake()).key).toBe("webdesk-control");
  });

  describe("getContractBundle", () => {
    it("returns the validated bundle, URLs untouched", async () => {
      const f = fake();
      const meta = await new WebdeskChannelContractProvider(f).getContractBundle("acme");
      expect(f.contractCalls).toEqual(["acme"]);
      expect(meta.version).toBe("1.0.0");
      expect(meta.vocabularyVersion).toBe("1.5.0");
      expect(meta.artifacts.sdkTsUrl).toBe(url("sdk.d.ts"));
      expect(meta.artifacts.blockLibrarySha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it.each([
      [404, "returned 404"],
      [500, "returned 500"],
      [403, "returned 403"],
    ])("a %i answer is a WebdevControlEgressError saying 'returned %i' (the completion port matches 404 on that text)", async (status, text) => {
      const p = new WebdeskChannelContractProvider(fake({ contract: async () => json(status, { title: "nope" }) }));
      const err = await p.getContractBundle("acme").catch((e) => e);
      expect(err).toBeInstanceOf(WebdevControlEgressError);
      expect(err.message).toContain(text);
      expect(err.message).toContain("nope");
    });

    it("a non-JSON 200 and a wrong-shaped 200 are egress errors, not a half-populated bundle", async () => {
      const notJson = new WebdeskChannelContractProvider(fake({ contract: async () => ({ ...bytes(200, Buffer.from("<html>")), contentType: "text/html" }) }));
      await expect(notJson.getContractBundle("acme")).rejects.toThrow(/returned non-JSON/);
      const badShape = new WebdeskChannelContractProvider(fake({ contract: async () => json(200, { version: "1.0.0" }) }));
      await expect(badShape.getContractBundle("acme")).rejects.toThrow(/unrecognized shape/);
    });

    it("a malformed blockLibrarySha256 is refused by the SAME validator the stub uses", async () => {
      const b = bundle();
      b.artifacts.blockLibrarySha256 = "E".repeat(64);
      const p = new WebdeskChannelContractProvider(fake({ contract: async () => json(200, b) }));
      await expect(p.getContractBundle("acme")).rejects.toThrow(/unrecognized shape/);
    });
  });

  describe("client errors map to what the snapshot service and completion port already catch", () => {
    const cases: Array<[string, Error, new (...a: never[]) => Error]> = [
      ["not configured", new WebdeskControlNotConfiguredError(["WEBDESK_CONTROL_CA_FILE"]), ContractControlNotConfiguredError],
      ["transport", new WebdeskControlTransportError("webdesk-control contract.read failed after 3 attempt(s): ENOTFOUND", 3, false, "ENOTFOUND"), WebdevControlEgressError],
      ["token", new WebdeskControlTokenError(401, "token endpoint refused the client-credentials grant"), WebdevControlEgressError],
      ["breaker open", new EditorialUnavailableError(20_000), WebdevControlEgressError],
    ];

    it.each(cases)("%s, on the bundle read", async (_label, thrown, expected) => {
      const p = new WebdeskChannelContractProvider(fake({ contract: async () => { throw thrown; } }));
      const err = await p.getContractBundle("acme").catch((e) => e);
      expect(err).toBeInstanceOf(expected);
    });

    it.each(cases)("%s, on an artifact download", async (_label, thrown, expected) => {
      const f = fake({ artifact: async () => { throw thrown; } });
      const p = new WebdeskChannelContractProvider(f);
      const meta = await p.getContractBundle("acme");
      const err = await p.downloadArtifact(meta.artifacts.sdkTsUrl).catch((e) => e);
      expect(err).toBeInstanceOf(expected);
    });

    it("the egress message carries the client's credential-free text and never the token or the URL's signature", async () => {
      const p = new WebdeskChannelContractProvider(fake({ contract: async () => { throw new WebdeskControlTokenError(401, "token endpoint refused the client-credentials grant"); } }));
      const err = await p.getContractBundle("acme").catch((e) => e);
      expect(err.message).toContain("HTTP 401");
      expect(err.message).not.toContain(PRESIGN);
    });

    it("an unexpected error (a bug) is not swallowed into an egress error", async () => {
      const p = new WebdeskChannelContractProvider(fake({ contract: async () => { throw new TypeError("boom"); } }));
      await expect(p.getContractBundle("acme")).rejects.toThrow(TypeError);
    });
  });

  describe("downloadArtifact", () => {
    it("maps each returned URL to its own artifact and version, asks the channel (never the URL), and returns the bytes", async () => {
      const f = fake();
      const p = new WebdeskChannelContractProvider(f);
      const a = (await p.getContractBundle("acme")).artifacts;
      expect(await p.downloadArtifact(a.sdkTsUrl)).toEqual(BODIES.sdkTs);
      expect(await p.downloadArtifact(a.sdkPhpUrl!)).toEqual(BODIES.sdkPhp);
      expect(await p.downloadArtifact(a.openapiUrl)).toEqual(BODIES.openapi);
      expect(await p.downloadArtifact(a.contractMdUrl)).toEqual(BODIES.contractMd);
      expect(await p.downloadArtifact(a.blockLibraryUrl!)).toEqual(BODIES.blockLibrary);
      expect(f.artifactCalls).toEqual([
        ["acme", "1.0.0", "sdkTs"],
        ["acme", "1.0.0", "sdkPhp"],
        ["acme", "1.0.0", "openapi"],
        ["acme", "1.0.0", "contractMd"],
        ["acme", "1.0.0", "blockLibrary"],
      ]);
    });

    it("returns a binary (tgz-like) body byte-exact, not utf8-decoded", async () => {
      const p = new WebdeskChannelContractProvider(fake());
      const a = (await p.getContractBundle("acme")).artifacts;
      const got = await p.downloadArtifact(a.blockLibraryUrl!);
      expect(Buffer.isBuffer(got)).toBe(true);
      expect(Buffer.compare(got, TGZ)).toBe(0);
      expect(createHash("sha256").update(got).digest("hex")).toBe(a.blockLibrarySha256);
    });

    it("skips absent optional URLs (null sdkPhp / blockLibrary are not remembered or requested)", async () => {
      const f = fake({ contract: async () => json(200, bundle({ sdkPhpUrl: null, blockLibraryUrl: null })) });
      const p = new WebdeskChannelContractProvider(f);
      const a = (await p.getContractBundle("acme")).artifacts;
      expect(a.sdkPhpUrl).toBeNull();
      expect(a.blockLibraryUrl).toBeNull();
      await p.downloadArtifact(a.sdkTsUrl);
      expect(f.artifactCalls).toEqual([["acme", "1.0.0", "sdkTs"]]);
    });

    it("refuses a URL that is not from a bundle this provider fetched, without any I/O", async () => {
      const f = fake();
      const p = new WebdeskChannelContractProvider(f);
      for (const u of ["http://169.254.169.254/latest/meta-data", url("sdk.d.ts"), "", "not a url"]) {
        const err = await p.downloadArtifact(u).catch((e) => e);
        expect(err).toBeInstanceOf(WebdevControlEgressError);
        expect(err.message).toBe("artifact URL is not from a bundle this provider fetched");
      }
      expect(f.artifactCalls).toEqual([]);
      expect(f.contractCalls).toEqual([]);
      // ... and a URL of one provider instance means nothing to another.
      const other = new WebdeskChannelContractProvider(f);
      const a = (await p.getContractBundle("acme")).artifacts;
      await expect(other.downloadArtifact(a.sdkTsUrl)).rejects.toBeInstanceOf(WebdevControlEgressError);
    });

    it("remembers URLs from several bundles at once (a refresh and a console read can overlap)", async () => {
      let n = 0;
      const f = fake({ contract: async () => json(200, bundle({ n: ++n })) });
      const p = new WebdeskChannelContractProvider(f);
      const first = (await p.getContractBundle("acme")).artifacts;
      const second = (await p.getContractBundle("acme")).artifacts;
      expect(first.sdkTsUrl).not.toBe(second.sdkTsUrl);
      expect(await p.downloadArtifact(first.sdkTsUrl)).toEqual(BODIES.sdkTs);
      expect(await p.downloadArtifact(second.sdkTsUrl)).toEqual(BODIES.sdkTs);
    });

    it("does not keep URLs without bound", async () => {
      let n = 0;
      const f = fake({ contract: async () => json(200, bundle({ n: ++n })) });
      const p = new WebdeskChannelContractProvider(f);
      const first = (await p.getContractBundle("acme")).artifacts;
      for (let i = 0; i < 40; i++) await p.getContractBundle("acme"); // 41 bundles x 5 URLs > 128
      await expect(p.downloadArtifact(first.sdkTsUrl)).rejects.toThrow(/not from a bundle/);
    });

    it.each([404, 400, 500, 503])("a %i answer is an egress error that does not read as 'contract not published'", async (status) => {
      const f = fake({ artifact: async () => json(status, { title: "no" }) });
      const p = new WebdeskChannelContractProvider(f);
      const a = (await p.getContractBundle("acme")).artifacts;
      const err = await p.downloadArtifact(a.openapiUrl).catch((e) => e);
      expect(err).toBeInstanceOf(WebdevControlEgressError);
      expect(err.message).toContain(`answered HTTP ${status}`);
      expect(err.message).not.toMatch(/returned 404/);
    });

    it("a 2xx without raw bytes is an egress error, never a utf8 stand-in", async () => {
      const f = fake({ artifact: async () => ({ status: 200, contentType: "application/octet-stream", json: null, bodyText: "x" }) });
      const p = new WebdeskChannelContractProvider(f);
      const a = (await p.getContractBundle("acme")).artifacts;
      await expect(p.downloadArtifact(a.sdkTsUrl)).rejects.toThrow(/without a raw body/);
    });
  });
});

describe("resolveContractControlProvider (selector precedence)", () => {
  const saved = { webdesk: { ...config.webdeskControl }, stub: { ...config.webdevControl } };
  afterEach(() => {
    Object.assign(config.webdeskControl, saved.webdesk);
    Object.assign(config.webdevControl, saved.stub);
  });

  it("the real channel when WEBDESK_CONTROL_BASE_URL is set, even if the stub is configured too", () => {
    Object.assign(config.webdevControl, { baseUrl: "http://stub.invalid" });
    const p = resolveContractControlProvider({ webdeskBaseUrl: "https://control.example", client: fake() });
    expect(p).toBeInstanceOf(WebdeskChannelContractProvider);
    expect(p.key).toBe("webdesk-control");
  });

  it("reads config.webdeskControl.baseUrl by default", () => {
    Object.assign(config.webdeskControl, { baseUrl: "https://control.example" });
    expect(resolveContractControlProvider({ client: fake() })).toBeInstanceOf(WebdeskChannelContractProvider);
  });

  it("the bearer stub when only WEBDEV_CONTROL_BASE_URL is set (dev)", () => {
    Object.assign(config.webdeskControl, { baseUrl: "" });
    Object.assign(config.webdevControl, { baseUrl: "http://stub.invalid" });
    const p = resolveContractControlProvider();
    expect(p).toBeInstanceOf(WebdevControlHttpDriver);
    expect(p.key).toBe("webdev-control");
  });

  it("ContractControlNotConfiguredError when neither is set", () => {
    Object.assign(config.webdeskControl, { baseUrl: "" });
    Object.assign(config.webdevControl, { baseUrl: "" });
    expect(() => resolveContractControlProvider()).toThrow(ContractControlNotConfiguredError);
  });

  it("a real channel that is set but cannot be built is 'not configured' (with the reason), and does NOT fall back to the stub", () => {
    Object.assign(config.webdeskControl, { baseUrl: "https://control.example", clientSecret: "" });
    Object.assign(config.webdevControl, { baseUrl: "http://stub.invalid" });
    const err = (() => {
      try { resolveContractControlProvider(); } catch (e) { return e as Error; }
      return null;
    })();
    expect(err).toBeInstanceOf(ContractControlNotConfiguredError);
    expect(err!.message).toContain("WEBDESK_CONTROL");
  });
});

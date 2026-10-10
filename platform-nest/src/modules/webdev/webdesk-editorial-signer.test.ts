// WSK-40 — the ERP editorial-assertion signer (design §5; done-when 3 on this side).
//
//   * the three fixed vectors: the REAL signer (jose CompactSign) produces exactly the pinned bytes, and
//     jose verifies the pinned bytes with the public key. The SAME literal is pinned in
//     webdesk/api/test/editorial-assertion-vectors.spec.ts, where WebDesk's production verifier accepts
//     these bytes and WebDesk's independent node:crypto minter reproduces them;
//   * each request's `cmh` is THIS repo's computeCommandHash (webdesk-ws4-assertion.ts) over the args;
//   * input validation, config loading (absent / invalid → not configured, never a throw), custody, and
//     the keygen script end to end.
// No database, no network. Keys are generated inside the test; vector keys derive from public labels.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compactVerify, decodeProtectedHeader } from "jose";
import { config } from "../../config";
import { computeCommandHash } from "./webdesk-ws4-assertion";
import { setWebdeskApprovedCommandDepsForTests, type EditorialAssertionRequest } from "./webdesk-approved-command";
import {
  EditorialAssertionInputError,
  createWebdeskEditorialSigner,
  editorialClaimsFor,
  editorialPrivateKeyFromPem,
  loadWebdeskEditorialSigner,
  wireWebdeskEditorialSigner,
} from "./webdesk-editorial-signer";

// ── pinned (identical in webdesk/api/test/editorial-assertion-vectors.spec.ts) ──────────────────
const VECTORS = [
  {
    "name": "v1-human-create",
    "keyLabel": "wsk40-vector-key-a",
    "kid": "wde-vec-a",
    "x": "V6BcL1SNXUkuAZnXg_wB5CypXAe3bGCWyH6LprGhix4",
    "args": {
      "tenantSlug": "gaiada",
      "siteId": "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
      "collectionKey": "service",
      "locale": "en",
      "slug": "service.seo",
      "fields": {
        "url": "/services/seo/",
        "h1": "SEO Agency Bali",
        "faq": [
          {
            "key": "q1",
            "q": "How long?"
          }
        ]
      }
    },
    "request": {
      "sub": "user-0001",
      "pk": "human",
      "ten": "gaiada",
      "site": "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
      "cmd": "content.create",
      "cmh": "f547fce0dcdcc09fb92be3c0fab16e0cb06a100e5c2a6de68d9c00ba385aa95e"
    },
    "iat": 1760000000,
    "ttl": 60,
    "jti": "6f1c2e3d-4a4b-4c8d-9e7f-8091a2b3c4d5",
    "jws": "eyJhbGciOiJFZERTQSIsInR5cCI6IndkLWVkaXRvcmlhbCtqd3QiLCJraWQiOiJ3ZGUtdmVjLWEifQ.eyJpc3MiOiJ1cm46Z2FpYWRhOmVycDp3ZWJkZXYiLCJhdWQiOiJ1cm46Z2FpYWRhOndlYmRlc2s6Y29udHJvbCIsInN1YiI6InVzZXItMDAwMSIsInBrIjoiaHVtYW4iLCJ0ZW4iOiJnYWlhZGEiLCJzaXRlIjoiMGI2ZjFjMmUtM2Q0YS00YjVjLThkNmUtN2Y4MDkxYTJiM2M0IiwiY21kIjoiY29udGVudC5jcmVhdGUiLCJjbWgiOiJmNTQ3ZmNlMGRjZGNjMDlmYjkyYmUzYzBmYWIxNmUwY2IwNmExMDBlNWMyYTZkZTY4ZDljMDBiYTM4NWFhOTVlIiwiaWF0IjoxNzYwMDAwMDAwLCJleHAiOjE3NjAwMDAwNjAsImp0aSI6IjZmMWMyZTNkLTRhNGItNGM4ZC05ZTdmLTgwOTFhMmIzYzRkNSJ9.KvithROB8OshsZmKRk-Es9Ngi8chhg-VNyICdbnelfrKMJHg2u-jC_FrienVCWBFwP4dWZ_0_OvTl_tuLYtvAg"
  },
  {
    "name": "v2-agent-update-unicode",
    "keyLabel": "wsk40-vector-key-a",
    "kid": "wde-vec-a",
    "x": "V6BcL1SNXUkuAZnXg_wB5CypXAe3bGCWyH6LprGhix4",
    "args": {
      "tenantSlug": "gaiada",
      "siteId": "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
      "itemId": "2d3e4f5a-6b7c-4d8e-9f00-112233445566",
      "baseVersion": 3,
      "fields": {
        "h1": "Ünïcode ✓ — Bali 🌴",
        "body": "line1\nline2 \"quoted\""
      }
    },
    "request": {
      "sub": "user-0002",
      "pk": "agent",
      "agt": "webdev-writer",
      "ten": "gaiada",
      "site": "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
      "cmd": "content.update",
      "cmh": "5ce08f727416d2caee0539ff8a05399fe5ca097859be5c9268b8142ffd10fb2a"
    },
    "iat": 1760000123,
    "ttl": 60,
    "jti": "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3",
    "jws": "eyJhbGciOiJFZERTQSIsInR5cCI6IndkLWVkaXRvcmlhbCtqd3QiLCJraWQiOiJ3ZGUtdmVjLWEifQ.eyJpc3MiOiJ1cm46Z2FpYWRhOmVycDp3ZWJkZXYiLCJhdWQiOiJ1cm46Z2FpYWRhOndlYmRlc2s6Y29udHJvbCIsInN1YiI6InVzZXItMDAwMiIsInBrIjoiYWdlbnQiLCJhZ3QiOiJ3ZWJkZXYtd3JpdGVyIiwidGVuIjoiZ2FpYWRhIiwic2l0ZSI6IjBiNmYxYzJlLTNkNGEtNGI1Yy04ZDZlLTdmODA5MWEyYjNjNCIsImNtZCI6ImNvbnRlbnQudXBkYXRlIiwiY21oIjoiNWNlMDhmNzI3NDE2ZDJjYWVlMDUzOWZmOGEwNTM5OWZlNWNhMDk3ODU5YmU1YzkyNjhiODE0MmZmZDEwZmIyYSIsImlhdCI6MTc2MDAwMDEyMywiZXhwIjoxNzYwMDAwMTgzLCJqdGkiOiIwYTFiMmMzZC00ZTVmLTRhNmItOGM3ZC04ZTlmYTBiMWMyZDMifQ.e2ElPgSRMR5kOz_mcCBgcUoRBseQOIXbbf8KFBQO4XWgHpfrhX_BELLCZfarL9tdKPb1k6uczK_oX2iNTl3XDw"
  },
  {
    "name": "v3-approved-publish",
    "keyLabel": "wsk40-vector-key-b",
    "kid": "wde-vec-b",
    "x": "UfGlTzoKO46nTnYXHNneARpGOUj_gzL0t5CjMTTzzYE",
    "args": {
      "tenantSlug": "gaiada",
      "siteId": "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
      "items": [
        {
          "itemId": "3e4f5a6b-7c8d-4e9f-a011-223344556677",
          "version": 2
        },
        {
          "itemId": "4f5a6b7c-8d9e-4fa0-b122-334455667788",
          "version": 1
        }
      ]
    },
    "request": {
      "sub": "user-0003",
      "pk": "human",
      "req": "user-0001",
      "apr": "7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5",
      "ten": "gaiada",
      "site": "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
      "cmd": "content.publish",
      "cmh": "fbc72efcc1fb317da194bcbe14a34e7b0eb571bf0bbe803dcee90c5a8a12c504"
    },
    "iat": 1760000456,
    "ttl": 60,
    "jti": "5b6c7d8e-9fa0-4b1c-9d2e-3f405162738a",
    "jws": "eyJhbGciOiJFZERTQSIsInR5cCI6IndkLWVkaXRvcmlhbCtqd3QiLCJraWQiOiJ3ZGUtdmVjLWIifQ.eyJpc3MiOiJ1cm46Z2FpYWRhOmVycDp3ZWJkZXYiLCJhdWQiOiJ1cm46Z2FpYWRhOndlYmRlc2s6Y29udHJvbCIsInN1YiI6InVzZXItMDAwMyIsInBrIjoiaHVtYW4iLCJ0ZW4iOiJnYWlhZGEiLCJzaXRlIjoiMGI2ZjFjMmUtM2Q0YS00YjVjLThkNmUtN2Y4MDkxYTJiM2M0IiwiY21kIjoiY29udGVudC5wdWJsaXNoIiwiY21oIjoiZmJjNzJlZmNjMWZiMzE3ZGExOTRiY2JlMTRhMzRlN2IwZWI1NzFiZjBiYmU4MDNkY2VlOTBjNWE4YTEyYzUwNCIsInJlcSI6InVzZXItMDAwMSIsImFwciI6IjdjMWQyZTNmLTRhNWItNGM2ZC04ZTdmLTkwYTFiMmMzZDRlNSIsImlhdCI6MTc2MDAwMDQ1NiwiZXhwIjoxNzYwMDAwNTE2LCJqdGkiOiI1YjZjN2Q4ZS05ZmEwLTRiMWMtOWQyZS0zZjQwNTE2MjczOGEifQ.jqeW5Qf1OaI6JQvDhZDeWJxEd36rHmKrtPlQTvcPEoULk-xaAmyp8PjC0TChtl5GYh8NOpQ-5HGKrv5Wm4B1Bg"
  }
] as const;
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** The deterministic vector key for `label` (seed = sha256(label)). Test vectors only. */
function vectorKey(label: string) {
  const seed = createHash("sha256").update(label).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

const KEYGEN = resolve(__dirname, "../../../scripts/webdesk-editorial-keygen.mjs");

describe("WSK-40 editorial signer — the three shared vectors", () => {
  for (const v of VECTORS) {
    describe(v.name, () => {
      const { privateKey, publicKey } = vectorKey(v.keyLabel);

      it("the derived public key equals the pinned x", () => {
        expect(publicKey.export({ format: "jwk" }).x).toBe(v.x);
      });

      it("cmh is the ERP's computeCommandHash over the args (the WS4 canonicalisation)", () => {
        expect(computeCommandHash(v.request.cmd, v.args)).toBe(v.request.cmh);
      });

      it("the REAL signer produces the pinned bytes from (key, input)", async () => {
        const signer = createWebdeskEditorialSigner({ privateKey, kid: v.kid, ttlSec: v.ttl, now: () => v.iat, newJti: () => v.jti });
        expect(await signer.sign(v.request as unknown as EditorialAssertionRequest)).toBe(v.jws);
      });

      it("the pinned bytes (also what WebDesk's own minter emits) verify with jose and the public key", async () => {
        const { payload, protectedHeader } = await compactVerify(v.jws, publicKey, { algorithms: ["EdDSA"] });
        expect(protectedHeader).toEqual({ alg: "EdDSA", typ: "wd-editorial+jwt", kid: v.kid });
        expect(JSON.parse(Buffer.from(payload).toString("utf8"))).toEqual({
          iss: "urn:gaiada:erp:webdev",
          aud: "urn:gaiada:webdesk:control",
          ...v.request,
          iat: v.iat,
          exp: v.iat + v.ttl,
          jti: v.jti,
        });
      });
    });
  }
});

describe("WSK-40 editorial signer — behaviour", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const base: EditorialAssertionRequest = {
    sub: "user-1",
    pk: "human",
    ten: "gaiada",
    site: "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
    cmd: "content.publish",
    cmh: "a".repeat(64),
    req: "user-2",
    apr: "apr-1",
  };

  it("adds iss/aud/iat/exp(+60 s)/a fresh UUID v4 jti, header typ wd-editorial+jwt + kid", async () => {
    const signer = createWebdeskEditorialSigner({ privateKey, kid: "wde-t", now: () => 1_800_000_000 });
    const a = await signer.sign(base);
    const b = await signer.sign(base);
    expect(decodeProtectedHeader(a)).toEqual({ alg: "EdDSA", typ: "wd-editorial+jwt", kid: "wde-t" });
    const pa = JSON.parse(Buffer.from(a.split(".")[1], "base64url").toString());
    const pb = JSON.parse(Buffer.from(b.split(".")[1], "base64url").toString());
    expect(pa).toMatchObject({ iss: "urn:gaiada:erp:webdev", aud: "urn:gaiada:webdesk:control", iat: 1_800_000_000, exp: 1_800_000_060 });
    expect(pa.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(pa.jti).not.toBe(pb.jti); // single-use on WebDesk: every assertion is fresh
    expect(Object.keys(pa)).toEqual(["iss", "aud", "sub", "pk", "ten", "site", "cmd", "cmh", "req", "apr", "iat", "exp", "jti"]);
  });

  const bad: Array<[string, Partial<EditorialAssertionRequest> & Record<string, unknown>]> = [
    ["empty sub", { sub: "" }],
    ["unknown pk", { pk: "robot" as never }],
    ["agent without agt", { pk: "agent" }],
    ["agt without agent", { agt: "x" }],
    ["upper-case cmh", { cmh: "A".repeat(64) }],
    ["short cmh", { cmh: "a".repeat(63) }],
    ["empty apr", { apr: "" }],
    ["over-long ten", { ten: "t".repeat(201) }],
  ];
  for (const [name, over] of bad) {
    it(`refuses to sign: ${name}`, async () => {
      const signer = createWebdeskEditorialSigner({ privateKey, kid: "wde-t" });
      await expect(signer.sign({ ...base, ...over } as EditorialAssertionRequest)).rejects.toBeInstanceOf(EditorialAssertionInputError);
    });
  }

  it("refuses a TTL WebDesk would reject (> 120 s) and a non-Ed25519 key, at construction", () => {
    expect(() => createWebdeskEditorialSigner({ privateKey, kid: "wde-t", ttlSec: 121 })).toThrow(/ttl/);
    expect(() => editorialClaimsFor(base, 1, 121, "j")).toThrow(EditorialAssertionInputError);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(() => createWebdeskEditorialSigner({ privateKey: rsa, kid: "wde-t" })).toThrow(/Ed25519/);
    expect(() => createWebdeskEditorialSigner({ privateKey, kid: "bad kid" })).toThrow(/kid/);
  });

  it("custody: JSON.stringify and util.inspect of the signer reveal no key material", async () => {
    const signer = createWebdeskEditorialSigner({ privateKey, kid: "wde-t" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const d = privateKey.export({ format: "jwk" }).d as string;
    for (const text of [JSON.stringify(signer), inspect(signer, { depth: 10, showHidden: true })]) {
      expect(text).not.toContain(d);
      expect(text).not.toContain(pem.split("\n")[1]);
    }
    expect(JSON.parse(JSON.stringify(signer))).toEqual({ configured: true, kid: "wde-t" });
  });
});

describe("WSK-40 editorial signer — config loading (absent/invalid → not configured, never a throw)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wsk40-signer-"));
  });
  afterAll(() => {
    setWebdeskApprovedCommandDepsForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  function keyFile(name: string, pem: string): string {
    const f = join(dir, name);
    writeFileSync(f, pem, { mode: 0o400 });
    return f;
  }

  it("unset file or kid → not configured", () => {
    expect(loadWebdeskEditorialSigner({ keyFile: "", kid: "k" })).toMatchObject({ state: "not-configured", reason: expect.stringMatching(/KEY_FILE is not set/) });
    expect(loadWebdeskEditorialSigner({ keyFile: "/x", kid: "" })).toMatchObject({ state: "not-configured", reason: expect.stringMatching(/KID is not set/) });
  });

  it("a missing file, a directory, a truncated PEM, an RSA key, a public key → not configured, each with a reason and no key bytes", () => {
    const ed = generateKeyPairSync("ed25519");
    const goodPem = ed.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const cases: Array<[string, RegExp]> = [
      [join(dir, "missing.pem"), /cannot be read \(ENOENT\)/],
      [dir, /not a regular file/],
      [keyFile("trunc.pem", goodPem.slice(0, 40)), /not a complete PKCS8 PEM/],
      [keyFile("rsa.pem", generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string), /rsa key; the editorial key must be Ed25519/],
      [keyFile("pub.pem", ed.publicKey.export({ type: "spki", format: "pem" }) as string), /not a complete PKCS8 PEM/],
    ];
    for (const [file, re] of cases) {
      const r = loadWebdeskEditorialSigner({ keyFile: file, kid: "wde-t", ttlSec: 60 });
      expect(r.state, file).toBe("not-configured");
      if (r.state === "not-configured") {
        expect(r.reason).toMatch(re);
        expect(r.reason).not.toContain(goodPem.split("\n")[1]);
      }
    }
    expect(loadWebdeskEditorialSigner({ keyFile: keyFile("ok-ttl.pem", goodPem), kid: "wde-t", ttlSec: 121 })).toMatchObject({ state: "not-configured", reason: expect.stringMatching(/ttl/) });
  });

  it("editorialPrivateKeyFromPem never echoes the PEM in its error", () => {
    const pem = (generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string).replace("MC4CAQ", "MC4CAX");
    let message = "";
    try {
      editorialPrivateKeyFromPem(pem, "SRC");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("SRC");
    expect(message).not.toContain(pem.split("\n")[1]);
  });

  it("wireWebdeskEditorialSigner: registers the signer from config when the key file is present; logs why when absent", () => {
    const saved = { ...config.webdeskEditorial };
    const logger = { log: vi.fn(), warn: vi.fn() };
    try {
      const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
      Object.assign(config.webdeskEditorial, { signingKeyFile: keyFile("wire.pem", pem), signingKid: "wde-wire", ttlSec: 60 });
      expect(wireWebdeskEditorialSigner(logger).state).toBe("configured");
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("kid wde-wire"));
      Object.assign(config.webdeskEditorial, { signingKeyFile: join(dir, "absent.pem") });
      expect(wireWebdeskEditorialSigner(logger).state).toBe("not-configured");
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("NOT configured"));
    } finally {
      Object.assign(config.webdeskEditorial, saved);
      setWebdeskApprovedCommandDepsForTests(null);
    }
  });
});

describe("WSK-40 keygen script (scripts/webdesk-editorial-keygen.mjs)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wsk40-keygen-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (...args: string[]) => execFileSync(process.execPath, [KEYGEN, ...args], { encoding: "utf8", stdio: "pipe" });
  /** Runs a command that must FAIL; returns its stderr. */
  const runFail = (...args: string[]): string => {
    try {
      run(...args);
    } catch (e) {
      return String((e as { stderr?: unknown }).stderr ?? "");
    }
    throw new Error(`expected failure: ${args.join(" ")}`);
  };

  it("generate → a 0400 PKCS8 key the signer loads, a JWKS whose key verifies its signatures; stdout carries no secret", async () => {
    const out = run("generate", "--kid", "wde-gen-1", "--out", dir);
    expect(out).not.toMatch(/PRIVATE KEY|"d"/);
    const keyPath = join(dir, "editorial-signing.wde-gen-1.pk8.pem");
    const jwksPath = join(dir, "editorial.jwks.json");
    if (process.platform !== "win32") expect(statSync(keyPath).mode & 0o777).toBe(0o400);
    const jwks = JSON.parse(readFileSync(jwksPath, "utf8"));
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", kid: "wde-gen-1", use: "sig", alg: "EdDSA" });
    expect(jwks.keys[0].d).toBeUndefined();

    const loaded = loadWebdeskEditorialSigner({ keyFile: keyPath, kid: "wde-gen-1", ttlSec: 60 });
    expect(loaded.state).toBe("configured");
    if (loaded.state !== "configured") return;
    const jws = await loaded.signer.sign({ sub: "u", pk: "human", ten: "t", site: "s", cmd: "content.publish", cmh: "b".repeat(64), apr: "a" });
    const pub = createPublicKey({ key: jwks.keys[0], format: "jwk" });
    await expect(compactVerify(jws, pub, { algorithms: ["EdDSA"] })).resolves.toBeTruthy();
  });

  it("rotation helpers: append kid N+1 (2 keys max), refuse a 3rd, remove kid N, refuse an empty set; never overwrites", () => {
    const d2 = join(dir, "n1");
    mkdirSync(d2, { recursive: true });
    const first = join(dir, "editorial.jwks.json");
    const out = JSON.parse(run("generate", "--kid", "wde-gen-2", "--out", d2, "--jwks", first));
    expect(out.jwksKids).toEqual(["wde-gen-1", "wde-gen-2"]);
    const overlap = join(d2, "editorial.jwks.json");
    expect(runFail("generate", "--kid", "wde-gen-3", "--out", join(dir, "n3"), "--jwks", overlap)).toMatch(/at most 2/);
    const removedPath = join(dir, "after-removal.json");
    const removed = JSON.parse(run("remove", "--jwks", overlap, "--kid", "wde-gen-1", "--out", removedPath));
    expect(removed.jwksKids).toEqual(["wde-gen-2"]);
    expect(runFail("remove", "--jwks", removedPath, "--kid", "wde-gen-2", "--out", join(dir, "empty.json"))).toMatch(/empty key set/);
    expect(existsSync(join(dir, "empty.json"))).toBe(false);
    // Refuses to overwrite an existing key file.
    expect(runFail("generate", "--kid", "wde-gen-1", "--out", dir)).toMatch(/already exists/);
    const inspected = JSON.parse(run("inspect", "--jwks", removedPath));
    expect(inspected.keys.map((k: { kid: string }) => k.kid)).toEqual(["wde-gen-2"]);
    // A JWKS carrying private material is refused outright.
    const leaky = join(dir, "leaky.json");
    const ed = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    writeFileSync(leaky, JSON.stringify({ keys: [{ ...ed, kid: "leak" }] }));
    chmodSync(leaky, 0o600);
    expect(runFail("inspect", "--jwks", leaky)).toMatch(/private material/);
  });
});

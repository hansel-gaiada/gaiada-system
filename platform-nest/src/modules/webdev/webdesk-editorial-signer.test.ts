// WSK-40 — the ERP editorial-assertion signer (design §5; done-when 3 on this side).
//
//   * the four fixed vectors (v4, WSK-49c: the client-editor `ce` claim): the REAL signer (jose CompactSign) produces exactly the pinned bytes, and
//     jose verifies the pinned bytes with the public key. The SAME literal is pinned in
//     webdesk/api/test/editorial-assertion-vectors.spec.ts, where WebDesk's production verifier accepts
//     these bytes and WebDesk's independent node:crypto minter reproduces them;
//   * each request's `cmh` is THIS repo's computeCommandHash (webdesk-ws4-assertion.ts) over the args;
//   * input validation, config loading (absent / invalid → not configured, never a throw), custody, and
//     the keygen script end to end.
// No database, no network. Keys are generated inside the test; vector keys derive from public labels.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  },
  {
    "name": "v4-client-editor-update",
    "keyLabel": "wsk40-vector-key-a",
    "kid": "wde-vec-a",
    "x": "V6BcL1SNXUkuAZnXg_wB5CypXAe3bGCWyH6LprGhix4",
    "args": {
      "tenantSlug": "gaiada",
      "siteId": "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
      "itemId": "6a7b8c9d-0e1f-4a2b-8c3d-4e5f60718293",
      "baseVersion": 4,
      "fields": {
        "h1": "Client-edited headline"
      }
    },
    "request": {
      "sub": "user-0004",
      "pk": "human",
      "ten": "gaiada",
      "site": "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
      "cmd": "content.update",
      "cmh": "ffbf9280bd1384820d05c4d3a5567e79245a9944c6772cdb10147f7922db267b",
      "ce": true
    },
    "iat": 1760000789,
    "ttl": 60,
    "jti": "8c9d0e1f-2a3b-4c4d-8e5f-60718293a4b5",
    "jws": "eyJhbGciOiJFZERTQSIsInR5cCI6IndkLWVkaXRvcmlhbCtqd3QiLCJraWQiOiJ3ZGUtdmVjLWEifQ.eyJpc3MiOiJ1cm46Z2FpYWRhOmVycDp3ZWJkZXYiLCJhdWQiOiJ1cm46Z2FpYWRhOndlYmRlc2s6Y29udHJvbCIsInN1YiI6InVzZXItMDAwNCIsInBrIjoiaHVtYW4iLCJ0ZW4iOiJnYWlhZGEiLCJzaXRlIjoiMGI2ZjFjMmUtM2Q0YS00YjVjLThkNmUtN2Y4MDkxYTJiM2M0IiwiY21kIjoiY29udGVudC51cGRhdGUiLCJjbWgiOiJmZmJmOTI4MGJkMTM4NDgyMGQwNWM0ZDNhNTU2N2U3OTI0NWE5OTQ0YzY3NzJjZGIxMDE0N2Y3OTIyZGIyNjdiIiwiY2UiOnRydWUsImlhdCI6MTc2MDAwMDc4OSwiZXhwIjoxNzYwMDAwODQ5LCJqdGkiOiI4YzlkMGUxZi0yYTNiLTRjNGQtOGU1Zi02MDcxODI5M2E0YjUifQ.cKb63ELZA-WcUOAndBbxXi6L1ubBCNSX8mEhzqmoXEfvPkF0avtW-g3w9qizv_kXt7Har-pIx53AOkbpRos0Cw"
  },
  {
    "name": "v5-contributor-update",
    "keyLabel": "wsk40-vector-key-a",
    "kid": "wde-vec-a",
    "x": "V6BcL1SNXUkuAZnXg_wB5CypXAe3bGCWyH6LprGhix4",
    "args": {
      "tenantSlug": "gaiada",
      "siteId": "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
      "itemId": "6a7b8c9d-0e1f-4a2b-8c3d-4e5f60718293",
      "baseVersion": 4,
      "fields": {
        "h1": "Client-edited headline"
      }
    },
    "request": {
      "sub": "user-0005",
      "pk": "human",
      "ten": "gaiada",
      "site": "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
      "cmd": "content.update",
      "cmh": "ffbf9280bd1384820d05c4d3a5567e79245a9944c6772cdb10147f7922db267b",
      "xc": true
    },
    "iat": 1760001122,
    "ttl": 60,
    "jti": "9d0e1f2a-3b4c-4d5e-9f60-718293a4b5c6",
    "jws": "eyJhbGciOiJFZERTQSIsInR5cCI6IndkLWVkaXRvcmlhbCtqd3QiLCJraWQiOiJ3ZGUtdmVjLWEifQ.eyJpc3MiOiJ1cm46Z2FpYWRhOmVycDp3ZWJkZXYiLCJhdWQiOiJ1cm46Z2FpYWRhOndlYmRlc2s6Y29udHJvbCIsInN1YiI6InVzZXItMDAwNSIsInBrIjoiaHVtYW4iLCJ0ZW4iOiJnYWlhZGEiLCJzaXRlIjoiMGI2ZjFjMmUtM2Q0YS00YjVjLThkNmUtN2Y4MDkxYTJiM2M0IiwiY21kIjoiY29udGVudC51cGRhdGUiLCJjbWgiOiJmZmJmOTI4MGJkMTM4NDgyMGQwNWM0ZDNhNTU2N2U3OTI0NWE5OTQ0YzY3NzJjZGIxMDE0N2Y3OTIyZGIyNjdiIiwieGMiOnRydWUsImlhdCI6MTc2MDAwMTEyMiwiZXhwIjoxNzYwMDAxMTgyLCJqdGkiOiI5ZDBlMWYyYS0zYjRjLTRkNWUtOWY2MC03MTgyOTNhNGI1YzYifQ.2tfk6aMXcL3jXhzorsuyhI3m1tFVcbVuz0GnopbTjkOjJ3KdQn8Et-Z_H9wh7ZA2h-m9wl5Q3hiVTqZKYMOQCA"
  }
] as const;
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** M5-W1e: the assembled principal the signer reads `kind` from. */
const EMPLOYEE = { kind: "employee" } as const;

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** The deterministic vector key for `label` (seed = sha256(label)). Test vectors only. */
function vectorKey(label: string) {
  const seed = createHash("sha256").update(label).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

const KEYGEN = resolve(__dirname, "../../../scripts/webdesk-editorial-keygen.mjs");

describe("WSK-40 editorial signer — the five shared vectors (v4 = the client-editor `ce` claim, WSK-49c; v5 = the contributor `xc` claim, M5-W1e)", () => {
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
        // M5-W1e: `xc` is not part of the request: the signer derives it from the principal's kind (v5 is a contributor's).
        const { xc, ...input } = v.request as unknown as EditorialAssertionRequest & { xc?: true };
        expect(await signer.sign(input, { kind: xc ? "contributor" : "employee" })).toBe(v.jws);
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
    const a = await signer.sign(base, EMPLOYEE);
    const b = await signer.sign(base, EMPLOYEE);
    expect(decodeProtectedHeader(a)).toEqual({ alg: "EdDSA", typ: "wd-editorial+jwt", kid: "wde-t" });
    const pa = JSON.parse(Buffer.from(a.split(".")[1], "base64url").toString());
    const pb = JSON.parse(Buffer.from(b.split(".")[1], "base64url").toString());
    expect(pa).toMatchObject({ iss: "urn:gaiada:erp:webdev", aud: "urn:gaiada:webdesk:control", iat: 1_800_000_000, exp: 1_800_000_060 });
    expect(pa.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(pa.jti).not.toBe(pb.jti); // single-use on WebDesk: every assertion is fresh
    expect(Object.keys(pa)).toEqual(["iss", "aud", "sub", "pk", "ten", "site", "cmd", "cmh", "req", "apr", "iat", "exp", "jti"]);
  });

  describe("WSK-49c — the client-editor marker `ce`", () => {
    const iat = 1_800_000_000;
    const jti = "6f1c2e3d-4a4b-4c8d-9e7f-8091a2b3c4d5";
    const wire = (input: EditorialAssertionRequest) => editorialClaimsFor(input, iat, 60, jti, EMPLOYEE);

    it("a STAFF assertion is exactly what it was before WSK-49: no `ce` key, whatever else it carries", () => {
      expect(Object.keys(wire(base))).toEqual(["iss", "aud", "sub", "pk", "ten", "site", "cmd", "cmh", "req", "apr", "iat", "exp", "jti"]);
      expect(Object.keys(wire(base))).not.toContain("ce");
      const { ce: _no, ...noCe } = { ...base } as EditorialAssertionRequest & { ce?: true };
      void _no;
      expect(JSON.stringify(wire(noCe))).toBe(JSON.stringify(wire(base)));
    });

    it("a client assertion carries `ce: true` BETWEEN `apr` and `iat` (the position WebDesk's vector v4 pins)", () => {
      expect(Object.keys(wire({ ...base, ce: true }))).toEqual(["iss", "aud", "sub", "pk", "ten", "site", "cmd", "cmh", "req", "apr", "ce", "iat", "exp", "jti"]);
      // and without `req`/`apr` (an immediate MEDIUM write): ce follows cmh
      const { req: _r, apr: _a, ...medium } = base;
      void [_r, _a];
      expect(Object.keys(wire({ ...medium, cmd: "content.update", ce: true }))).toEqual(["iss", "aud", "sub", "pk", "ten", "site", "cmd", "cmh", "ce", "iat", "exp", "jti"]);
      expect(wire({ ...base, ce: true }).ce).toBe(true);
    });

    it("refuses to sign a `ce` that is not literally true (never coerced, never `false`, never a string)", () => {
      for (const ce of [false, "true", 1, null] as unknown[]) {
        expect(() => wire({ ...base, ce } as unknown as EditorialAssertionRequest)).toThrow(EditorialAssertionInputError);
      }
    });

    it("signs a client assertion that jose verifies and whose payload says ce:true; a staff one verifies with no ce", async () => {
      const { privateKey: k, publicKey } = generateKeyPairSync("ed25519");
      const signer = createWebdeskEditorialSigner({ privateKey: k, kid: "wde-ce", now: () => iat });
      const client = await signer.sign({ ...base, ce: true }, EMPLOYEE);
      const staff = await signer.sign(base, EMPLOYEE);
      const cp = JSON.parse(Buffer.from((await compactVerify(client, publicKey, { algorithms: ["EdDSA"] })).payload).toString("utf8"));
      const sp = JSON.parse(Buffer.from((await compactVerify(staff, publicKey, { algorithms: ["EdDSA"] })).payload).toString("utf8"));
      expect(cp.ce).toBe(true);
      expect("ce" in sp).toBe(false);
      // the marker is covered by the signature: stripping it from the client token breaks verification
      const [h, , sig] = client.split(".");
      const stripped = `${h}.${Buffer.from(JSON.stringify({ ...cp, ce: undefined })).toString("base64url")}.${sig}`;
      await expect(compactVerify(stripped, publicKey, { algorithms: ["EdDSA"] })).rejects.toThrow();
    });
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
      await expect(signer.sign({ ...base, ...over } as EditorialAssertionRequest, EMPLOYEE)).rejects.toBeInstanceOf(EditorialAssertionInputError);
    });
  }

  it("refuses a TTL WebDesk would reject (> 120 s) and a non-Ed25519 key, at construction", () => {
    expect(() => createWebdeskEditorialSigner({ privateKey, kid: "wde-t", ttlSec: 121 })).toThrow(/ttl/);
    expect(() => editorialClaimsFor(base, 1, 121, "j", EMPLOYEE)).toThrow(EditorialAssertionInputError);
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

describe("M5-W1e — the contributor marker `xc` (decided from the assembled principal's kind, never from input)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const iat = 1_800_000_000;
  const jti = "6f1c2e3d-4a4b-4c8d-9e7f-8091a2b3c4d5";
  const medium: EditorialAssertionRequest = {
    sub: "user-1",
    pk: "human",
    ten: "gaiada",
    site: "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
    cmd: "content.update",
    cmh: "a".repeat(64),
  };
  const CONTRIBUTOR = { kind: "contributor" } as const;
  const wire = (input: EditorialAssertionRequest, principal: { kind?: string }) =>
    editorialClaimsFor(input, iat, 60, jti, principal as Parameters<typeof editorialClaimsFor>[4]);
  const payloadOf = async (jws: string) => JSON.parse(Buffer.from((await compactVerify(jws, publicKey, { algorithms: ["EdDSA"] })).payload).toString("utf8"));
  const productionSources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return productionSources(p);
      return e.name.endsWith(".ts") && !/\.test\.ts$/.test(e.name) && !e.name.includes("testkit") ? [p] : [];
    });
  const codeOnly = (src: string): string => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("a contributor's assertion carries `xc: true` BETWEEN `ce` and `iat`, with or without req/apr", () => {
    expect(Object.keys(wire(medium, CONTRIBUTOR))).toEqual(["iss", "aud", "sub", "pk", "ten", "site", "cmd", "cmh", "xc", "iat", "exp", "jti"]);
    expect(Object.keys(wire({ ...medium, req: "user-2", apr: "apr-1" }, CONTRIBUTOR))).toEqual([
      "iss", "aud", "sub", "pk", "ten", "site", "cmd", "cmh", "req", "apr", "xc", "iat", "exp", "jti",
    ]);
    expect(wire(medium, CONTRIBUTOR).xc).toBe(true);
  });

  it("every other kind (employee, client, automation, bot) and an absent kind: `xc` is ABSENT, never false, and the bytes are what they were before W1e", () => {
    const before = JSON.stringify(wire(medium, { kind: "employee" }));
    for (const kind of ["employee", "client", "automation", "bot", undefined]) {
      const c = wire(medium, { kind });
      expect(Object.keys(c), String(kind)).not.toContain("xc");
      expect(JSON.stringify(c), String(kind)).toBe(before);
    }
    expect(before).not.toContain("xc");
  });

  it("a contributor is never a client editor: `ce: true` together with a contributor principal is refused at signing", () => {
    expect(() => wire({ ...medium, ce: true }, CONTRIBUTOR)).toThrow(EditorialAssertionInputError);
  });

  it("no input path sets it: an `xc` smuggled into the request (any value) is never copied, for an employee or a client", () => {
    for (const smuggled of [true, false, "true", 1, null, {}, []]) {
      for (const principal of [{ kind: "employee" }, { kind: "client" }, {}]) {
        const claims = wire({ ...medium, xc: smuggled } as unknown as EditorialAssertionRequest, principal);
        expect(Object.keys(claims), JSON.stringify(smuggled)).not.toContain("xc");
      }
    }
  });

  it("no input path sets it: an `xc` (or `contributor`) on the PRINCIPAL object is ignored; only `kind` counts", () => {
    for (const forged of [{ kind: "employee", xc: true }, { kind: "employee", contributor: true }, { xc: true }, { kind: "Contributor" }, { kind: " contributor" }]) {
      expect(Object.keys(wire(medium, forged)), JSON.stringify(forged)).not.toContain("xc");
    }
  });

  it("structural: the signer's public surface has no parameter that can carry `xc`", () => {
    const signer = createWebdeskEditorialSigner({ privateKey, kid: "wde-xc" });
    // sign(input, principal): the request and the assembled principal, nothing else
    expect(signer.sign.length).toBe(2);
    // editorialClaimsFor(input, iat, ttlSec, jti, principal): five, none of them a flag
    expect(editorialClaimsFor.length).toBe(5);
    // the options of the signer carry no marker either
    const factorySrc = readFileSync(join(__dirname, "webdesk-editorial-signer.ts"), "utf8");
    const options = /export interface WebdeskEditorialSignerOptions \{([\s\S]*?)\n\}/.exec(factorySrc)?.[1] ?? "";
    expect(options.length).toBeGreaterThan(0);
    expect(options).not.toMatch(/\bxc\b|contributor/i);
    // neither does the request type WSK-66 hands the signer, nor the principal type it reads
    const approved = readFileSync(join(__dirname, "webdesk-approved-command.ts"), "utf8");
    const request = /export interface EditorialAssertionRequest \{([\s\S]*?)\n\}/.exec(approved)?.[1] ?? "";
    expect(request.length).toBeGreaterThan(0);
    expect(codeOnly(request)).not.toMatch(/\bxc\b/);
    expect(/export type EditorialSigningPrincipal = (.*);/.exec(approved)?.[1]).toBe('Pick<Principal, "kind">');
  });

  it("structural: `xc` is assigned in exactly one place, guarded by `principal.kind === CONTRIBUTOR_KIND`, and named as a key nowhere else in webdev", () => {
    const src = codeOnly(readFileSync(join(__dirname, "webdesk-editorial-signer.ts"), "utf8"));
    expect(src.match(/\.xc\s*=/g)).toHaveLength(1);
    expect(src).toContain("if (contributor) c.xc = true;");
    expect(src.match(/const contributor = principal\.kind === CONTRIBUTOR_KIND;/g)).toHaveLength(1);
    // no other production file in the module builds an `xc` key, so no caller has a way to pass one
    for (const file of productionSources(__dirname)) {
      if (file.endsWith("webdesk-editorial-signer.ts")) continue;
      expect(codeOnly(readFileSync(file, "utf8")), file).not.toMatch(/\bxc\s*[:=]/);
    }
  });

  it("structural: both production call sites hand the signer the assembled principal they act as", () => {
    const content = codeOnly(readFileSync(join(__dirname, "webdesk-content.service.ts"), "utf8"));
    const approved = codeOnly(readFileSync(join(__dirname, "webdesk-approved-command.ts"), "utf8"));
    expect(content.match(/signer\.sign\(\{/g)).toHaveLength(1);
    expect(content).toMatch(/\.\.\.\(w\.clientEditor \? \{ ce: true \} : \{\}\),\s*\}, principal\);/);
    expect(approved.match(/editorialSigner\.sign\(\{/g)).toHaveLength(1);
    expect(approved).toMatch(/\.\.\.\(clientDecider \? \{ ce: true as const \} : \{\}\),\s*\}, decider\);/);
  });

  it("the signed contributor assertion verifies with jose and says xc:true; an employee's has no xc; the marker is covered by the signature", async () => {
    const signer = createWebdeskEditorialSigner({ privateKey, kid: "wde-xc", now: () => iat });
    const contributor = await signer.sign(medium, CONTRIBUTOR);
    const employee = await signer.sign(medium, { kind: "employee" });
    expect((await payloadOf(contributor)).xc).toBe(true);
    expect("xc" in (await payloadOf(employee))).toBe(false);
    // stripping it breaks the signature (a contributor cannot be turned back into a staff assertion in transit)
    const [h, , sig] = contributor.split(".");
    const cp = await payloadOf(contributor);
    delete cp.xc;
    await expect(compactVerify(`${h}.${Buffer.from(JSON.stringify(cp)).toString("base64url")}.${sig}`, publicKey, { algorithms: ["EdDSA"] })).rejects.toThrow();
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
    const jws = await loaded.signer.sign({ sub: "u", pk: "human", ten: "t", site: "s", cmd: "content.publish", cmh: "b".repeat(64), apr: "a" }, EMPLOYEE);
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

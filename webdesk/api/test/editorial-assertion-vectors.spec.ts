// WSK-40 — done-when (3): the ERP signer's fixed (key, input) vectors (WSK-49b added v4: the client-editor `ce` claim).
//
// The SAME literal is pinned in platform-nest/src/modules/webdev/webdesk-editorial-signer.test.ts.
// Each side proves both directions against it:
//   here      (a) the pinned JWS (what the ERP's jose-based signer emits) VERIFIES with WebDesk's
//                 production verifier, and yields exactly the request's claims;
//             (b) WebDesk's independent node:crypto minter (test/editorial-assertion-kit.ts) produces
//                 the pinned bytes from the same (key, input);
//             (c) the `cmh` in each request is WebDesk's own computeCommandHash(cmd, args): the
//                 canonicalisation both sides share (unicode, nested arrays, key order).
//   ERP side  the real signer produces the pinned bytes, and jose verifies them with the public key.
// Change the wire format on either side and one of the two files goes red.
//
// The vector keys are derived from public labels (sha256(label) as the Ed25519 seed); no private key
// is written into either repository.
import { describe, expect, it } from "vitest";
import { computeCommandHash } from "../src/control/auth/ws4-assertion";
import { verifyEditorialAssertion } from "../src/control/auth/editorial-assertion";
import { keySetOf, mintEditorial, vectorKey, type ClaimInput } from "./editorial-assertion-kit";
import type { CommandName } from "../src/control/command-types";

// ── pinned (identical in platform-nest/src/modules/webdev/webdesk-editorial-signer.test.ts) ──────
// v4 (WSK-49b) is pinned HERE FIRST: the ERP signer gains `ce` in ticket 49c, which must add this same literal
// to its own test and emit `ce` between `apr` and `iat`, exactly where WebDesk's minter puts it.
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
  }
] as const;
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const HIGH = new Set(["content.publish", "content.schedule"]);

describe("WSK-40 editorial assertion vectors (shared with the ERP signer)", () => {
  for (const v of VECTORS) {
    describe(v.name, () => {
      const key = vectorKey(v.kid, v.keyLabel);

      it("the derived public key equals the pinned x", () => {
        expect(key.x).toBe(v.x);
      });

      it("cmh is WebDesk's own computeCommandHash(cmd, route params ∪ body)", () => {
        expect(computeCommandHash(v.request.cmd, v.args)).toBe(v.request.cmh);
      });

      it("the pinned ERP-signed JWS verifies with the production verifier and yields the request's claims", async () => {
        const r = v.request as Record<string, string>;
        const claims = await verifyEditorialAssertion(
          v.jws,
          keySetOf({ kid: v.kid, x: v.x }),
          {
            tenantSlug: v.args.tenantSlug,
            siteId: v.args.siteId,
            command: r.cmd as CommandName,
            args: v.args as unknown as Record<string, unknown>,
            high: HIGH.has(r.cmd),
            ws4ApprovalId: r.apr ?? null,
          },
          v.iat + 1,
        );
        expect(claims).toEqual({
          iss: "urn:gaiada:erp:webdev",
          aud: "urn:gaiada:webdesk:control",
          ...v.request,
          iat: v.iat,
          exp: v.iat + v.ttl,
          jti: v.jti,
        });
      });

      it("WebDesk's independent minter produces the pinned bytes from the same (key, input)", () => {
        const r = v.request as unknown as ClaimInput;
        expect(mintEditorial(key, { ...r, iat: v.iat, exp: v.iat + v.ttl, jti: v.jti })).toBe(v.jws);
      });

      it("one flipped payload byte no longer verifies", async () => {
        const [h, p, s] = v.jws.split(".");
        const bytes = Buffer.from(p, "base64url");
        bytes[bytes.length - 3] ^= 0x01;
        const r = v.request as Record<string, string>;
        await expect(
          verifyEditorialAssertion(
            `${h}.${bytes.toString("base64url")}.${s}`,
            keySetOf({ kid: v.kid, x: v.x }),
            {
              tenantSlug: v.args.tenantSlug,
              siteId: v.args.siteId,
              command: r.cmd as CommandName,
              args: v.args as unknown as Record<string, unknown>,
              high: HIGH.has(r.cmd),
              ws4ApprovalId: r.apr ?? null,
            },
            v.iat + 1,
          ),
        ).rejects.toMatchObject({ slug: "editorial-assertion-invalid-signature" });
      });
    });
  }
});

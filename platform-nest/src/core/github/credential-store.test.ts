// GH-01 §2.3/§4.9 — the vault half, against LIVE Postgres (RLS, FORCE, the real secret-box). Proves:
//   * the PEM round-trips through seal -> load exactly (AES-256-GCM at rest, decrypted only here);
//   * it NEVER appears in the masked ConnectionResponse shape (token non-exposure, same guarantee
//     integrations.test.ts already pins for every other provider);
//   * the two roles (erp/agents) coexist as separate rows under one tenant without colliding on the
//     table's UNIQUE(tenant_id, owner_kind, owner_id, provider) constraint;
//   * fail-closed without INTEGRATION_TOKEN_KEY — a token write can never land unencrypted;
//   * tenant isolation — a rival company's github credential is invisible.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { config } from "../../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { sealAppCredential, loadAppCredential, loadAppCredentialOrThrow } from "./credential-store";
import { GithubNotConfiguredError } from "./errors";

const FAKE_ERP_PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----";
const FAKE_AGENTS_PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nZZZ34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8QuDIFFERENTKEY\n-----END RSA PRIVATE KEY-----";

describe.skipIf(!TEST_URL)("GitHub App credential store (GH-01 §2.3)", () => {
  let co: string;
  let other: string;

  beforeAll(async () => {
    await initTestDb();
    config.integrationTokenKey = randomBytes(32).toString("base64");
    co = await createCompany("Gaiada Holdco");
    other = await createCompany("Rival Co");
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("seals then loads the PEM exactly, and it round-trips through AES-256-GCM (enc:v1)", async () => {
    const sealed = await sealAppCredential(co, "erp", {
      appId: "4777424", installationId: "157879245", privateKeyPem: FAKE_ERP_PEM, createdBy: null,
    });
    expect(sealed.hasToken).toBe(true);
    expect(sealed.provider).toBe("github");
    expect(sealed.ownerKind).toBe("github_app");

    const loaded = await loadAppCredential(co, "erp");
    expect(loaded).not.toBeNull();
    expect(loaded!.privateKeyPem).toBe(FAKE_ERP_PEM);
    expect(loaded!.appId).toBe("4777424");
    expect(loaded!.installationId).toBe("157879245");
  });

  it("the PEM NEVER appears in the masked ConnectionResponse — same guarantee as every other provider", async () => {
    const sealed = await sealAppCredential(co, "erp", {
      appId: "4777424", installationId: "157879245", privateKeyPem: FAKE_ERP_PEM, createdBy: null,
    });
    const json = JSON.stringify(sealed);
    expect(json).not.toContain(FAKE_ERP_PEM);
    expect(json).not.toMatch(/token_enc/);
    expect((sealed as unknown as { access_token_enc?: unknown }).access_token_enc).toBeUndefined();
  });

  it("erp and agents coexist as separate rows under the SAME tenant without colliding", async () => {
    await sealAppCredential(co, "erp", {
      appId: "4777424", installationId: "157879245", privateKeyPem: FAKE_ERP_PEM, createdBy: null,
    });
    await sealAppCredential(co, "agents", {
      appId: "4777699", installationId: "157885994", privateKeyPem: FAKE_AGENTS_PEM, createdBy: null,
    });
    const erp = await loadAppCredential(co, "erp");
    const agents = await loadAppCredential(co, "agents");
    expect(erp!.privateKeyPem).toBe(FAKE_ERP_PEM);
    expect(agents!.privateKeyPem).toBe(FAKE_AGENTS_PEM);
    expect(erp!.connectionId).not.toBe(agents!.connectionId);
  });

  it("re-sealing (key rotation) UPSERTs the same row rather than duplicating it", async () => {
    const first = await sealAppCredential(co, "erp", {
      appId: "4777424", installationId: "157879245", privateKeyPem: FAKE_ERP_PEM, createdBy: null,
    });
    const rotated = await sealAppCredential(co, "erp", {
      appId: "4777424", installationId: "157879245", privateKeyPem: FAKE_AGENTS_PEM, createdBy: null,
    });
    expect(rotated.id).toBe(first.id);
    const loaded = await loadAppCredential(co, "erp");
    expect(loaded!.privateKeyPem).toBe(FAKE_AGENTS_PEM); // rotated value wins
  });

  it("loadAppCredential returns null (not throw) when nothing has been sealed yet", async () => {
    const fresh = await createCompany(`Fresh Co ${Date.now()}`);
    expect(await loadAppCredential(fresh, "erp")).toBeNull();
  });

  it("loadAppCredentialOrThrow throws GithubNotConfiguredError('credential_not_sealed') when absent", async () => {
    const fresh = await createCompany(`Fresh Co 2 ${Date.now()}`);
    await expect(loadAppCredentialOrThrow(fresh, "erp")).rejects.toThrow(GithubNotConfiguredError);
    try {
      await loadAppCredentialOrThrow(fresh, "erp");
    } catch (e) {
      expect((e as GithubNotConfiguredError).detail?.reason).toBe("credential_not_sealed");
    }
  });

  it("FAIL-CLOSED: sealing without INTEGRATION_TOKEN_KEY throws 503, writes nothing", async () => {
    const savedKey = config.integrationTokenKey;
    config.integrationTokenKey = "";
    try {
      await expect(
        sealAppCredential(co, "erp", { appId: "1", installationId: "1", privateKeyPem: "x", createdBy: null }),
      ).rejects.toThrow(/not configured/);
    } finally {
      config.integrationTokenKey = savedKey;
    }
  });

  it("tenant isolation: a rival company's github credential is invisible", async () => {
    await sealAppCredential(co, "erp", {
      appId: "4777424", installationId: "157879245", privateKeyPem: FAKE_ERP_PEM, createdBy: null,
    });
    expect(await loadAppCredential(other, "erp")).toBeNull();
  });
});

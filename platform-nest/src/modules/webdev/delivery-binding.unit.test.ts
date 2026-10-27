// M6-P6g — the pure half of the delivery binding: the closed body, the opaque host label, the vault-record rules and the console
// word (`awaiting_deploy_credential` | `ready`). No database; runs everywhere.
import { describe, it, expect } from "vitest";
import {
  BINDABLE_ACCESS, BINDABLE_HOST_KINDS, DELIVERY_REFUSALS, DeliveryRefusal, deliveryStateOf, parseBindingBody,
  vaultRecordRefusal, type DeliveryFacts,
} from "./delivery-binding";

const VAULT = "0f8fad5b-d9cb-469f-a165-70867728950e";
const good = { hostKind: "shared-hosting", hostRef: "hostinger-1", access: "ftp", vaultRef: VAULT };

function refusal(fn: () => unknown): DeliveryRefusal {
  try {
    fn();
  } catch (e) {
    if (e instanceof DeliveryRefusal) return e;
    throw e;
  }
  throw new Error("expected a DeliveryRefusal");
}

describe("parseBindingBody", () => {
  it("accepts exactly the four fields and lowercases the vault ref", () => {
    expect(parseBindingBody({ ...good, vaultRef: VAULT.toUpperCase() })).toEqual(good);
    expect(parseBindingBody({ ...good, hostKind: "our-box", hostRef: "delphi", access: "ssh" })).toMatchObject({ hostKind: "our-box", access: "ssh" });
  });

  it("is a CLOSED body: a host, user, path or secret key is refused, not ignored", () => {
    for (const extra of ["host", "hostname", "username", "user", "path", "docroot", "password", "secret", "port"]) {
      const r = refusal(() => parseBindingBody({ ...good, [extra]: "x" }));
      expect(r.code).toBe("binding_body_invalid");
      expect(r.status).toBe(400);
      expect(r.detail).toContain(extra);
    }
  });

  it("refuses a non-object body and a missing or non-string field", () => {
    for (const b of [null, undefined, "x", 3, [], [good]]) expect(refusal(() => parseBindingBody(b)).code).toBe("binding_body_invalid");
    for (const k of Object.keys(good)) {
      const { [k as keyof typeof good]: _drop, ...rest } = good;
      expect(refusal(() => parseBindingBody(rest)).code).toBe("binding_body_invalid");
      expect(refusal(() => parseBindingBody({ ...good, [k]: 5 })).code).toBe("binding_body_invalid");
    }
  });

  it("host_kind: only shared-hosting and our-box bind (WSK-D79); the other registry kinds do not", () => {
    expect([...BINDABLE_HOST_KINDS]).toEqual(["shared-hosting", "our-box"]);
    for (const k of ["client-cpanel", "external", "unknown", "", "Shared-Hosting", "delphi"]) {
      expect(refusal(() => parseBindingBody({ ...good, hostKind: k })).code).toBe("host_kind_not_bindable");
    }
  });

  it("access: ssh (SFTP) and ftp (FTPS) only; none, cpanel and full are reach, not a deploy transport", () => {
    expect([...BINDABLE_ACCESS]).toEqual(["ssh", "ftp"]);
    for (const a of ["none", "cpanel", "full", "sftp", "ftps", ""]) {
      expect(refusal(() => parseBindingBody({ ...good, access: a })).code).toBe("access_not_bindable");
    }
  });

  it("host_ref is an opaque label: nothing host-like, user-like or path-like is accepted", () => {
    for (const ok of ["hostinger-1", "delphi", "helios", "acct_7", "a", "0x"]) expect(parseBindingBody({ ...good, hostRef: ok }).hostRef).toBe(ok);
    const bad = [
      "srv599617.hstgr.cloud", // a host name
      "203.0.113.4", // an address
      "deploy@hostinger-1", // a user
      "/home/u1/public_html", // a path
      "C:\\sites\\a", // a Windows path
      "host:22", // a port
      "two words",
      "UPPER", // lowercase only
      "-leading", "_leading", "",
      "a".repeat(64),
    ];
    for (const b of bad) {
      expect(refusal(() => parseBindingBody({ ...good, hostRef: b })).code, b).toBe("host_ref_invalid");
    }
  });

  it("vault_ref must be a uuid", () => {
    for (const v of ["", "not-a-uuid", "ftp://user:pw@host/", "0f8fad5b-d9cb-469f-a165-70867728950", `${VAULT}x`]) {
      expect(refusal(() => parseBindingBody({ ...good, vaultRef: v })).code, v).toBe("vault_ref_invalid");
    }
  });

  it("every refusal code carries a status", () => {
    for (const [code, status] of Object.entries(DELIVERY_REFUSALS)) {
      expect(new DeliveryRefusal(code as keyof typeof DELIVERY_REFUSALS, "x").status).toBe(status);
    }
  });
});

describe("vaultRecordRefusal", () => {
  const ok = { provider: "ftp", status: "linked", ownerKind: "company", ownerId: "co" };
  /** The registry row a binding is for (one site in one environment). */
  const ROW = "11111111-1111-4111-8111-111111111111";
  const row = (clientId: string | null, id: string = ROW) => ({ id, clientId });
  it("passes a linked record of the right provider owned by the company", () => {
    expect(vaultRecordRefusal(ok, "ftp", row(null))).toBeNull();
    expect(vaultRecordRefusal({ ...ok, provider: "ssh" }, "ssh", row("cl-1"))).toBeNull();
  });
  it("passes a client-owned record only for that site's own client", () => {
    const rec = { ...ok, ownerKind: "client", ownerId: "cl-1" };
    expect(vaultRecordRefusal(rec, "ftp", row("cl-1"))).toBeNull();
    expect(vaultRecordRefusal(rec, "ftp", row("cl-2"))?.code).toBe("vault_ref_wrong_owner");
    expect(vaultRecordRefusal(rec, "ftp", row(null))?.code).toBe("vault_ref_wrong_owner");
  });
  it("refuses a user-owned or app-owned record", () => {
    expect(vaultRecordRefusal({ ...ok, ownerKind: "user" }, "ftp", row(null))?.code).toBe("vault_ref_wrong_owner");
    expect(vaultRecordRefusal({ ...ok, ownerKind: "github_app" }, "ftp", row(null))?.code).toBe("vault_ref_wrong_owner");
  });
  it("M6-P6o2: passes a per-site record ONLY for its own row; another site's, or the other environment's, is refused", () => {
    const own = { ...ok, provider: "ssh", ownerKind: "webdev_site", ownerId: ROW };
    expect(vaultRecordRefusal(own, "ssh", row(null))).toBeNull();
    expect(vaultRecordRefusal(own, "ssh", row("cl-1"))).toBeNull();
    // the id compares case-insensitively (the registry's text pointer and the vault's uuid)
    expect(vaultRecordRefusal({ ...own, ownerId: ROW.toUpperCase() }, "ssh", row(null))).toBeNull();
    // another row: another site, or this site's production row when the record is the staging row's
    const other = "22222222-2222-4222-8222-222222222222";
    const refused = vaultRecordRefusal(own, "ssh", row(null, other));
    expect(refused?.code).toBe("vault_ref_wrong_owner");
    expect(refused?.detail).toContain("another site's or another environment's");
    // an empty row id never matches (fail closed)
    expect(vaultRecordRefusal({ ...own, ownerId: "" }, "ssh", row(null, ""))?.code).toBe("vault_ref_wrong_owner");
    // the kinds do not mix: a per-site record whose owner_id is the site's CLIENT id is not that client's record
    expect(vaultRecordRefusal({ ...own, ownerId: "cl-1" }, "ssh", row("cl-1"))?.code).toBe("vault_ref_wrong_owner");
    // the provider and status rules still come first
    expect(vaultRecordRefusal(own, "ftp", row(null))?.code).toBe("vault_ref_wrong_provider");
    expect(vaultRecordRefusal({ ...own, status: "unconfigured" }, "ssh", row(null))?.code).toBe("vault_ref_not_linked");
  });
  it("refuses the wrong provider for the access, whatever else is right", () => {
    expect(vaultRecordRefusal({ ...ok, provider: "ssh" }, "ftp", row(null))?.code).toBe("vault_ref_wrong_provider");
    expect(vaultRecordRefusal({ ...ok, provider: "github" }, "ssh", row(null))?.code).toBe("vault_ref_wrong_provider");
    expect(vaultRecordRefusal({ ...ok, provider: "cpanel" }, "ftp", row(null))?.code).toBe("vault_ref_wrong_provider");
  });
  it("refuses a record that holds no usable credential", () => {
    for (const status of ["unconfigured", "pending", "error", "revoked"]) {
      expect(vaultRecordRefusal({ ...ok, status }, "ftp", row(null))?.code, status).toBe("vault_ref_not_linked");
    }
  });
});

describe("deliveryStateOf — the console word", () => {
  const bound: DeliveryFacts = {
    origin: "provisioned", hostKind: "shared-hosting", hostRef: "hostinger-1", access: "ftp", vaultRef: VAULT,
    vaultRecord: { provider: "ftp", status: "linked" },
  };

  it("a provisioned site with a complete binding is ready", () => {
    expect(deliveryStateOf(bound)).toBe("ready");
    expect(deliveryStateOf({ ...bound, hostKind: "our-box", access: "ssh", vaultRecord: { provider: "ssh", status: "linked" } })).toBe("ready");
  });

  it("a freshly provisioned row (the registry defaults) is awaiting_deploy_credential", () => {
    expect(deliveryStateOf({ origin: "provisioned", hostKind: "unknown", hostRef: null, access: "none", vaultRef: null, vaultRecord: null }))
      .toBe("awaiting_deploy_credential");
  });

  it("each missing piece of the binding keeps it awaiting", () => {
    const cases: Array<[string, Partial<DeliveryFacts>]> = [
      ["no vault_ref", { vaultRef: null, vaultRecord: null }],
      ["empty vault_ref", { vaultRef: "" }],
      ["no access", { access: "none" }],
      ["cpanel access is reach, not a transport", { access: "cpanel" }],
      ["no host_ref", { hostRef: null }],
      ["empty host_ref", { hostRef: "" }],
      ["a host kind we do not deliver to", { hostKind: "client-cpanel" }],
      ["unknown host kind", { hostKind: "unknown" }],
    ];
    for (const [name, patch] of cases) expect(deliveryStateOf({ ...bound, ...patch }), name).toBe("awaiting_deploy_credential");
  });

  it("a pointer that no longer resolves, or resolves to the wrong or an unusable record, is awaiting (the credential is what is missing)", () => {
    expect(deliveryStateOf({ ...bound, vaultRecord: null })).toBe("awaiting_deploy_credential"); // deleted, or another tenant's id
    expect(deliveryStateOf({ ...bound, vaultRecord: { provider: "ftp", status: "revoked" } })).toBe("awaiting_deploy_credential");
    expect(deliveryStateOf({ ...bound, vaultRecord: { provider: "ftp", status: "error" } })).toBe("awaiting_deploy_credential");
    expect(deliveryStateOf({ ...bound, vaultRecord: { provider: "github", status: "linked" } })).toBe("awaiting_deploy_credential");
    expect(deliveryStateOf({ ...bound, vaultRecord: { provider: "ssh", status: "linked" } })).toBe("awaiting_deploy_credential"); // access is ftp
  });

  it("a row that is not a provisioned site has no delivery state at all (null, never 'awaiting')", () => {
    for (const origin of ["nexus-import", "manual", "probe"]) {
      expect(deliveryStateOf({ ...bound, origin })).toBeNull();
      expect(deliveryStateOf({ origin, hostKind: "unknown", hostRef: null, access: "none", vaultRef: null, vaultRecord: null })).toBeNull();
    }
  });
});

// PV4-02 — the `client` role invariant, as a scan instead of a comment in every policy header.
//
// THE CLAIM: the `client` role (the derived role every portal contact's grant resolves to) is named by
// exactly ONE resource policy, `resource_portal.yaml`. A client reaches anything else through a `portal`
// action whose row-level reach is src/core/portal-scope.ts; adding `client` to another kind's rules would give
// every portal contact tenant-wide reach on it (Cerbos sees no rows). Until this test the invariant lived only
// in policy header comments (resource_webdev_site.yaml, resource_webdesk_*.yaml, ...), which nothing enforced.
// Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md finding 4.
//
// STATIC ONLY: parses cerbos/policies/*.yaml with js-yaml; no DB, no Cerbos. The same scan runs over a synthetic
// policy below so the detector itself has teeth (a detector that cannot see a `client` rule would pass forever).
//
// Not covered here, on purpose: the attribute-gated derived roles `client_contact_admin` and
// `client_website_editor` (different names, and gated on a client-scoped grant / attribute rather than on the
// bare role). They are pinned by client-website-editor-cerbos.test.ts.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");

interface Hit {
  file: string;
  kind: string;
  actions: string[];
}

/** Every rule that names the bare `client` role, as a derived role or a base role. */
function clientRoleHits(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  for (const doc of yaml.loadAll(text) as any[]) {
    const rp = doc?.resourcePolicy;
    if (!rp) continue;
    for (const rule of rp.rules ?? []) {
      const names: string[] = [...(rule.derivedRoles ?? []), ...(rule.roles ?? [])];
      if (names.includes("client")) hits.push({ file, kind: rp.resource, actions: rule.actions ?? [] });
    }
  }
  return hits;
}

function realHits(): Hit[] {
  const out: Hit[] = [];
  for (const fn of readdirSync(POLICIES_DIR).sort()) {
    if (!fn.endsWith(".yaml") || fn === "derived_roles.yaml" || fn.startsWith("_")) continue;
    out.push(...clientRoleHits(fn, readFileSync(join(POLICIES_DIR, fn), "utf8")));
  }
  return out;
}

describe("PV4-02 · the `client` role appears in no resource policy except resource_portal.yaml", () => {
  it("scans every policy file, so the claim is about the whole directory (not a hand-listed subset)", () => {
    const files = readdirSync(POLICIES_DIR).filter((f) => f.startsWith("resource_") && f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("resource_conversation.yaml");
  });

  it("the only file that names `client` is resource_portal.yaml, on the `portal` kind", () => {
    const hits = realHits();
    expect(hits.length, "resource_portal.yaml's client rule must still exist").toBeGreaterThan(0);
    const offenders = hits.filter((h) => h.file !== "resource_portal.yaml" || h.kind !== "portal");
    expect(
      offenders,
      `the \`client\` role must appear ONLY in resource_portal.yaml (kind portal); found: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("the portal door for the conversation is `converse`, and it is on the client rule", () => {
    const portalHits = realHits().filter((h) => h.file === "resource_portal.yaml");
    expect(portalHits.some((h) => h.actions.includes("converse"))).toBe(true);
  });

  it("resource_conversation.yaml names the client role nowhere (the staff kind a client must never reach)", () => {
    const text = readFileSync(join(POLICIES_DIR, "resource_conversation.yaml"), "utf8");
    expect(clientRoleHits("resource_conversation.yaml", text)).toEqual([]);
  });

  // ── teeth: the detector sees a `client` rule in a synthetic conversation policy, as derived role or base role ──
  it("TEETH: a `client` derived-role rule added to a conversation-shaped policy IS detected", () => {
    const real = readFileSync(join(POLICIES_DIR, "resource_conversation.yaml"), "utf8");
    const broken = real.replace(
      `derivedRoles: ["company_admin", "manager", "member", "viewer"]`,
      `derivedRoles: ["company_admin", "manager", "member", "viewer", "client"]`,
    );
    expect(broken, "the fixture edit must actually change the policy text").not.toBe(real);
    const hits = clientRoleHits("resource_conversation.yaml", broken);
    expect(hits.length).toBe(1);
    expect(hits[0].kind).toBe("conversation");
  });

  it("TEETH: a `client` base-role rule is detected too", () => {
    const synthetic = [
      "apiVersion: api.cerbos.dev/v1",
      "resourcePolicy:",
      "  version: default",
      "  resource: synthetic_widget",
      "  rules:",
      '    - actions: ["read"]',
      "      effect: EFFECT_ALLOW",
      '      roles: ["client"]',
    ].join("\n");
    expect(clientRoleHits("resource_synthetic_widget.yaml", synthetic).map((h) => h.kind)).toEqual(["synthetic_widget"]);
  });
});

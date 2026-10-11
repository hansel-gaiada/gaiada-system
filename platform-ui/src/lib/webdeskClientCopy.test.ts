import { describe, expect, it } from "vitest";
import service from "../../e2e/webdesk-stub/compositions/service.json";
import type { CollectionComposition, WdResult } from "./webdeskContentModel";
import { CLIENT_COPY, clientRefusal, describePaths, plainForClient, SLUG } from "./webdeskClientCopy";

type Fail = Exclude<WdResult<unknown>, { kind: "ok" }>;
const defs = (service as unknown as CollectionComposition).fields;
const conflict = (slug: string, message = "m"): Fail => ({ kind: "conflict", slug, message, currentHeadVersion: 4, currentContentHash: null, updatedAt: null });
const invalid = (slug: string | undefined, paths: string[], message = "refused"): Fail => ({ kind: "invalid", issues: paths.map((path) => ({ path, message: "x" })), message, ...(slug ? { slug } : {}) });

// Each refusal §16j names, mapped to its state. The words for the six the brief quotes are the brief's, verbatim.
describe("clientRefusal: every refusal a client editor can meet", () => {
  it("409 version-conflict: the owner's words, for a save, a restore and a publish alike", () => {
    for (const op of ["save", "restore", "publish"] as const) {
      const r = clientRefusal(conflict(SLUG.versionConflict), op);
      expect(r.text).toBe("This page changed since you opened it. Reload to see the latest, then make your change again.");
      expect(r.tone).toBe("bad");
    }
  });

  it("422 field-not-client-editable: NAMES the fields in plain words, never a pointer", () => {
    const r = clientRefusal(invalid(SLUG.fieldNotClientEditable, ["/blocks/0/props/template", "/blocks/0/props/plan/action", "/seo/title"]), "save", { defs });
    expect(r.text).toContain("Nothing was saved.");
    expect(r.text).toContain("These can only be changed by Gaiada:");
    expect(r.text).toMatch(/Template/);
    expect(r.text).toMatch(/Plan > Action/);
    expect(r.text).toContain("Search appearance (SEO)");
    expect(r.text).not.toContain("/blocks");
    expect(r.text).toContain("Your other edits are still here.");
  });

  it("422 field-not-client-editable for a whole collection (/collectionKey) says so", () => {
    expect(clientRefusal(invalid(SLUG.fieldNotClientEditable, ["/collectionKey"]), "create").text).toContain("this whole section");
  });

  it("422 publish-not-client-editable: the owner's words, plus which Gaiada-only changes when the BFF listed them", () => {
    const r = clientRefusal(invalid(SLUG.publishNotClientEditable, ["/items/1/blocks/0/props/template"]), "publish", { defs, itemLabels: ["Home", "SEO page"] });
    expect(r.text.startsWith("This draft includes changes only Gaiada can publish. Gaiada will publish it, or you can restore the live version and edit again.")).toBe(true);
    expect(r.text).toContain("SEO page: Template");
    // With nothing to name it is exactly the owner's sentence.
    expect(clientRefusal(invalid(SLUG.publishNotClientEditable, []), "approve").text).toBe(CLIENT_COPY.publishNotClientEditable);
  });

  it("403 client-command-not-allowed: no scheduling for clients", () => {
    const r = clientRefusal({ kind: "forbidden", reason: "x", slug: SLUG.clientCommandNotAllowed }, "request");
    expect(r.text).toBe(CLIENT_COPY.noScheduling);
    expect(r.text).toMatch(/Scheduling isn't available/);
  });

  it("403 on approve: another person from the company needs to approve it", () => {
    expect(clientRefusal({ kind: "forbidden", reason: "forbidden" }, "approve").text).toBe("Another person from your company needs to approve this.");
  });

  it("any other 403 is a plain 'ask your admin', never the self-approval sentence", () => {
    const r = clientRefusal({ kind: "forbidden", reason: "forbidden" }, "save");
    expect(r.text).toContain("Ask your company's admin.");
    expect(r.text).not.toContain("Another person");
  });

  it("409 item-deleted, 409 approval_not_pending, and the 404s", () => {
    expect(clientRefusal(conflict(SLUG.itemDeleted), "save").text).toBe(CLIENT_COPY.itemDeleted);
    expect(clientRefusal(conflict(SLUG.approvalNotPending), "approve").text).toMatch(/already been decided/);
    expect(clientRefusal({ kind: "not_found", slug: "item-not-found" }, "read").text).toBe("This page no longer exists.");
    expect(clientRefusal({ kind: "not_found", slug: "approval_not_found" }, "withdraw").text).toMatch(/no longer available/);
    expect(clientRefusal({ kind: "not_found", slug: "site-not-found" }, "read").text).toBe("This site isn't available to you.");
  });

  it("an unknown-outcome write is flagged: never 'saved', never 'failed'", () => {
    const r = clientRefusal({ kind: "unavailable", code: "upstream_error", reason: "not_observed" }, "save");
    expect(r.unknown).toBe(true);
    expect(r.text).toBe("We couldn't confirm the save. Reload to see what happened.");
  });

  it("the stale and unreachable states keep the user's work in view and say nothing was written", () => {
    const r = clientRefusal({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" }, "publish");
    expect(r.text).toContain("Couldn't reach the website service.");
    expect(r.text).toContain("Nothing was published.");
    expect(r.text).not.toContain("circuit_open");
    const drift = clientRefusal({ kind: "unavailable", code: "contract_drift", reason: "x: expected y" }, "save");
    expect(drift.text).toContain("something unexpected");
    expect(drift.text).not.toContain("expected y");
  });

  it("never prints raw problem JSON or a slug: no refusal text carries a brace, a type URL or a status code", () => {
    const all: [Fail, Parameters<typeof clientRefusal>[1]][] = [
      [conflict("weird-slug", "boom"), "save"], [invalid("weird", ["/x"], "bad"), "save"], [invalid(undefined, [], "bad"), "create"],
      [{ kind: "forbidden", reason: "forbidden" }, "save"], [{ kind: "not_enabled", reason: "not_served" }, "read"],
      [{ kind: "unavailable", code: "network", reason: "ECONNRESET" }, "save"],
    ];
    for (const [f, op] of all) expect(clientRefusal(f, op).text).not.toMatch(/[{}]|https?:|\b(40\d|42\d|50\d)\b|ECONNRESET/);
  });
});

describe("describePaths", () => {
  it("labels fields from the composition, skips list indexes, and dedupes", () => {
    expect(describePaths(["/blocks/0/props/plan/action", "/blocks/0/props/plan/action"], defs)).toEqual(["Plan > Action"]);
    expect(describePaths(["/blocks/0/props/schema/2"], defs)).toEqual(["Schema"]);
  });
  it("falls back to a readable name for a field the composition does not know (no composition at all: the key, humanised), and handles seo / blocks / junk", () => {
    expect(describePaths(["/blocks/0/props/template"], undefined)).toEqual(["Template"]);
    expect(describePaths(["/blocks/0/props/ghost_field"], defs)).toEqual(["Ghost field"]);
    expect(describePaths(["/seo"], defs)).toEqual(["Search appearance (SEO)"]);
    expect(describePaths(["/blocks/1/props/x"], defs)).toEqual(["Other content on this page"]);
    expect(describePaths(["nonsense"], defs)).toEqual(["Part of this page"]);
  });
});

describe("plainForClient", () => {
  it("replaces the product name a client has never met", () => {
    expect(plainForClient("Disabled until WebDesk answers again")).toBe("Disabled until the website service answers again");
    expect(plainForClient("WebDesk answered unexpectedly.")).toBe("The website service answered unexpectedly.");
  });
});

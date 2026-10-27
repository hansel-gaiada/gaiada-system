// M5-W1d — the HTTP fence's two halves that need no database: the decision itself, and the INVENTORY of every route.
//
// THE INVENTORY IS THE POINT. A contributor reaches a route only when its handler carries `@ContributorRoute()`. So the
// question "what can a freelance writer reach over HTTP?" has exactly one answer, the marked set, and this file pins it
// as a literal list built from EVERY route of the app (AppModule's controllers, read from Nest's own metadata). A new
// route is therefore closed to contributors until someone adds the mark AND edits MARKED below on purpose; a mark that
// appears anywhere else, or disappears, turns this file red. `contributor-fence.db.test.ts` then drives every
// unmarked guarded route over HTTP as a contributor and expects the 403.
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { Controller, Get } from "@nestjs/common";
import { ContributorRoute, contributorFenceRefusal, enforceContributorFence, isContributorRoute } from "./contributor-route";
import { appRoutes, routeKey } from "../testing/route-inventory";
import { CONTRIBUTOR_ROLES, contributorGrants } from "../rbac/contributor";
import type { Principal, RoleGrant } from "../rbac/principal";

/** THE marked set: every route a contributor may reach (still decided by Cerbos on its own grants). Edit on purpose only. */
const MARKED = [
  "GET /api/me",
  "GET /api/:tenantId/modules/webdev/content/sites",
  "GET /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/briefs/:briefId",
  "GET /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/collections",
  "GET /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/collections/:collectionKey/items",
  "POST /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/collections/:collectionKey/items",
  "GET /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/editorial/board",
  "GET /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId",
  "PATCH /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId",
  "PUT /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId",
  "GET /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/brief",
  "GET /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial",
  "POST /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial/comments",
  "POST /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial/comments/:commentId/resolve",
  "POST /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial/request-changes",
  "POST /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial/seo-signoff",
  "POST /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial/submit",
  "POST /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/editorial/withdraw",
  "POST /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/preview",
  "POST /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/restore",
  "GET /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/versions",
  "GET /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/versions/:n",
  "GET /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media",
  // M5-W1q (WSK-D84): a contributor uploads INTO THE QUARANTINE: the token WebDesk mints for its assertion quarantines the asset.
  "POST /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media/upload-token",
].sort();

/** Never open to a contributor, whatever MARKED becomes: the staff functions the design names (§3.1 item 6) and the
 *  contributor admin itself. A second, independent list, so editing MARKED alone cannot open one of these. */
const NEVER = [
  /\/media\/quarantine$/, /\/media\/:assetId\/review$/, /\/media\/:assetId\/review-preview$/, /\/media\/:assetId$/, /\/editorial\/approve$/, /\/editorial\/assign$/, /\/publish-requests/,
  /\/unpublish$/, /\/items\/:itemId\/delete$/, /\/editorial-policy$/, /\/editorial\/grants/, /\/editorial\/contributors/,
  /\/assistant\//, /\/assist$/, /\/forms/, /\/briefs$/, /\/briefs\/:briefId\/(assign|create-draft)$/,
];

const principal = (over: Partial<Principal>): Principal => ({
  userId: "u-1", assurance: "high", companies: [], rootCompanies: [], roles: [], perms: [], sessionVersion: 1, ...over,
});

class Probe {
  @ContributorRoute()
  open(): void {}
  closed(): void {}
}

describe("M5-W1d · the contributor fence decision (no database)", () => {
  it("a contributor passes a marked route at a real high assurance, and nothing else", () => {
    const c = principal({ kind: "contributor" });
    expect(contributorFenceRefusal(c, Probe.prototype.open)).toBeNull();
    expect(contributorFenceRefusal(c, Probe.prototype.closed)).toBe("route_not_open_to_contributors");
    expect(contributorFenceRefusal({ ...c, assurance: "linked" }, Probe.prototype.open)).toBe("assurance_high_required");
    expect(contributorFenceRefusal({ ...c, assurance: "low" }, Probe.prototype.open)).toBe("assurance_high_required");
    // The dev-stage SIMULATED second factor never counts for an outside principal.
    expect(contributorFenceRefusal({ ...c, assuranceSource: "simulated" }, Probe.prototype.open)).toBe("assurance_high_required");
    // An unmarked route is refused first, whatever the assurance.
    expect(contributorFenceRefusal({ ...c, assurance: "linked" }, Probe.prototype.closed)).toBe("route_not_open_to_contributors");
  });

  it("every other kind passes untouched, marked or not, at any assurance (the fence changes no staff request)", () => {
    for (const kind of ["employee", "client", "automation", "bot", undefined] as const) {
      for (const assurance of ["high", "linked", "low"] as const) {
        expect(contributorFenceRefusal(principal({ kind, assurance }), Probe.prototype.closed)).toBeNull();
        expect(contributorFenceRefusal(principal({ kind, assurance }), Probe.prototype.open)).toBeNull();
      }
    }
    expect(contributorFenceRefusal(undefined, Probe.prototype.closed)).toBeNull();
  });

  it("the refusal is a 403 whose `error` is contributor_route_forbidden and whose `reason` names why", () => {
    let caught: unknown;
    try {
      enforceContributorFence(principal({ kind: "contributor" }), Probe.prototype.closed);
    } catch (e) {
      caught = e;
    }
    const e = caught as { getStatus(): number; getResponse(): { message: string; reason: string } };
    expect(e.getStatus()).toBe(403);
    expect(e.getResponse()).toEqual({ message: "contributor_route_forbidden", reason: "route_not_open_to_contributors" });
  });

  it("the mark is read from the HANDLER only: marking a class (by hand) opens nothing", () => {
    @Controller("x")
    class Marked {
      @Get("y")
      y(): void {}
    }
    Reflect.defineMetadata("gaiada:contributor-route", true, Marked);
    expect(isContributorRoute(Marked.prototype.y)).toBe(false);
    expect(isContributorRoute(Marked)).toBe(true); // the class itself is a function, but no route handler is the class
    expect(isContributorRoute("not a function")).toBe(false);
  });
});

describe("M5-W1d · the contributor-route INVENTORY over every route of the app", () => {
  const routes = appRoutes();

  it("the enumeration is real (hundreds of routes, the known ones among them) — an empty list would make every check vacuous", () => {
    expect(routes.length).toBeGreaterThan(300);
    const keys = new Set(routes.map(routeKey));
    expect(keys.has("GET /api/me")).toBe(true);
    expect(keys.has("POST /api/:tenantId/assistant/threads")).toBe(true);
    expect(keys.has("POST /api/:tenantId/modules/webdev/editorial/contributors/invite")).toBe(true);
  });

  it("the marked set is EXACTLY the pinned list", () => {
    const marked = routes.filter((r) => r.contributorRoute).map(routeKey).sort();
    expect(marked).toEqual(MARKED);
  });

  it("every marked route is behind AuthGuard (an unguarded mark would be a route with no fence at all)", () => {
    const unguarded = routes.filter((r) => r.contributorRoute && !r.authGuarded).map(routeKey);
    expect(unguarded).toEqual([]);
  });

  it("no route the design keeps from contributors is in the marked set (an independent second list)", () => {
    const leaked = MARKED.filter((k) => NEVER.some((re) => re.test(k.split(" ")[1])));
    expect(leaked).toEqual([]);
  });

  it("the contributor admin routes exist, are guarded and are NOT open to contributors", () => {
    const admin = routes.filter((r) => r.path.startsWith("/api/:tenantId/modules/webdev/editorial/contributors"));
    expect(admin.map(routeKey).sort()).toEqual([
      "GET /api/:tenantId/modules/webdev/editorial/contributors",
      "POST /api/:tenantId/modules/webdev/editorial/contributors/:userId/end",
      "POST /api/:tenantId/modules/webdev/editorial/contributors/invite",
    ]);
    expect(admin.every((r) => r.authGuarded && !r.contributorRoute)).toBe(true);
    // The public accept is deliberately unguarded (its authority is the token), like the client invite's.
    const accept = routes.find((r) => routeKey(r) === "POST /api/editorial-invites/accept");
    expect(accept?.authGuarded).toBe(false);
    expect(accept?.contributorRoute).toBe(false);
  });
});

describe("M5-W1d · contributorGrants (the assembly filter, pure)", () => {
  const g = (role: string, scopeType: RoleGrant["scopeType"], scopeId: string | null): RoleGrant => ({ role, scopeType, scopeId });

  it("keeps only the three contributor roles at company scope in a company whose anchor is live", () => {
    const live = new Set(["co-1"]);
    const grants = [
      g("webdesk_writer", "company", "co-1"),
      g("webdesk_translator", "company", "co-1"),
      g("webdesk_seo_reviewer", "company", "co-1"),
      g("webdesk_editor", "company", "co-1"), // approval is a staff function
      g("webdev_manager", "company", "co-1"), // a staff tier, however it got there
      g("webdesk_writer", "company", "co-2"), // a company whose anchor is not live
      g("webdesk_writer", "global", null),
      g("client", "company", "co-1"),
    ];
    expect(contributorGrants(grants, live).map((x) => `${x.role}@${x.scopeId}`)).toEqual([
      "webdesk_writer@co-1", "webdesk_translator@co-1", "webdesk_seo_reviewer@co-1",
    ]);
    expect(contributorGrants(grants, new Set())).toEqual([]);
    expect([...CONTRIBUTOR_ROLES]).toEqual(["webdesk_writer", "webdesk_translator", "webdesk_seo_reviewer"]);
  });
});

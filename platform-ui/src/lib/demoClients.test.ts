import { describe, it, expect } from "vitest";
import { getDemoResponse } from "./demoFixtures";

// PV3-04: the DEMO twins of the backend's client write rules, so a reviewer driving demo mode meets the
// same refusals (required business type; operator-only, same-root group-company link) as production.

const ADMIN = "demo-hansel";   // platform_admin
const MEMBER = "gede-ic";      // plain member
const OWNER = "demo-owner";    // owner of the root
const TENANT = "co-agency";

const send = (method: string, path: string, userId: string, body?: unknown) =>
  getDemoResponse(method, `/api/${TENANT}${path}`, userId, body === undefined ? undefined : JSON.stringify(body));
const clientsList = () => (send("GET", "/clients", ADMIN).json as Array<{ id: string; name: string; groupCompany?: { id: string; name: string } | null }>);
const centreOf = (id: string) => send("GET", `/clients/${id}/centre`, ADMIN).json as { businessType: string; revision: number };
const historyOf = (id: string) => (send("GET", `/clients/${id}/history`, ADMIN).json as Array<{ metadata: { changes?: { field: string; before: string | null; after: string | null }[] } }>)
  .flatMap((h) => h.metadata.changes ?? []);

describe("demo clients · business type (PV3-04)", () => {
  it("a create without a business type is a 400 business_type_required, and nothing is added", () => {
    const before = clientsList().length;
    const r = send("POST", "/clients", MEMBER, { name: "No Type" });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: "business_type_required" });
    expect(send("POST", "/clients", MEMBER, { name: "Bad Type", businessType: "pirate-ship" }).json).toMatchObject({ error: "business_type_invalid" });
    expect(clientsList()).toHaveLength(before);
  });

  it("a create with a type adds the client AND its profile row, so the centre list and Edit form see it", () => {
    const r = send("POST", "/clients", MEMBER, { name: "Typed Demo", businessType: "retail" });
    expect(r.status).toBe(201);
    const id = (r.json as { id: string }).id;
    expect(centreOf(id)).toMatchObject({ businessType: "retail", revision: 1 });
    const list = send("GET", "/clients/centre", ADMIN).json as Array<{ clientId: string; businessType: string }>;
    expect(list.find((c) => c.clientId === id)?.businessType).toBe("retail");
  });

  it("a PATCH retypes, a same-type PATCH changes nothing, and a client with no profile row gets one (History: from nothing)", () => {
    // cl-3 (Lumen Studio) is the demo's "no profile row" client: revision 0 reads as "other".
    expect(centreOf("cl-3")).toMatchObject({ businessType: "other", revision: 0 });
    expect(send("PATCH", "/clients/cl-3", MEMBER, { businessType: "agency" }).status).toBe(200);
    expect(centreOf("cl-3")).toMatchObject({ businessType: "agency", revision: 1 });
    expect(historyOf("cl-3")).toContainEqual({ field: "businessType", before: null, after: "agency" });
    send("PATCH", "/clients/cl-3", MEMBER, { businessType: "agency" });
    expect(centreOf("cl-3").revision).toBe(1);
    expect(send("PATCH", "/clients/cl-3", MEMBER, { businessType: "nope" }).status).toBe(400);
  });
});

describe("demo clients · group company (PV3-04)", () => {
  it("the demo has a group client, linked to its own company", () => {
    expect(clientsList().find((c) => c.id === "cl-4")?.groupCompany).toEqual({ id: "co-resort", name: "Viceroy" });
    const hub = send("GET", "/clients/cl-4/overview", ADMIN).json as { client: { groupCompany: unknown } };
    expect(hub.client.groupCompany).toEqual({ id: "co-resort", name: "Viceroy" });
  });

  it("🔴 a member touching groupCompanyId gets 403 before any validation, on create and on patch", () => {
    expect(send("PATCH", "/clients/cl-1", MEMBER, { groupCompanyId: "co-resort" }).status).toBe(403);
    expect(send("PATCH", "/clients/cl-1", MEMBER, { groupCompanyId: "not-a-company" }).status).toBe(403);
    expect(send("POST", "/clients", MEMBER, { name: "Sneaky", businessType: "hotel", groupCompanyId: "co-resort" }).status).toBe(403);
    expect(clientsList().find((c) => c.name === "Sneaky")).toBeUndefined();
    expect(clientsList().find((c) => c.id === "cl-1")?.groupCompany ?? null).toBeNull();
  });

  it("an operator links a same-root sibling and clears it; History records both", () => {
    expect(send("PATCH", "/clients/cl-2", ADMIN, { groupCompanyId: "co-resort" }).status).toBe(200);
    expect(clientsList().find((c) => c.id === "cl-2")?.groupCompany).toEqual({ id: "co-resort", name: "Viceroy" });
    expect(send("PATCH", "/clients/cl-2", OWNER, { groupCompanyId: null }).status).toBe(200);
    expect(clientsList().find((c) => c.id === "cl-2")?.groupCompany).toBeNull();
    const ch = historyOf("cl-2");
    expect(ch).toContainEqual({ field: "groupCompany", before: null, after: "Viceroy" });
    expect(ch).toContainEqual({ field: "groupCompany", before: "Viceroy", after: null });
  });

  it("an operator is still refused the client's own company, a missing company and a malformed id, each with a typed code", () => {
    expect(send("PATCH", "/clients/cl-2", ADMIN, { groupCompanyId: TENANT }).json).toMatchObject({ error: "group_company_self" });
    expect(send("PATCH", "/clients/cl-2", ADMIN, { groupCompanyId: "co-nowhere" }).json).toMatchObject({ error: "group_company_not_found" });
    expect(send("PATCH", "/clients/cl-2", ADMIN, { groupCompanyId: 42 }).json).toMatchObject({ error: "group_company_invalid" });
    expect(clientsList().find((c) => c.id === "cl-2")?.groupCompany ?? null).toBeNull();
  });
});

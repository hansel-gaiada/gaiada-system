import { beforeEach, describe, expect, it } from "vitest";
import { getDemoResponse } from "./demoFixtures";
import { resetDemoBilling } from "./demoBilling";

// PV3-09 — the demo twins send `clientVisible` by the SAME rule as the backend (BFF §22d), so a DEMO_MODE
// run of the hub shows the markers the live one will. These pin the rule per kind, and the deliverables
// facet, which goes through the deliverable's PROJECT's client (PV3-07 follow-up), not its own `client_id`.

const HANSEL = "demo-hansel";
const T = "co-agency";
const get = (path: string) => getDemoResponse("GET", `/api/${T}${path}`, HANSEL);
const rows = (path: string) => {
  const r = get(path);
  expect(r.status).toBe(200);
  const j = r.json as unknown;
  return (Array.isArray(j) ? j : (j as { items: unknown[] }).items) as Array<Record<string, any>>;
};

beforeEach(() => resetDemoBilling());

describe("demo deliverables · the ?clientId= facet goes through the project", () => {
  it("a client's deliverables are those whose PROJECT belongs to it", () => {
    expect(rows("/deliverables?clientId=cl-1").map((d) => d.id)).toEqual(["dl-1", "dl-2"]);
    expect(rows("/deliverables?clientId=cl-2").map((d) => d.id)).toEqual(["dl-3"]);
    expect(rows("/deliverables?clientId=cl-3")).toEqual([]);
  });

  it("`internal` is 'the project has no client', and a deliverable with no project is in no client's list", () => {
    const created = getDemoResponse("POST", `/api/${T}/deliverables`, HANSEL, JSON.stringify({ name: "Loose", clientId: "cl-1" }));
    expect(created.status).toBe(201);
    const loose = (created.json as { id: string }).id;
    // Its own `client_id` says cl-1, but it has no project: the portal could never show it, so no client facet lists it.
    expect(rows("/deliverables?clientId=cl-1").map((d) => d.id)).not.toContain(loose);
    expect(rows("/deliverables?clientId=internal").map((d) => d.id)).toContain(loose);
  });

  it("clientVisible follows the same rule: true through a client's project, false otherwise", () => {
    const all = rows("/deliverables");
    expect(all.find((d) => d.id === "dl-1")?.clientVisible).toBe(true);
    const created = getDemoResponse("POST", `/api/${T}/deliverables`, HANSEL, JSON.stringify({ name: "Loose2", clientId: "cl-1" }));
    const loose = (created.json as { id: string }).id;
    expect(rows("/deliverables").find((d) => d.id === loose)?.clientVisible).toBe(false);
    // Every row of a client facet is visible, every row of `internal` is not (BFF §22a/§22d).
    expect(rows("/deliverables?clientId=cl-1").every((d) => d.clientVisible === true)).toBe(true);
    expect(rows("/deliverables?clientId=internal").every((d) => d.clientVisible === false)).toBe(true);
  });
});

describe("demo · clientVisible by kind (the backend's rule)", () => {
  it("projects: true with a client, false for internal work", () => {
    const projects = rows("/projects");
    expect(projects.find((p) => p.id === "p-web-1")?.clientVisible).toBe(true);
    expect(projects.find((p) => p.id === "p-int-1")?.clientVisible).toBe(false);
  });

  it("tasks: always false", () => {
    const tasks = rows("/pm/tasks?clientId=cl-1");
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.clientVisible === false)).toBe(true);
    expect(rows("/pm/tasks").every((t) => t.clientVisible === false)).toBe(true);
  });

  it("contracts: a draft is false, sent, signed and void are true", () => {
    const by = Object.fromEntries(rows("/contracts?clientId=cl-1").map((k) => [k.status, k.clientVisible]));
    expect(by).toMatchObject({ draft: false, sent: true, signed: true, void: true });
  });

  it("invoices: a non-draft invoice with a client is true", () => {
    expect(rows("/invoices?clientId=cl-1").every((i) => i.clientVisible === (i.status !== "draft"))).toBe(true);
    expect(rows("/invoices?clientId=cl-1").length).toBeGreaterThan(0);
  });

  it("payments: through a non-draft invoice, so a pending claim reads true", () => {
    const pays = rows("/invoice-payments?clientId=cl-1&status=pending");
    expect(pays.length).toBeGreaterThan(0);
    expect(pays.every((p) => p.clientVisible === true)).toBe(true);
  });

  it("runs and gates: a run with a client is true, one without is false; only client-side gates are true", () => {
    const runs = rows("/pipeline/runs?include=gates");
    const withClient = runs.find((r) => r.id === "run-demo-1")!;
    const noClient = runs.find((r) => r.id === "run-demo-2")!;
    expect(withClient.clientVisible).toBe(true);
    expect(noClient.clientVisible).toBe(false);
    for (const g of withClient.gates) expect(g.clientVisible).toBe(g.actor_side === "client");
    expect(noClient.gates.every((g: any) => g.clientVisible === false)).toBe(true);
    expect(withClient.gates.some((g: any) => g.clientVisible === true)).toBe(true);
    expect(withClient.gates.some((g: any) => g.clientVisible === false)).toBe(true);
  });

  it("change requests: true with a client, false for a staff-logged one with none", () => {
    const crs = rows("/webdev/change-requests");
    expect(crs.filter((c) => c.clientId).every((c) => c.clientVisible === true)).toBe(true);
    expect(crs.filter((c) => !c.clientId).every((c) => c.clientVisible === false)).toBe(true);
    expect(crs.some((c) => !c.clientId)).toBe(true);
  });

  it("meetings: always false", () => {
    const recs = rows("/meetings/recordings?clientId=cl-1");
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => r.clientVisible === false)).toBe(true);
  });

  it("contacts: listed in the portal People area", () => {
    const contacts = rows("/clients/cl-1/contacts");
    expect(contacts.length).toBeGreaterThan(0);
    expect(contacts.every((c) => c.clientVisible === true)).toBe(true);
  });

  it("overview items carry the flag per kind: a drafted agreement is internal, a payment and a request are not", () => {
    const o = get("/clients/cl-1/overview").json as { needsUs: Array<Record<string, any>>; needsClient: Array<Record<string, any>> };
    const items = [...o.needsUs, ...o.needsClient];
    expect(items.every((i) => typeof i.clientVisible === "boolean")).toBe(true);
    expect(o.needsUs.find((i) => i.kind === "contract")?.clientVisible).toBe(false);
    expect(o.needsUs.find((i) => i.kind === "payment")?.clientVisible).toBe(true);
    expect(o.needsUs.find((i) => i.kind === "request")?.clientVisible).toBe(true);
    expect(o.needsClient.find((i) => i.kind === "contract")?.clientVisible).toBe(true);
    expect(o.needsClient.find((i) => i.kind === "review")?.clientVisible).toBe(true);
  });
});

// PV7-03 — the Health card's markers come from the health read's own `clientVisible` (BFF §54.2). The demo's per-project flag
// must be the SAME answer the projects list gives for that project (a project with a client is visible to a client-wide
// contact, internal work never is), so a DEMO_MODE hub shows the markers the live one will.
describe("demo client health · clientVisible follows the projects rule", () => {
  it("every project in a client's health carries the same clientVisible as the projects list, and internal work is never listed", () => {
    const listed = rows("/projects");
    for (const cid of ["cl-1", "cl-2", "cl-3"]) {
      const h = get(`/clients/${cid}/health`).json as { projects: Array<{ projectId: string; clientVisible: boolean }> };
      expect(h.projects.length, cid).toBeGreaterThan(0);
      for (const p of h.projects) {
        expect(p.clientVisible, `${cid}/${p.projectId}`).toBe(listed.find((x) => x.id === p.projectId)?.clientVisible);
      }
    }
    const all = (["cl-1", "cl-2", "cl-3", "cl-4"].flatMap((cid) => (get(`/clients/${cid}/health`).json as { projects: Array<{ projectId: string }> }).projects));
    expect(all.some((p) => p.projectId === "p-int-1")).toBe(false);
  });

  it("every turnaround part says whether the client sees it, as a boolean (never omitted)", () => {
    const h = get("/clients/cl-1/health").json as { turnaround: { client: { parts: Array<{ clientVisible: unknown }> }; ours: { parts: Array<{ clientVisible: unknown }> } } };
    for (const part of [...h.turnaround.client.parts, ...h.turnaround.ours.parts]) expect(typeof part.clientVisible).toBe("boolean");
  });
});

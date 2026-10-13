import { describe, it, expect } from "vitest";
import { countProjectsByClient, departmentClientsView } from "./page-helpers";
import type { Client } from "@/lib/entities";
import type { ReadResult } from "@/lib/readResult";

// DW-6d — the pure parts of the department Clients page (contract §33.4): the project count per client, and the
// states. The load-bearing rule is the one the whole program keeps: a failed or refused read says "unavailable",
// it is never an empty list.

const client = (id: string, name: string, status = "active"): Client => ({ id, name, contact: {}, status, custom_fields: {} });
const ok = <T,>(data: T): ReadResult<T> => ({ kind: "ok", data });

describe("countProjectsByClient", () => {
  it("counts the department's projects per client, from one list", () => {
    const counts = countProjectsByClient([
      { client_id: "a" }, { client_id: "b" }, { client_id: "a" }, { client_id: "a" },
    ]);
    expect(counts.get("a")).toBe(3);
    expect(counts.get("b")).toBe(1);
    expect(counts.get("c")).toBeUndefined();
  });

  it("counts a project with no client for nobody", () => {
    const counts = countProjectsByClient([{ client_id: null }, { client_id: "a" }]);
    expect([...counts.entries()]).toEqual([["a", 1]]);
  });

  it("is empty for no projects", () => {
    expect(countProjectsByClient([]).size).toBe(0);
  });
});

describe("departmentClientsView", () => {
  const clients = ok([client("a", "Acme"), client("b", "Beta", "paused")]);
  const projects = ok([{ client_id: "a" }, { client_id: "a" }, { client_id: "b" }, { client_id: null }]);

  it("lists each client with its status, business type and the count of the department's projects", () => {
    const view = departmentClientsView(clients, projects, new Map([["a", "Retail"]]));
    expect(view).toEqual({
      kind: "rows",
      rows: [
        { id: "a", name: "Acme", status: "active", businessType: "Retail", projectCount: 2 },
        { id: "b", name: "Beta", status: "paused", businessType: null, projectCount: 1 },
      ],
    });
  });

  it("an empty successful read is the empty state, a real answer", () => {
    expect(departmentClientsView(ok([]), projects, new Map())).toEqual({ kind: "empty" });
  });

  it("a refused clients read is forbidden, never empty", () => {
    expect(departmentClientsView({ kind: "forbidden" }, projects, null)).toEqual({ kind: "forbidden" });
  });

  it("a failed clients read is unavailable, carrying the reason, never empty", () => {
    expect(departmentClientsView({ kind: "unavailable", reason: "boom" }, ok([]), null)).toEqual({ kind: "unavailable", reason: "boom" });
  });

  it("a failed projects read keeps the clients and shows the counts as unknown, not zero", () => {
    const view = departmentClientsView(clients, { kind: "unavailable", reason: "x" }, null);
    expect(view.kind).toBe("rows");
    if (view.kind !== "rows") return;
    expect(view.rows.map((r) => r.projectCount)).toEqual([null, null]);
    expect(view.rows.map((r) => r.businessType)).toEqual([null, null]);
  });

  it("a refused projects read does not turn the list into an empty one either", () => {
    const view = departmentClientsView(clients, { kind: "forbidden" }, new Map());
    expect(view.kind).toBe("rows");
  });

  it("reads zero only when the projects read succeeded and named no project for the client", () => {
    const view = departmentClientsView(ok([client("a", "Acme")]), ok([]), new Map());
    expect(view).toMatchObject({ kind: "rows", rows: [{ id: "a", projectCount: 0 }] });
  });
});

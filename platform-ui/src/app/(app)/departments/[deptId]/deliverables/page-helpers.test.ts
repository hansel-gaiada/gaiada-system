import { describe, it, expect } from "vitest";
import { departmentDeliverablesView } from "./page-helpers";
import type { Deliverable } from "@/lib/entities";
import type { ReadResult } from "@/lib/readResult";

// DW-6g — the pure parts of the department Deliverables page (contract §33.4): the rows, in the list's own order,
// and the states. A failed or refused deliverables read is never an empty list.

const del = (id: string, project_id: string, over: Partial<Deliverable> = {}): Deliverable => ({
  id, project_id, client_id: null, name: `d-${id}`, status: "pending", due_date: null, ...over,
});
const ok = <T,>(data: T): ReadResult<T> => ({ kind: "ok", data });
const projects = ok([
  { id: "p1", name: "Site rebuild", client_id: "c1" },
  { id: "p2", name: "Internal tooling", client_id: null },
]);
const clients = ok([{ id: "c1", name: "Acme" }]);

describe("departmentDeliverablesView", () => {
  it("shows name, project, client, status and due date, in the order the list came", () => {
    const view = departmentDeliverablesView(
      ok([del("z", "p1", { due_date: "2026-11-01", status: "in_review" }), del("a", "p2")]),
      projects, clients,
    );
    expect(view).toEqual({
      kind: "rows",
      rows: [
        { id: "z", name: "d-z", projectId: "p1", projectName: "Site rebuild", clientId: "c1", clientName: "Acme", status: "in_review", dueDate: "2026-11-01" },
        { id: "a", name: "d-a", projectId: "p2", projectName: "Internal tooling", clientId: null, clientName: null, status: "pending", dueDate: null },
      ],
    });
  });

  it("the project's client decides the client, as the list's clientId facet does", () => {
    const view = departmentDeliverablesView(ok([del("x", "p1", { client_id: "other" })]), projects, clients);
    expect(view).toMatchObject({ kind: "rows", rows: [{ clientId: "c1", clientName: "Acme" }] });
  });

  it("falls back to the deliverable's own client when the project is not in the project list", () => {
    const view = departmentDeliverablesView(ok([del("x", "gone", { client_id: "c1" })]), projects, clients);
    expect(view).toMatchObject({ kind: "rows", rows: [{ projectName: null, clientId: "c1", clientName: "Acme" }] });
  });

  it("an empty successful read is the empty state, a real answer", () => {
    expect(departmentDeliverablesView(ok([]), projects, clients)).toEqual({ kind: "empty" });
  });

  it("a refused deliverables read is forbidden, never empty", () => {
    expect(departmentDeliverablesView({ kind: "forbidden" }, projects, clients)).toEqual({ kind: "forbidden" });
  });

  it("a failed deliverables read is unavailable, carrying the reason, never empty", () => {
    expect(departmentDeliverablesView({ kind: "unavailable", reason: "502" }, ok([]), ok([]))).toEqual({ kind: "unavailable", reason: "502" });
  });

  it("when the name reads fail the rows still show, with the names unknown", () => {
    const view = departmentDeliverablesView(ok([del("x", "p1", { client_id: "c1" })]), { kind: "unavailable", reason: "x" }, { kind: "forbidden" });
    expect(view).toMatchObject({ kind: "rows", rows: [{ projectName: null, clientId: "c1", clientName: null }] });
  });
});

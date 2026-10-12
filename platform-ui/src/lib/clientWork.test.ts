import { describe, expect, it } from "vitest";
import { NO_PROJECT_LABEL, clientGatesOf, groupByProject, postReviewItems } from "./clientWork";
import type { PipelineGate } from "./pipeline";
import type { ClientBallItem } from "./clientHub";

const gate = (id: string, side: "internal" | "client"): PipelineGate => ({
  id, run_id: "r", stage_id: null, kind: "prd_sign", actor_side: side, status: "pending",
  decision: null, note: null, decided_by: null, decided_at: null, created_at: "2026-10-01T00:00:00Z",
});

describe("groupByProject", () => {
  const pick = (r: { p: string | null; n: string | null }) => ({ id: r.p, name: r.n });

  it("puts work with no project under 'Not tied to a project', last", () => {
    const groups = groupByProject(
      [{ p: null, n: null }, { p: "p2", n: "Zeta" }, { p: "p1", n: "Alpha" }, { p: "p2", n: "Zeta" }],
      pick,
    );
    expect(groups.map((g) => g.projectName)).toEqual(["Alpha", "Zeta", NO_PROJECT_LABEL]);
    expect(groups[1].rows).toHaveLength(2);
    expect(groups[2].projectId).toBeNull();
  });

  it("never drops a row, and returns [] only for no rows", () => {
    expect(groupByProject([], pick)).toEqual([]);
    const only = groupByProject([{ p: null, n: null }], pick);
    expect(only).toHaveLength(1);
    expect(only[0].projectName).toBe(NO_PROJECT_LABEL);
  });

  it("names a project that has an id but no name", () => {
    expect(groupByProject([{ p: "p1", n: null }], pick)[0].projectName).toBe("Unnamed project");
  });
});

describe("clientGatesOf", () => {
  it("keeps only client-side gates", () => {
    expect(clientGatesOf([gate("a", "internal"), gate("b", "client")])?.map((g) => g.id)).toEqual(["b"]);
  });
  it("keeps 'no gates field' distinct from 'no client gates'", () => {
    expect(clientGatesOf(null)).toBeNull();
    expect(clientGatesOf([])).toEqual([]);
  });
});

describe("postReviewItems", () => {
  const item = (kind: ClientBallItem["kind"], id: string): ClientBallItem =>
    ({ kind, id, label: id, context: "", href: "/", since: null });
  it("takes reviews from both ball lists and tags the side", () => {
    const out = postReviewItems({
      needsUs: [item("payment", "pay"), item("review", "r-us")],
      needsClient: [item("gate", "g"), item("review", "r-cl")],
    });
    expect(out.map((i) => `${i.id}:${i.side}`)).toEqual(["r-us:us", "r-cl:client"]);
  });
});

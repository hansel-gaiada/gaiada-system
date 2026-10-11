// The n8n bridge (automation/workflows/wd-zoneb-intake.json) is the FIRST wall every Zone B fact meets, and its
// schema-check is hand-written JS with no compiler. WSK-61 added `schedule.fired` to this validator and the DB CHECK
// but not to that node's KINDS list, so the wake-up hint would have been refused 400 at n8n before it ever reached
// the ERP (found 2026-10-11). This pins the node's list to ZONEB_EVENT_KINDS and runs the node's own code.
// Pure JSON data; no n8n runtime.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ZONEB_EVENT_KINDS, validateZoneBEvent } from "./zoneb-event-schema";

const WORKFLOW = resolve(__dirname, "../../../../automation/workflows/wd-zoneb-intake.json");
const workflow = JSON.parse(readFileSync(WORKFLOW, "utf8")) as { nodes: Array<{ name: string; parameters: { jsCode?: string } }> };
const code = workflow.nodes.find((n) => n.name === "Parse + schema-check")?.parameters.jsCode ?? "";

/** Runs the n8n Code node as n8n would: `$json.rawBody` in, `[{ json }]` out. */
function runNode(body: unknown): { valid: boolean; reason?: string } {
  const fn = new Function("$json", code) as (j: { rawBody: string }) => Array<{ json: { valid: boolean; reason?: string } }>;
  return fn({ rawBody: JSON.stringify(body) })[0].json;
}

const TENANT = "019fb652-c68b-7000-8000-000000000001";
const scheduleFired = {
  eventId: "a".repeat(64),
  kind: "schedule.fired",
  tenantId: TENANT,
  originSite: "webdesk",
  occurredAt: "2026-10-11T12:00:00.000Z",
  data: {
    tenantSlug: "gaiada",
    siteId: "019fb652-c68b-7000-8000-000000000002",
    transition: "publish",
    approvalId: null,
    items: [{ itemId: "019fb652-c68b-7000-8000-000000000003", version: 2, effectiveAt: "2026-10-11T12:00:00.000Z" }],
  },
};

describe("wd-zoneb-intake.json schema-check vs ZONEB_EVENT_KINDS", () => {
  it("finds the node's code", () => {
    expect(code).toContain("const KINDS = [");
  });

  it("the node's KINDS list is exactly the ERP's kinds", () => {
    const m = /const KINDS = \[([^\]]*)\]/.exec(code);
    expect(m).not.toBeNull();
    const nodeKinds = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(nodeKinds).toEqual([...ZONEB_EVENT_KINDS].sort());
  });

  it("a schedule.fired the ERP accepts passes the node too", () => {
    expect(validateZoneBEvent(TENANT, scheduleFired).ok).toBe(true);
    expect(runNode(scheduleFired)).toMatchObject({ valid: true });
  });

  it("the node refuses an unknown kind and a schedule.fired without its items (negative controls)", () => {
    expect(runNode({ ...scheduleFired, kind: "schedule.exploded" })).toMatchObject({ valid: false });
    const { items: _items, ...noItems } = scheduleFired.data;
    expect(runNode({ ...scheduleFired, data: noItems })).toMatchObject({ valid: false });
  });

  it("form.received still passes the node unchanged (positive control)", () => {
    const form = { ...scheduleFired, kind: "form.received", data: { siteSlug: "gaiada", formId: "contact", submissionId: "s1", hasAttachments: false } };
    expect(runNode(form)).toMatchObject({ valid: true });
  });
});

import { describe, it, expect } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import service from "../../../../e2e/webdesk-stub/compositions/service.json";
import navigation from "../../../../e2e/webdesk-stub/compositions/navigation.json";
import type { CollectionComposition, FieldDef } from "@/lib/webdeskContentModel";
import { FieldEditor, PROTECTED_HINT, type FormCtx } from "./FieldEditor";

// WSK-49d — the field form in CLIENT MODE: `ctx.clientEditable` is the BFF's `clientEditable.fields` map. These are NEW tests in a new
// file on purpose: the staff suite (FieldEditor.test.tsx) runs unchanged, which is the proof the staff form did not move.
const defs = (c: unknown) => (c as CollectionComposition).fields as FieldDef[];
const ptr = (p: string) => document.querySelector(`[data-pointer="/blocks/0/props/${p}"]`) as HTMLInputElement;

function Harness({ composition, initial, ctx }: { composition: unknown; initial: Record<string, unknown>; ctx?: Partial<FormCtx> }) {
  const [v, setV] = useState(initial);
  return <FieldEditor defs={defs(composition)} value={v} onChange={setV} ctx={{ issues: [], readOnly: false, neutralLock: false, neutralLocale: "en", ...ctx }} />;
}

const SVC = { url: "/services/seo/", h1: "SEO", template: "service", phase: "L", publish_ready: true, plan: { action: "SHOW", why: "core" }, schema: ["Service"], body: "hello" };
// h1, body and plan.why are the client's; everything else is Gaiada's. A MISSING entry (e.g. `phase`) must read as protected.
const SVC_EDITABLE = { h1: true, body: true, plan: false, "plan.action": false, "plan.why": true, url: false, template: false, publish_ready: false, schema: false };

describe("client mode: read-only fields and the reason", () => {
  it("an editable field is a normal input; a protected one is read-only AND says why (announced, not just greyed)", () => {
    render(<Harness composition={service} initial={SVC} ctx={{ clientEditable: SVC_EDITABLE }} />);
    expect(ptr("h1").readOnly).toBe(false);
    expect(ptr("url").readOnly).toBe(true);
    expect(ptr("url").getAttribute("aria-readonly")).toBe("true");
    // the reason is attached to the control (aria-describedby) so a screen reader hears it with the field
    const described = ptr("url").getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described!.split(" ").pop()!)?.textContent).toContain(PROTECTED_HINT);
    expect(PROTECTED_HINT).toBe("Managed by Gaiada.");
  });

  it("a select and a checkbox that are protected are disabled", () => {
    render(<Harness composition={service} initial={SVC} ctx={{ clientEditable: SVC_EDITABLE }} />);
    expect((ptr("template") as unknown as HTMLSelectElement).disabled).toBe(true);
    expect(ptr("publish_ready").disabled).toBe(true);
  });

  it("a MISSING entry in the map is protected (every doubt answers read-only)", () => {
    render(<Harness composition={service} initial={SVC} ctx={{ clientEditable: SVC_EDITABLE }} />);
    expect(ptr("phase").getAttribute("aria-readonly") ?? (ptr("phase") as unknown as HTMLSelectElement).disabled).toBeTruthy();
  });

  it("a member can be editable inside a group that is not: plan.why edits, plan.action does not", () => {
    render(<Harness composition={service} initial={SVC} ctx={{ clientEditable: SVC_EDITABLE }} />);
    expect(ptr("plan/why").readOnly).toBe(false);
    expect((ptr("plan/action") as unknown as HTMLSelectElement | HTMLInputElement).hasAttribute("disabled") || ptr("plan/action").readOnly).toBe(true);
  });

  it("typing into an editable field changes it; typing into a protected one cannot change its value", () => {
    render(<Harness composition={service} initial={SVC} ctx={{ clientEditable: SVC_EDITABLE }} />);
    fireEvent.change(ptr("h1"), { target: { value: "New H1" } });
    expect(ptr("h1").value).toBe("New H1");
    expect(ptr("url").readOnly).toBe(true);
    expect(ptr("url").value).toBe("/services/seo/");
  });

  it("without the map the form is the staff form: nothing is protected and no 'Managed by Gaiada' appears", () => {
    render(<Harness composition={service} initial={SVC} />);
    expect(ptr("url").readOnly).toBe(false);
    expect(document.body.textContent).not.toContain("Managed by Gaiada");
  });

  it("a field with help text of its own still says it is Gaiada's", () => {
    const withHelp = { fields: [{ name: "h1", primitive: "text", ui: { help: "The page's main heading." } }] };
    render(<Harness composition={withHelp} initial={{ h1: "x" }} ctx={{ clientEditable: { h1: false } }} />);
    const el = document.getElementById(ptr("h1").getAttribute("aria-describedby")!.split(" ").pop()!)!;
    expect(el.textContent).toContain("The page's main heading.");
    expect(el.textContent).toContain("Managed by Gaiada.");
  });
});

describe("client mode: a list of rows that holds Gaiada's members is fixed", () => {
  const NAV = { primary: [{ label: "Services", url: "/services/", children: ["/a/"] }, { label: "Work", url: "/work/", children: [] }], cta: { label: "Audit", url: "/free-audit/" } };
  const E = { primary: true, "primary.label": true, "primary.hub": true, "primary.url": false, "primary.children": false, cta: false, "cta.label": false, "cta.url": false, footer_extra: false };

  it("no add, remove or reorder; the editable member of each row still edits", () => {
    render(<Harness composition={navigation} initial={NAV} ctx={{ clientEditable: E }} />);
    expect(screen.queryByRole("button", { name: /^Remove /i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Add /i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Reorder/i })).toBeNull();
    expect(screen.getByText(/Rows are added, removed and reordered by Gaiada/)).toBeTruthy();
    expect(ptr("primary/0/label").readOnly).toBe(false);
    expect(ptr("primary/0/url").readOnly).toBe(true);
    fireEvent.change(ptr("primary/0/label"), { target: { value: "Our services" } });
    expect(ptr("primary/0/label").value).toBe("Our services");
  });

  it("a list the BFF marks protected as a whole is locked too, with the reason, and its editable members still edit", () => {
    render(<Harness composition={navigation} initial={NAV} ctx={{ clientEditable: { ...E, primary: false } }} />);
    expect(screen.queryByRole("button", { name: /^Remove /i })).toBeNull();
    expect(screen.getAllByText("Managed by Gaiada.").length).toBeGreaterThan(0);
    expect(ptr("primary/1/label").readOnly).toBe(false);
  });

  it("when every member is the client's the list keeps its add / remove / reorder", () => {
    const all = { primary: true, "primary.label": true, "primary.hub": true, "primary.url": true, "primary.children": true, cta: false, "cta.label": false, "cta.url": false, footer_extra: false };
    render(<Harness composition={navigation} initial={NAV} ctx={{ clientEditable: all }} />);
    expect(screen.getAllByRole("button", { name: /^Remove /i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Add item$/i })).toBeTruthy();
  });
});

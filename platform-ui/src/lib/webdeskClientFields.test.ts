import { describe, expect, it } from "vitest";
import navigation from "../../e2e/webdesk-stub/compositions/navigation.json";
import service from "../../e2e/webdesk-stub/compositions/service.json";
import type { CollectionComposition, FieldDef } from "./webdeskContentModel";
import { clientFieldsToSend } from "./webdeskClientFields";

const defsOf = (c: unknown) => (c as CollectionComposition).fields as FieldDef[];
const SVC = defsOf(service);
const NAV = defsOf(navigation);

const BASE = { url: "/services/seo/", h1: "SEO", template: "service", plan: { action: "SHOW", why: "core" }, schema: ["Service"], body: "hello" };

describe("clientFieldsToSend: the `fields` a client save sends", () => {
  it("takes editable leaves from the draft and protected ones from the BASELINE, byte for byte", () => {
    const draft = { ...BASE, h1: "SEO in Bali", template: "TAMPERED", plan: { action: "HIDE", why: "core" } };
    const out = clientFieldsToSend(SVC, { h1: true, body: true, url: false, template: false, plan: false, "plan.action": false, "plan.why": true, schema: false }, BASE, draft);
    expect(out.h1).toBe("SEO in Bali");
    expect(out.template).toBe("service"); // protected: the draft's change is never sent
    expect(out.url).toBe("/services/seo/");
    expect(out.plan).toEqual({ action: "SHOW", why: "core" }); // a protected member inside a group goes back as read
  });

  it("a missing entry is NOT editable (every doubt answers read-only)", () => {
    const out = clientFieldsToSend(SVC, { h1: true }, BASE, { ...BASE, h1: "X", body: "changed" });
    expect(out.h1).toBe("X");
    expect(out.body).toBe("hello");
  });

  it("an editable field the client cleared is dropped from the object (absent on the wire)", () => {
    const { h1: _h1, ...cleared } = BASE;
    void _h1;
    const out = clientFieldsToSend(SVC, { h1: true }, BASE, cleared);
    expect("h1" in out).toBe(false);
    expect(out.url).toBe("/services/seo/");
  });

  it("a member can be editable inside a group that is not: the member's own verdict wins", () => {
    const out = clientFieldsToSend(SVC, { plan: false, "plan.action": false, "plan.why": true }, BASE, { ...BASE, plan: { action: "HIDE", why: "new reason" } });
    expect(out.plan).toEqual({ action: "SHOW", why: "new reason" });
  });

  it("a list of groups: same rows merge member by member; a protected member never moves", () => {
    const base = { primary: [{ label: "Services", url: "/services/", children: ["/a/"] }, { label: "Work", url: "/work/", children: [] }], cta: { label: "Audit", url: "/free-audit/" } };
    const draft = { primary: [{ label: "Our services", url: "/HACK/", children: ["/a/"] }, { label: "Work", url: "/work/", children: [] }], cta: base.cta };
    const out = clientFieldsToSend(NAV, { primary: false, "primary.label": true, "primary.url": false, "primary.children": false, cta: false, "cta.label": false, "cta.url": false }, base, draft);
    expect((out.primary as { label: string; url: string }[])[0]).toEqual({ label: "Our services", url: "/services/", children: ["/a/"] });
    expect((out.primary as unknown[]).length).toBe(2);
  });

  it("a list that holds Gaiada's members cannot be restructured: rows added or removed keep the baseline", () => {
    const base = { primary: [{ label: "A", url: "/a/", children: [] }], cta: { label: "x", url: "/y/" } };
    const draft = { primary: [{ label: "A", url: "/a/", children: [] }, { label: "B", url: "/b/", children: [] }], cta: base.cta };
    const out = clientFieldsToSend(NAV, { primary: false, "primary.label": true, "primary.url": false, "primary.children": false }, base, draft);
    expect(out.primary).toEqual(base.primary);
  });

  it("a list whose every member is the client's may grow", () => {
    const base = { primary: [{ label: "A", url: "/a/", children: [] }], cta: { label: "x", url: "/y/" } };
    const draft = { primary: [...base.primary, { label: "B", url: "/b/", children: [] }], cta: base.cta };
    const out = clientFieldsToSend(NAV, { primary: true, "primary.label": true, "primary.url": true, "primary.children": true }, base, draft);
    expect((out.primary as unknown[]).length).toBe(2);
  });

  it("CREATE (an empty baseline): nothing protected is set, and an untouched protected group is ABSENT, not `{}`", () => {
    const draft = { h1: "New page", url: "", plan: {}, schema: [], publish_ready: false };
    const out = clientFieldsToSend(SVC, { h1: true, url: false, plan: false, "plan.action": false, "plan.why": false, schema: false, publish_ready: false }, {}, draft);
    expect(out).toEqual({ h1: "New page" });
  });

  it("never mutates its inputs", () => {
    const base = JSON.parse(JSON.stringify(BASE));
    const draft = JSON.parse(JSON.stringify({ ...BASE, h1: "Z" }));
    clientFieldsToSend(SVC, { h1: true }, base, draft);
    expect(base).toEqual(BASE);
    expect(draft).toEqual({ ...BASE, h1: "Z" });
  });
});

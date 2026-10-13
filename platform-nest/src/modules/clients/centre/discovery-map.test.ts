// PV6-04 (CC-D6) — the discovery → Business-profile map. Pure, DB-free.
import { describe, it, expect } from "vitest";
import { ALL_QUESTIONNAIRE_FIELDS } from "../../../core/agency-discovery-questionnaire";
import registry from "./registry.json";
import type { ProfileState } from "./validation";
import { DISCOVERY_MAP, answerText, planDiscoveryFill, valueFor } from "./discovery-map";

const questionIds = new Set(ALL_QUESTIONNAIRE_FIELDS.map((f) => String(f.id)));
const registryKeys = new Set(Object.keys(registry.fields as Record<string, unknown>));
const emptyProfileState = (): ProfileState => ({ businessType: "other", profile: {}, connections: {}, areas: {}, customConnections: {} });
const entry = (to: string) => {
  const e = DISCOVERY_MAP.find((m) => m.to === to);
  if (!e) throw new Error(`no map row for ${to}`);
  return e;
};

describe("discovery-map parity", () => {
  it("every source id is a real questionnaire field and every target a real registry field", () => {
    expect(questionIds.size).toBeGreaterThan(100); // guards the guard
    for (const m of DISCOVERY_MAP) {
      for (const id of m.from) expect(questionIds.has(id), `${m.to} reads unknown answer id ${id}`).toBe(true);
      expect(registryKeys.has(m.to), `target ${m.to} is not a registry field`).toBe(true);
    }
  });

  it("every row states its reason, every target appears once, labelled rows have a label per source", () => {
    expect(new Set(DISCOVERY_MAP.map((m) => m.to)).size).toBe(DISCOVERY_MAP.length);
    for (const m of DISCOVERY_MAP) {
      expect(m.reason.length, m.to).toBeGreaterThan(10);
      if (m.join === "labelled") expect(m.labels?.length, m.to).toBe(m.from.length);
    }
  });

  it("the false friend: AD-3 platform feeds cms, never the e-commerce platform", () => {
    expect(entry("cms").from).toEqual(["platform"]);
    expect(DISCOVERY_MAP.some((m) => m.to === "platform")).toBe(false);
  });

  it("project-brief answers are not mapped (visual sliders, sitemap, scope, governance)", () => {
    const sources = new Set(DISCOVERY_MAP.flatMap((m) => m.from));
    for (const id of ["vis_minimal_expressive", "voice_expert_approachable", "pages_required", "in_scope", "decision_makers", "budget_range", "anything_else", "has_brand_guidelines", "logo_files"]) {
      expect(sources.has(id), id).toBe(false);
    }
  });
});

describe("discovery-map values", () => {
  it("joins a choice array with commas and skips empty / non-answers", () => {
    expect(answerText(["B2B", "B2C"])).toBe("B2B, B2C");
    expect(answerText(" x ")).toBe("x");
    for (const v of ["", "  ", "none", "N/A", "To be defined", [], undefined, null, 4, { a: 1 }]) expect(answerText(v)).toBeNull();
    expect(valueFor(entry("languages"), { languages: ["English", "Bahasa Indonesia"] })).toBe("English, Bahasa Indonesia");
    expect(valueFor(entry("website"), { current_url: "none" })).toBeNull();
  });

  it("a platform answer that names no platform is not written to cms", () => {
    expect(valueFor(entry("cms"), { platform: "WordPress" })).toBe("WordPress");
    expect(valueFor(entry("cms"), { platform: "No preference — recommend the right fit" })).toBeNull();
    expect(valueFor(entry("cms"), { platform: "Keep our current platform" })).toBeNull();
  });

  it("joins several sources explicitly, skipping the missing ones", () => {
    expect(valueFor(entry("voice"), { tone: ["Warm", "Direct"], brand_adjectives: "calm, bold" })).toBe("Tone: Warm, Direct\nBrand: calm, bold");
    expect(valueFor(entry("voice"), { brand_adjectives: "calm" })).toBe("Brand: calm");
    expect(valueFor(entry("trading"), { org_name: "Org" })).toBe("Org");
    expect(valueFor(entry("trading"), { project_name: "Brand", org_name: "Org" })).toBe("Brand");
    expect(valueFor(entry("competitors"), { competitor_1_name: "A (a.test)", competitor_3_name: "C", competitors_other: "D" })).toBe("A (a.test)\nC\nD");
    expect(valueFor(entry("kpis"), {})).toBeNull();
  });
});

describe("planDiscoveryFill", () => {
  const answers = { org_name: "Acme Ltd", current_url: "https://acme.example", platform: "Webflow", market: "Indonesia" };

  it("fills empty keys, and leaves a pre-filled key untouched (named as skipped)", () => {
    const state = emptyProfileState();
    state.profile.legal = "Existing Legal Name";
    const plan = planDiscoveryFill(answers, state);
    expect(plan.fill).toMatchObject({ website: "https://acme.example", cms: "Webflow", markets: "Indonesia", service_area: "Indonesia" });
    expect(plan.fill.legal).toBeUndefined();
    expect(plan.skipped).toContainEqual({ key: "legal", reason: "already filled" });
  });

  it("a whitespace-only existing value counts as empty", () => {
    const state = emptyProfileState();
    state.profile.legal = "   ";
    expect(planDiscoveryFill(answers, state).fill.legal).toBe("Acme Ltd");
  });

  it("a secret-looking answer is skipped and named, the others still fill", () => {
    const plan = planDiscoveryFill({ ...answers, dns_owner: "password: hunter2 at the registrar", offering: "Rooms" }, emptyProfileState());
    expect(plan.fill.domains).toBeUndefined();
    expect(plan.skipped).toContainEqual({ key: "domains", reason: "looks like a credential" });
    expect(plan.fill.products).toBe("Rooms");
    expect(plan.fill.legal).toBe("Acme Ltd");
  });

  it("an over-long answer is skipped with the validator's reason", () => {
    const plan = planDiscoveryFill({ offering: "x".repeat(5001) }, emptyProfileState());
    expect(plan.fill.products).toBeUndefined();
    expect(plan.skipped[0]).toMatchObject({ key: "products" });
    expect(plan.skipped[0].reason).toMatch(/exceeds/);
  });

  it("no answers, no plan", () => {
    expect(planDiscoveryFill({}, emptyProfileState())).toEqual({ fill: {}, skipped: [] });
  });
});

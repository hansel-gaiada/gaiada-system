import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DW-7f-5 — /hr/settings/statutory/[setId]: the set and its parameters from ONE honest read (a refusal refuses both; a 404 is a
// real "no such set"), and RATIFY shown only to hr.policy.ratify, only while the set is unratified, and only after a confirmation
// that says what it does.

const notFound = vi.fn(() => { throw new Error("notFound"); });
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: () => notFound(),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
const me = { userId: "u-1", roles: [] as { role: string; scopeType: string; scopeId: string | null }[], companies: [] };
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => me) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/hrPolicyActions", () => ({ ratifyParameterSet: vi.fn() }));

type Read = { kind: "ok"; data: unknown } | { kind: "forbidden" } | { kind: "unavailable"; reason: string };
let setRead: Read;
const setSpy = vi.fn();
vi.mock("@/lib/hr-full-data", () => ({
  getParameterSetResult: vi.fn(async (_u: string, _t: string, id: string) => { setSpy(id); return setRead; }),
}));

const detail = (over: Record<string, unknown> = {}) => ({
  id: "s1", name: "Indonesia 2026", countryCode: "ID", effectiveFrom: "2026-01-01", effectiveTo: null, ratifiedBy: null, ratifiedAt: null,
  sourceNote: "PMK 168/2023", parameterCount: 2, ratified: false,
  parameters: [
    { key: "bpjs.kes.rate", valueNum: "0.040000", valueJson: null, unit: "rate", note: "Employer share" },
    { key: "tax.brackets", valueNum: null, valueJson: [{ upTo: 60000000, rate: 0.05 }], unit: null, note: null },
  ],
  ...over,
});

import HrStatutorySetPage from "./page";

const as = (role: string) => { me.roles = [{ role, scopeType: "company", scopeId: "co-a" }]; };
async function renderPage(setId = "s1") {
  render(await HrStatutorySetPage({ params: Promise.resolve({ setId }) }));
}
const buttons = () => screen.queryAllByRole("button").map((b) => b.textContent).filter((t) => t !== "?");

beforeEach(() => { notFound.mockClear(); setSpy.mockReset(); setRead = { kind: "ok", data: detail() }; });
afterEach(() => cleanup());

describe("/hr/settings/statutory/[setId]", () => {
  it("shows the set and its parameters as the server returned them, a JSON value as JSON", async () => {
    as("company_admin");
    await renderPage();
    expect(setSpy).toHaveBeenCalledWith("s1");
    expect(screen.getByText("bpjs.kes.rate")).toBeInTheDocument();
    expect(screen.getByText("0.040000")).toBeInTheDocument();
    expect(screen.getByText('[{"upTo":60000000,"rate":0.05}]')).toBeInTheDocument();
    expect(screen.getByText("Source: PMK 168/2023")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← All statutory parameter sets" })).toHaveAttribute("href", "/hr/settings?tab=statutory");
  });

  it("is a 404 only when the server says there is no such set", async () => {
    as("company_admin");
    setRead = { kind: "ok", data: null };
    await expect(renderPage("nope")).rejects.toThrow("notFound");
  });

  it("says a refused or failed read in words, never a 404 and never an empty parameter table", async () => {
    as("company_admin");
    setRead = { kind: "forbidden" };
    await renderPage();
    expect(screen.getByText(/You don't have access to this statutory parameter set/)).toBeInTheDocument();
    expect(notFound).not.toHaveBeenCalled();
    cleanup();
    setRead = { kind: "unavailable", reason: "platform 500" };
    await renderPage();
    expect(screen.getByText(/This statutory parameter set cannot be read right now/)).toBeInTheDocument();
    expect(screen.queryByText(/holds no parameters/)).toBeNull();
  });

  it("offers Ratify to hr.policy.ratify (company administrator) on an unratified set, behind a confirmation that says what it does", async () => {
    as("company_admin");
    await renderPage();
    expect(buttons()).toContain("Ratify this set");
    fireEvent.click(screen.getByRole("button", { name: "Ratify this set" }));
    expect(screen.getByRole("group", { name: "Ratify Indonesia 2026" })).toHaveTextContent("Payroll will use these parameters without an override from now on");
  });

  it("does not offer Ratify to the HR manager, who holds hr.policy.manage but not hr.policy.ratify, and says why", async () => {
    as("hr_manager");
    await renderPage();
    expect(buttons()).not.toContain("Ratify this set");
    expect(screen.getByRole("note")).toHaveTextContent("company-administrator act at high assurance");
  });

  it("does not offer Ratify on a ratified set, whoever is looking: the first signature is the one that counts", async () => {
    as("company_admin");
    setRead = { kind: "ok", data: detail({ ratified: true, ratifiedAt: "2026-02-01T09:00:00Z" }) };
    await renderPage();
    expect(buttons()).not.toContain("Ratify this set");
    expect(screen.getByRole("note")).toHaveTextContent("cannot be signed again");
    expect(screen.getAllByText("Ratified").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("2026-02-01")).toBeInTheDocument();
  });

  it("says a set with no parameters holds none", async () => {
    as("hr_manager");
    setRead = { kind: "ok", data: detail({ parameters: [] }) };
    await renderPage();
    expect(screen.getByText(/This set holds no parameters/)).toBeInTheDocument();
  });
});

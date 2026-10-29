import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// AIP-13b (BFF section 65): a unit's assistant guidance page. The view is the server's (the custom text, the default, the exact block the assistant
// reads, who changed it, whether the company uses department guidance); the form is a mirror and shows only to a person who may edit; and a refusal,
// a missing department and a failed read are each said as such, never an empty form.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn(() => { throw new Error("notFound"); }), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/assistantGuidanceActions", () => ({ savePreambleAction: vi.fn() }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<typeof import("@/lib/platform")>()), getMe: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/campaigns-data", () => ({ readOrgRoot: vi.fn() }));
vi.mock("@/lib/assistantGuidance-data", () => ({ getAssistantPreamble: vi.fn() }));

import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { readOrgRoot } from "@/lib/campaigns-data";
import { getAssistantPreamble, type GuidanceRead } from "@/lib/assistantGuidance-data";
import type { PreambleView } from "@/lib/assistantGuidance";
import { agencyTree, lead, me as meFixture, member } from "@/lib/workspaceFixtures";
import DepartmentAssistantGuidancePage from "./page";

const DEFAULT = "Web Dev default: say which build.";
const previewOf = (text: string | null) => (text === null ? null : `You are helping someone in the Web Dev department.\n\nDepartment guidance:\n${text}`);
const defaultView = (over: Partial<PreambleView> = {}): PreambleView => ({
  unitNodeId: "d-web", department: { name: "Web Dev", key: "web-dev" }, custom: null, defaultText: DEFAULT, effective: DEFAULT,
  updatedAt: null, updatedBy: null, preview: previewOf(DEFAULT), contextEnabled: true, ...over,
});
const customView = (): PreambleView =>
  defaultView({ custom: "Our own rule.", effective: "Our own rule.", updatedAt: "2026-10-29T10:00:00.000Z", updatedBy: { id: "u1", name: "Ketut Arta" }, preview: previewOf("Our own rule.") });
const ok = (data: PreambleView): GuidanceRead => ({ kind: "ok", data });

const as = {
  member: meFixture([member()]),
  head: meFixture([member(), lead("d-web")]),
  sibling: meFixture([member(), lead("d-seo")]),
  admin: meFixture([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]),
  owner: meFixture([{ role: "owner", scopeType: "company", scopeId: "co-a" }]),
};
const mount = async (who: keyof typeof as, deptId = "d-web") => {
  vi.mocked(getMe).mockResolvedValue(as[who]);
  return render(await DepartmentAssistantGuidancePage({ params: Promise.resolve({ deptId }) }));
};
const form = () => screen.queryByRole("textbox", { name: /what the assistant should know/i });
const preview = () => document.querySelector(".ag-preview")?.textContent;

beforeEach(() => {
  vi.mocked(getActiveTenant).mockReset().mockResolvedValue("co-a");
  vi.mocked(readOrgRoot).mockReset().mockResolvedValue(agencyTree() as never);
  vi.mocked(getAssistantPreamble).mockReset().mockResolvedValue(ok(defaultView()));
});

describe("what is asked of the platform", () => {
  it("reads this department's guidance for the signed-in person in the active company", async () => {
    await mount("admin");
    expect(getAssistantPreamble).toHaveBeenCalledWith("u-1", "co-a", "d-web");
  });
});

describe("the default state", () => {
  it("names the department, says it is the default, starts the text from it and shows the server's preview exactly", async () => {
    await mount("head");
    expect(screen.getByRole("heading", { name: /Department guidance/ })).toBeInTheDocument();
    expect(document.querySelector(".ag-state")).toHaveTextContent("Web Dev uses the default text.");
    expect((form() as HTMLTextAreaElement).value).toBe(DEFAULT);
    expect(screen.getByRole("heading", { name: "What the assistant reads" })).toBeInTheDocument();
    expect(preview()).toBe(previewOf(DEFAULT));
    expect(screen.getByText(/Everyone who uses the assistant in this department gets this text/)).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});

describe("the custom state", () => {
  it("says it is the company's own, starts from it, names who changed it and when, and shows the preview", async () => {
    vi.mocked(getAssistantPreamble).mockResolvedValue(ok(customView()));
    await mount("head");
    expect(document.querySelector(".ag-state")).toHaveTextContent("Web Dev uses the company's own text.");
    expect((form() as HTMLTextAreaElement).value).toBe("Our own rule.");
    expect(preview()).toBe(previewOf("Our own rule."));
    expect(screen.getByText("Last changed by Ketut Arta on 29 Oct 2026.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use the default" })).toBeEnabled();
  });
});

describe("department guidance is off in this company", () => {
  it("says the assistant does not use it yet, and still offers the form", async () => {
    vi.mocked(getAssistantPreamble).mockResolvedValue(ok(defaultView({ contextEnabled: false })));
    await mount("admin");
    expect(screen.getByRole("note")).toHaveTextContent("The assistant does not use department guidance in this company yet");
    expect(form()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});

describe("a refusal, a missing department and a failed read", () => {
  it("403: says only the head or a company admin can change this, and draws no form and no text", async () => {
    vi.mocked(getAssistantPreamble).mockResolvedValue({ kind: "forbidden" });
    await mount("member");
    expect(screen.getByText("Only this department's head or a company admin can change this.")).toBeInTheDocument();
    expect(form()).not.toBeInTheDocument();
    expect(preview()).toBeUndefined();
  });
  it("404: says the department is not found", async () => {
    vi.mocked(getAssistantPreamble).mockResolvedValue({ kind: "not_found" });
    await mount("admin", "d-gone");
    expect(screen.getByText(/This department was not found/)).toBeInTheDocument();
    expect(form()).not.toBeInTheDocument();
  });
  it("a failed read is said as such with the backend's words, and is never an empty form", async () => {
    vi.mocked(getAssistantPreamble).mockResolvedValue({ kind: "unavailable", reason: "platform 500" });
    await mount("admin");
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText(/platform 500/)).toBeInTheDocument();
    expect(form()).not.toBeInTheDocument();
  });
});

describe("the form is shown only to a person who may edit (a mirror; the server decides)", () => {
  it("is offered to the head of this unit, a company admin and the owner", async () => {
    for (const who of ["head", "admin", "owner"] as const) {
      const r = await mount(who);
      expect(form(), who).toBeInTheDocument();
      r.unmount();
    }
  });
  it("is offered to the head of an enclosing unit on a unit below it", async () => {
    const tree = agencyTree();
    vi.mocked(readOrgRoot).mockResolvedValue(tree as never);
    const frontendId = tree.children.find((c) => c.id === "d-web")!.children[0].id;
    await mount("head", frontendId);
    expect(form()).toBeInTheDocument();
  });
  it("is not offered to a member or the head of a sibling: they see the text the assistant reads, read-only", async () => {
    for (const who of ["member", "sibling"] as const) {
      const r = await mount(who);
      expect(form(), who).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
      expect(screen.getByText(/You can see this text but not change it/)).toBeInTheDocument();
      expect(preview(), who).toBe(previewOf(DEFAULT));
      r.unmount();
    }
  });
  it("is not offered to a head when the org tree cannot be read; a company admin and the owner still are", async () => {
    vi.mocked(readOrgRoot).mockResolvedValue(null);
    const first = await mount("head");
    expect(form()).not.toBeInTheDocument();
    first.unmount();
    const second = await mount("admin");
    expect(form()).toBeInTheDocument();
    second.unmount();
    await mount("owner");
    expect(form()).toBeInTheDocument();
  });
});

it("is not found without an active company", async () => {
  vi.mocked(getActiveTenant).mockResolvedValue(null);
  vi.mocked(getMe).mockResolvedValue(as.member);
  await expect(DepartmentAssistantGuidancePage({ params: Promise.resolve({ deptId: "d-web" }) })).rejects.toThrow("notFound");
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Interest rules sub-page: the form is only drawn from a successful read (an empty form on a failed read would let a save wipe the rules);
// the save goes through a server action and a refusal comes back as a sentence.

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/visitors", () => ({ resolveSiteProperty: vi.fn(), readRules: vi.fn() }));
vi.mock("@/lib/visitorsActions", () => ({ saveInterestRulesAction: vi.fn() }));
vi.mock("@/components/webdesk/content/serverCtx", () => ({ requireWebsiteCtx: vi.fn() }));

import { readRules, resolveSiteProperty } from "@/lib/visitors";
import { saveInterestRulesAction } from "@/lib/visitorsActions";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import type { InterestRule } from "@/lib/visitorsModel";
import Page from "./page";

const P = "0194a3b2-aaaa-7000-8000-00000000000a";
const rule = (o: Partial<InterestRule> = {}): InterestRule => ({ id: "r1", match: "path_prefix", pattern: "/services/web/", facet: "service", tag: "web-design", weight: 3, ...o });
const ctxMock = vi.mocked(requireWebsiteCtx);
const siteMock = vi.mocked(resolveSiteProperty);
const rulesMock = vi.mocked(readRules);
const saveMock = vi.mocked(saveInterestRulesAction);
const mount = async () => render(await Page({ params: Promise.resolve({ deptId: "dept-1", tenant: "gaiada", site: "site-1" }) }));

beforeEach(() => {
  ctxMock.mockReset(); siteMock.mockReset(); rulesMock.mockReset(); saveMock.mockReset();
  ctxMock.mockResolvedValue({ userId: "u", me: {}, company: "co-1", deptId: "dept-1", visitorsBase: "/departments/dept-1/website/visitors" } as never);
  siteMock.mockResolvedValue({ kind: "ok", siteName: "gaiada.com", property: { id: P, domain: "gaiada.com", umamiSiteId: "u" } });
});

describe("Website -> Visitors -> Interest rules", () => {
  it("asks for the visitors tab context and draws the saved rules", async () => {
    rulesMock.mockResolvedValue({ state: "ok", data: { propertyId: P, rules: [rule()], note: "Interests come only from these rules." } });
    await mount();
    expect(ctxMock).toHaveBeenCalledWith("dept-1", "visitors");
    expect(screen.getAllByTestId("rule-row")).toHaveLength(1);
    expect((screen.getByDisplayValue("/services/web/") as HTMLInputElement).value).toBe("/services/web/");
    expect(screen.getByTestId("rules-note").textContent).toContain("Interests come only from these rules.");
  });

  it("no rules yet says that no visitor has interests", async () => {
    rulesMock.mockResolvedValue({ state: "ok", data: { propertyId: P, rules: [], note: "No rules yet, so no visitor has any interests." } });
    await mount();
    expect(screen.queryAllByTestId("rule-row")).toHaveLength(0);
    expect(screen.getByTestId("rules-note").textContent).toContain("no visitor has any interests");
  });

  it("a read that failed is words and NO form", async () => {
    rulesMock.mockResolvedValue({ state: "unavailable", message: "The interest rules could not be read. Try again in a moment." });
    await mount();
    expect(screen.getByTestId("rules-unavailable").textContent).toContain("could not be read");
    expect(screen.queryByTestId("interest-rules-form")).toBeNull();
  });

  it("save sends the COMPLETE set through the action and says what the server said", async () => {
    rulesMock.mockResolvedValue({ state: "ok", data: { propertyId: P, rules: [rule()], note: "n" } });
    saveMock.mockResolvedValue({ ok: true, rules: [rule(), rule({ id: "r2", pattern: "/about/", tag: "agency", weight: 2 })], note: "Interests and scores follow the new rules at the next daily refresh." });
    await mount();
    fireEvent.click(screen.getByText("Add a rule"));
    const rows = screen.getAllByTestId("rule-row");
    expect(rows).toHaveLength(2);
    const inputs = rows[1].querySelectorAll("input");
    fireEvent.change(inputs[0], { target: { value: "/about/" } });
    fireEvent.change(inputs[1], { target: { value: "agency" } });
    fireEvent.change(inputs[2], { target: { value: "2" } });
    fireEvent.click(screen.getByText("Save rules"));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith(P, [
      { match: "path_prefix", pattern: "/services/web/", facet: "service", tag: "web-design", weight: 3 },
      { match: "path_prefix", pattern: "/about/", facet: "service", tag: "agency", weight: 2 },
    ]);
    await waitFor(() => expect(screen.getByTestId("rules-ok").textContent).toContain("Saved 2 rules. Interests and scores follow the new rules at the next daily refresh."));
  });

  it("a refusal is one sentence in place, and the rows stay as typed", async () => {
    rulesMock.mockResolvedValue({ state: "ok", data: { propertyId: P, rules: [rule()], note: "n" } });
    saveMock.mockResolvedValue({ ok: false, message: "You are not allowed to change the interest rules." });
    await mount();
    fireEvent.click(screen.getByText("Save rules"));
    await waitFor(() => expect(screen.getByTestId("rules-bad").textContent).toBe("You are not allowed to change the interest rules."));
    expect(screen.getAllByTestId("rule-row")).toHaveLength(1);
  });

  it("an invalid row is refused in words before any round trip", async () => {
    rulesMock.mockResolvedValue({ state: "ok", data: { propertyId: P, rules: [rule()], note: "n" } });
    await mount();
    fireEvent.change(screen.getByDisplayValue("web-design"), { target: { value: "Web Design" } });
    fireEvent.click(screen.getByText("Save rules"));
    expect(screen.getByTestId("rules-bad").textContent).toContain("lower-case letters");
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("removing a row then saving sends the shorter set", async () => {
    rulesMock.mockResolvedValue({ state: "ok", data: { propertyId: P, rules: [rule()], note: "n" } });
    saveMock.mockResolvedValue({ ok: true, rules: [], note: "Interests and scores follow the new rules at the next daily refresh." });
    await mount();
    fireEvent.click(screen.getByLabelText("Remove rule 1"));
    fireEvent.click(screen.getByText("Save rules"));
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith(P, []));
  });

  it("no search property for the site: a sentence and no form", async () => {
    siteMock.mockResolvedValue({ kind: "no_property", siteName: "gaiada.com" });
    await mount();
    expect(screen.getByText(/No search property matches gaiada.com/)).toBeTruthy();
    expect(rulesMock).not.toHaveBeenCalled();
  });
});

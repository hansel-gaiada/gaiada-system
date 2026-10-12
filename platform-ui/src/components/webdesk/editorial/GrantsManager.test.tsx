import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { WdResult } from "@/lib/webdeskContentModel";
import type { EditorialGrant, GrantsBody } from "@/lib/webdeskEditorialModel";

vi.mock("@/lib/webdeskEditorialActions", () => ({ grantRoleAction: vi.fn(), listGrantsAction: vi.fn(), revokeRoleAction: vi.fn() }));

import * as A from "@/lib/webdeskEditorialActions";
import { GrantsManager } from "./GrantsManager";

const a = vi.mocked(A);
const SCOPE = { tenantSlug: "gaiada", siteId: "site-1" };
const PEOPLE = { u5: "Dewi", u6: "Eka", u9: "Putu" };
const ok = <T,>(data: T): WdResult<T> => ({ kind: "ok", data });
const grant = (over: Partial<EditorialGrant> = {}): EditorialGrant => ({
  grantId: "g1", userId: "u5", name: "Dewi", email: "dewi@example.com", role: "webdesk_writer", tenantSlug: "gaiada", siteId: "site-1",
  allCollections: false, collections: ["service"], allLocales: true, locales: [], expiresAt: null, grantedBy: "u9", updatedAt: "2026-10-12T00:00:00Z", ...over,
});
const body = (grants: EditorialGrant[]): GrantsBody => ({ tenantSlug: "gaiada", siteId: "site-1", grants });
const mount = (grants: EditorialGrant[] = [grant()]) => render(<GrantsManager scope={SCOPE} initial={body(grants)} people={PEOPLE} collections={["service", "page"]} locales={["en", "id"]} />);
const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); };
const tid = (id: string) => screen.getByTestId(id) as HTMLButtonElement;

beforeEach(() => { Object.values(a).forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset()); a.listGrantsAction.mockResolvedValue(ok(body([grant()]))); });
afterEach(cleanup);

describe("the grants list", () => {
  it("shows person, role in words, what it covers, expiry and who gave it", () => {
    mount([grant(), grant({ grantId: "g2", userId: "u6", name: "Eka", email: null, role: "webdesk_editor", allCollections: true, collections: [], allLocales: false, locales: ["en"], expiresAt: "2027-01-01T00:00:00Z", grantedBy: null })]);
    const rows = screen.getAllByTestId("grant-row").map((r) => r.textContent ?? "");
    expect(rows[0]).toMatch(/Dewi/);
    expect(rows[0]).toMatch(/Writer/);
    expect(rows[0]).toMatch(/service/);
    expect(rows[0]).toMatch(/every language/);
    expect(rows[0]).toMatch(/never/);
    expect(rows[0]).toMatch(/Putu/);
    expect(rows[1]).toMatch(/Editor/);
    expect(rows[1]).toMatch(/every collection/);
    expect(rows[1]).toMatch(/Jan 2027|01 Jan|2027/);
  });
  it("an empty list says nobody holds a role (a real answer: the read succeeded)", () => {
    mount([]);
    expect(screen.getByTestId("grants-empty").textContent).toMatch(/Nobody holds a writers' room role/);
    expect(screen.queryByTestId("grants-table")).toBeNull();
  });
});

describe("give a role", () => {
  const fill = () => {
    fireEvent.change(screen.getByTestId("grant-person"), { target: { value: "u6" } });
    fireEvent.change(screen.getByTestId("grant-role"), { target: { value: "webdesk_seo_reviewer" } });
  };

  it("the submit button waits for a person, at least one collection (or every) and at least one language (or every)", () => {
    mount();
    const submit = tid("grant-submit");
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("grant-person"), { target: { value: "u6" } });
    expect(submit.disabled).toBe(true); // no collection yet; "every language" is the default
    fireEvent.click(screen.getByLabelText("service"));
    expect(submit.disabled).toBe(false);
    fireEvent.click(screen.getByTestId("grant-all-locales")); // untick: now no language chosen
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("id"));
    expect(submit.disabled).toBe(false);
  });

  it("the chosen role's sentence is shown", () => {
    mount();
    fireEvent.change(screen.getByTestId("grant-role"), { target: { value: "webdesk_translator" } });
    expect(screen.getByTestId("grant-role-sentence").textContent).toMatch(/translations/);
  });

  it("sends exactly one of every/list for collections and for languages, then refreshes the list", async () => {
    a.grantRoleAction.mockResolvedValue(ok({ userId: "u6", role: "webdesk_seo_reviewer", changed: true, createdGrant: true }));
    a.listGrantsAction.mockResolvedValue(ok(body([grant(), grant({ grantId: "g3", userId: "u6", name: "Eka", role: "webdesk_seo_reviewer" })])));
    mount();
    fill();
    fireEvent.click(screen.getByLabelText("service"));
    fireEvent.click(screen.getByLabelText("page"));
    await click(tid("grant-submit"));
    expect(a.grantRoleAction).toHaveBeenCalledWith(SCOPE, { userId: "u6", role: "webdesk_seo_reviewer", allCollections: false, collections: ["service", "page"], allLocales: true, locales: [], expiresAt: null });
    expect(a.listGrantsAction).toHaveBeenCalled();
    expect(screen.getAllByTestId("grant-row")).toHaveLength(2);
    expect(screen.getByTestId("grants-ok").textContent).toMatch(/SEO reviewer given to Eka on this site\. They are signed out/);
  });

  it("every collection + chosen languages + an expiry date", async () => {
    a.grantRoleAction.mockResolvedValue(ok({ userId: "u6", role: "webdesk_writer", changed: true }));
    mount();
    fireEvent.change(screen.getByTestId("grant-person"), { target: { value: "u6" } });
    fireEvent.click(screen.getByTestId("grant-all-collections"));
    fireEvent.click(screen.getByTestId("grant-all-locales"));
    fireEvent.click(screen.getByLabelText("en"));
    fireEvent.change(screen.getByTestId("grant-expires"), { target: { value: "2099-12-31" } });
    await click(tid("grant-submit"));
    expect(a.grantRoleAction).toHaveBeenCalledWith(SCOPE, { userId: "u6", role: "webdesk_writer", allCollections: true, collections: [], allLocales: false, locales: ["en"], expiresAt: "2099-12-31T23:59:59.000Z" });
  });

  it("an expiry in the past is refused on the form, before anything is sent", async () => {
    mount();
    fireEvent.change(screen.getByTestId("grant-person"), { target: { value: "u6" } });
    fireEvent.click(screen.getByTestId("grant-all-collections"));
    fireEvent.change(screen.getByTestId("grant-expires"), { target: { value: "2020-01-01" } });
    await click(tid("grant-submit"));
    expect(a.grantRoleAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("grants-bad").textContent).toMatch(/has to be in the future/);
  });

  it("'changed: false' says nothing changed", async () => {
    a.grantRoleAction.mockResolvedValue(ok({ userId: "u6", role: "webdesk_writer", changed: false }));
    mount();
    fireEvent.change(screen.getByTestId("grant-person"), { target: { value: "u6" } });
    fireEvent.click(screen.getByTestId("grant-all-collections"));
    await click(tid("grant-submit"));
    expect(screen.getByTestId("grants-ok").textContent).toMatch(/already had exactly this\. Nothing changed/);
  });

  it.each([
    ["self_grant_forbidden: a principal may not grant a role to themselves", /give a writers' room role to yourself/],
    ["editorial_target_not_eligible: the target is not an active user", /active employee/],
    ["unknown_collection: the site has no collection \"x\"", /collections you picked doesn't exist/],
  ])("400 %s is shown in words and the form keeps its values", async (message, re) => {
    a.grantRoleAction.mockResolvedValue({ kind: "invalid", issues: [], message });
    mount();
    fireEvent.change(screen.getByTestId("grant-person"), { target: { value: "u6" } });
    fireEvent.click(screen.getByTestId("grant-all-collections"));
    await click(tid("grant-submit"));
    expect(screen.getByTestId("grants-bad").textContent).toMatch(re);
    expect((screen.getByTestId("grant-person") as HTMLSelectElement).value).toBe("u6");
  });

  it("409 expiry mismatch, 403 and 503 are words", async () => {
    mount();
    fireEvent.change(screen.getByTestId("grant-person"), { target: { value: "u6" } });
    fireEvent.click(screen.getByTestId("grant-all-collections"));
    a.grantRoleAction.mockResolvedValueOnce({ kind: "conflict", slug: "editorial_grant_expiry_mismatch", message: "editorial_grant_expiry_mismatch", currentHeadVersion: null, currentContentHash: null, updatedAt: null });
    await click(tid("grant-submit"));
    expect(screen.getByTestId("grants-bad").textContent).toMatch(/different expiry date.*Remove the role first/);
    a.grantRoleAction.mockResolvedValueOnce({ kind: "forbidden", reason: "x" });
    await click(tid("grant-submit"));
    expect(screen.getByTestId("grants-bad").textContent).toMatch(/can't manage writers on this site/);
    a.grantRoleAction.mockResolvedValueOnce({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" });
    await click(tid("grant-submit"));
    expect(screen.getByTestId("grants-bad").textContent).toMatch(/can't be reached right now\. Nothing was changed/);
  });

  it("a write that went through but whose refresh failed says so (the list may be old)", async () => {
    a.grantRoleAction.mockResolvedValue(ok({ userId: "u6", role: "webdesk_writer", changed: true }));
    a.listGrantsAction.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" });
    mount();
    fireEvent.change(screen.getByTestId("grant-person"), { target: { value: "u6" } });
    fireEvent.click(screen.getByTestId("grant-all-collections"));
    await click(tid("grant-submit"));
    expect(screen.getByTestId("grants-warn").textContent).toMatch(/went through, but the list couldn't be refreshed/);
  });

  it("an unconfirmed outcome says so and re-reads the list", async () => {
    a.grantRoleAction.mockResolvedValue({ kind: "unavailable", code: "upstream_error", reason: "not_observed" });
    mount();
    fireEvent.change(screen.getByTestId("grant-person"), { target: { value: "u6" } });
    fireEvent.click(screen.getByTestId("grant-all-collections"));
    await click(tid("grant-submit"));
    expect(screen.getByTestId("grants-bad").textContent).toMatch(/couldn't confirm whether that was saved/);
    expect(a.listGrantsAction).toHaveBeenCalled();
  });
});

describe("remove a role", () => {
  it("asks first, names the role and the person, and does nothing until confirmed", async () => {
    mount();
    await click(tid("grant-revoke"));
    expect(a.revokeRoleAction).not.toHaveBeenCalled();
    expect(tid("grant-revoke-confirm").textContent).toBe("Remove Writer from Dewi");
    await click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByTestId("grant-revoke-confirm")).toBeNull();
    expect(a.revokeRoleAction).not.toHaveBeenCalled();
  });

  it("confirming revokes that person's role on this site and refreshes the list", async () => {
    a.revokeRoleAction.mockResolvedValue(ok({ userId: "u5", role: "webdesk_writer", changed: true, removedGrant: true }));
    a.listGrantsAction.mockResolvedValue(ok(body([])));
    mount();
    await click(tid("grant-revoke"));
    await click(tid("grant-revoke-confirm"));
    expect(a.revokeRoleAction).toHaveBeenCalledWith(SCOPE, "u5", "webdesk_writer");
    expect(screen.getByTestId("grants-empty")).toBeTruthy();
    expect(screen.getByTestId("grants-ok").textContent).toBe("Writer removed from Dewi on this site.");
  });

  it("revoking what is not held says nothing changed; a refusal is in words", async () => {
    a.revokeRoleAction.mockResolvedValueOnce(ok({ userId: "u5", role: "webdesk_writer", changed: false, removedGrant: false }));
    mount();
    await click(tid("grant-revoke"));
    await click(tid("grant-revoke-confirm"));
    expect(screen.getByTestId("grants-ok").textContent).toMatch(/didn't hold that role any more\. Nothing changed/);
    a.revokeRoleAction.mockResolvedValueOnce({ kind: "forbidden", reason: "x" });
    await click(within(screen.getAllByTestId("grant-row")[0]).getByTestId("grant-revoke"));
    await click(tid("grant-revoke-confirm"));
    expect(screen.getByTestId("grants-bad").textContent).toMatch(/can't manage writers on this site/);
  });
});

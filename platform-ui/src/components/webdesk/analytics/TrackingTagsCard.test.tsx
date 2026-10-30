import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// The Tracking tags card: the value (or "Not set") only for an answer that said so, words for everything else, the editor only for a
// viewer who may change it, digits-only validation before any request, every refusal in words, and the next-rebuild help text.

vi.mock("@/lib/trackingTagsActions", () => ({ saveLinkedinPartnerIdAction: vi.fn() }));

import { saveLinkedinPartnerIdAction } from "@/lib/trackingTagsActions";
import { TAGS_HELP, type TrackingTagsView } from "@/lib/trackingTagsModel";
import { TrackingTagsCard, type TrackingTagsRead } from "./TrackingTagsCard";

const save = vi.mocked(saveLinkedinPartnerIdAction);
const target = { repo: "gaiadabali/gaiada-web-revamp", variable: "PUBLIC_LINKEDIN_PARTNER_ID" };
const view = (over: Partial<TrackingTagsView> = {}): TrackingTagsRead => ({
  state: "ok",
  data: { linkedin: { partnerId: null }, target, canManage: true, state: "ok", reason: null, ...over },
});
const mount = (read: TrackingTagsRead, canEdit = true) =>
  render(<TrackingTagsCard propertyId="p-1" webdeskTenant="gaiada" site="site-1" read={read} canEdit={canEdit} />);

beforeEach(() => { save.mockReset(); });

describe("TrackingTagsCard", () => {
  it("shows 'Not set', the repository it lives on, and the help text", () => {
    mount(view());
    expect(screen.getByTestId("tracking-tags-value").textContent).toBe("Not set");
    expect(screen.getByTestId("tracking-tags-target").textContent).toContain("gaiadabali/gaiada-web-revamp");
    expect(screen.getByTestId("tracking-tags-target").textContent).toContain("PUBLIC_LINKEDIN_PARTNER_ID");
    expect(screen.getByTestId("tracking-tags-help").textContent).toBe(TAGS_HELP);
    expect(screen.getByTestId("tracking-tags-help").textContent).toContain("next rebuild");
  });

  it("shows the stored id", () => {
    mount(view({ linkedin: { partnerId: "778899" } }));
    expect(screen.getByTestId("tracking-tags-value").textContent).toBe("778899");
  });

  it("a failed read is a sentence and NEVER 'Not set' or an editor", () => {
    mount({ state: "unavailable", message: "The tracking tags could not be read: GitHub is down." });
    expect(screen.getByTestId("tracking-tags-unavailable").textContent).toContain("could not be read");
    expect(screen.queryByTestId("tracking-tags-value")).toBeNull();
    expect(screen.queryByTestId("tracking-tags-form")).toBeNull();
    expect(screen.queryByText("Not set")).toBeNull();
  });

  it("no build repository: the sentence in place of the value, no editor", () => {
    mount(view({ state: "no_build_target", target: null, canManage: false, reason: "This website has no build repository the ERP can write to yet." }));
    expect(screen.getByTestId("tracking-tags-no_build_target").textContent).toContain("no build repository");
    expect(screen.queryByTestId("tracking-tags-value")).toBeNull();
    expect(screen.queryByTestId("tracking-tags-form")).toBeNull();
  });

  it("GitHub unable to answer: the sentence, and the value is NOT drawn as 'Not set'", () => {
    mount(view({ state: "github_unavailable", reason: "actions_variables: the ERP GitHub App is not allowed to read repository variables." }));
    expect(screen.getByTestId("tracking-tags-github_unavailable").textContent).toContain("actions_variables");
    expect(screen.queryByText("Not set")).toBeNull();
    expect(screen.queryByTestId("tracking-tags-form")).toBeNull();
  });

  it("no editor without the capability, or when the server says canManage is false", () => {
    mount(view(), false);
    expect(screen.queryByTestId("tracking-tags-form")).toBeNull();
    expect(screen.getByTestId("tracking-tags-value")).toBeTruthy();
  });

  it("no editor when the server's canManage is false even if the viewer holds the capability", () => {
    mount(view({ canManage: false }), true);
    expect(screen.queryByTestId("tracking-tags-form")).toBeNull();
  });

  it("Save validates digits first: a bad id shows a plain message and sends nothing", () => {
    mount(view());
    fireEvent.change(screen.getByLabelText("LinkedIn partner id"), { target: { value: "12ab" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByTestId("tracking-tags-bad").textContent).toMatch(/digits only/);
    expect(save).not.toHaveBeenCalled();
  });

  it("Save sends the trimmed id, then shows the server's value and the next-rebuild sentence", async () => {
    save.mockResolvedValue({ ok: true, partnerId: "1234567", result: "set", message: "The LinkedIn partner id 1234567 was saved to gaiadabali/gaiada-web-revamp. It reaches the site at its next rebuild." });
    mount(view());
    fireEvent.change(screen.getByLabelText("LinkedIn partner id"), { target: { value: " 1234567 " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("tracking-tags-ok")).toBeTruthy());
    expect(save).toHaveBeenCalledWith({ propertyId: "p-1", webdeskTenant: "gaiada", site: "site-1", partnerId: "1234567" });
    expect(screen.getByTestId("tracking-tags-value").textContent).toBe("1234567");
    expect(screen.getByTestId("tracking-tags-ok").textContent).toContain("next rebuild");
  });

  it("Clear sends null and the value goes back to 'Not set' only after the server said so; Clear is off when nothing is stored", async () => {
    const { unmount } = mount(view());
    expect((screen.getByRole("button", { name: "Clear" }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    save.mockResolvedValue({ ok: true, partnerId: null, result: "cleared", message: "The LinkedIn partner id was removed. The site stops loading the tag at its next rebuild." });
    mount(view({ linkedin: { partnerId: "42" } }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.getByTestId("tracking-tags-value").textContent).toBe("Not set"));
    expect(save).toHaveBeenCalledWith({ propertyId: "p-1", webdeskTenant: "gaiada", site: "site-1", partnerId: null });
  });

  it("a server refusal is shown in words and the stored value is left alone", async () => {
    save.mockResolvedValue({ ok: false, message: "GitHub refused: the ERP's GitHub App is not allowed to change repository variables yet (permission: actions_variables). Nothing was saved." });
    mount(view({ linkedin: { partnerId: "42" } }));
    fireEvent.change(screen.getByLabelText("LinkedIn partner id"), { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("tracking-tags-bad")).toBeTruthy());
    expect(screen.getByTestId("tracking-tags-bad").textContent).toContain("actions_variables");
    expect(screen.getByTestId("tracking-tags-value").textContent).toBe("42");
  });

  it("an action that throws is still a sentence that says nothing changed", async () => {
    save.mockRejectedValue(new Error("network"));
    mount(view());
    fireEvent.change(screen.getByLabelText("LinkedIn partner id"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("tracking-tags-bad").textContent).toContain("Nothing was changed"));
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// The Tracking tags card: the value (or "Not set") only for an answer that said so, words for everything else, the editor only for a
// viewer who may change it, digits-only validation before any request, every refusal in words, and the next-rebuild help text.

vi.mock("@/lib/trackingTagsActions", () => ({ saveLinkedinPartnerIdAction: vi.fn(), saveGoogleAdsAction: vi.fn() }));

import { saveGoogleAdsAction, saveLinkedinPartnerIdAction } from "@/lib/trackingTagsActions";
import { ADS_HELP, TAGS_HELP, type TrackingTagsView } from "@/lib/trackingTagsModel";
import { TrackingTagsCard, type TrackingTagsRead } from "./TrackingTagsCard";

const save = vi.mocked(saveLinkedinPartnerIdAction);
const saveAds = vi.mocked(saveGoogleAdsAction);
const target = { repo: "gaiadabali/gaiada-web-revamp", variable: "PUBLIC_LINKEDIN_PARTNER_ID" };
const view = (over: Partial<TrackingTagsView> = {}): TrackingTagsRead => ({
  state: "ok",
  data: { linkedin: { partnerId: null }, googleAds: { ids: [], conversions: {} }, target, canManage: true, state: "ok", reason: null, ...over },
});
const mount = (read: TrackingTagsRead, canEdit = true) =>
  render(<TrackingTagsCard propertyId="p-1" webdeskTenant="gaiada" site="site-1" read={read} canEdit={canEdit} />);

beforeEach(() => { save.mockReset(); saveAds.mockReset(); });

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

describe("TrackingTagsCard: Google Ads section (M5-P4g)", () => {
  const stored = { ids: ["AW-123456789", "AW-987654321"], conversions: { lead: "AW-123456789/abc", email: "AW-987654321/e1" } };
  const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const saveBtn = () => screen.getByRole("button", { name: "Save Google Ads" });

  it("read-only without the capability: the values, or 'Not set', and no fields or button", () => {
    mount(view({ googleAds: stored }), false);
    expect(screen.getByTestId("google-ads-ids").textContent).toBe("AW-123456789, AW-987654321");
    expect(screen.getByTestId("google-ads-lead").textContent).toBe("AW-123456789/abc");
    expect(screen.getByTestId("google-ads-email").textContent).toBe("AW-987654321/e1");
    expect(screen.getByTestId("google-ads-whatsapp").textContent).toBe("Not set");
    expect(screen.getByTestId("google-ads-phone").textContent).toBe("Not set");
    expect(screen.queryByTestId("google-ads-form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Google Ads" })).toBeNull();
    expect(screen.getByTestId("google-ads-help").textContent).toBe(ADS_HELP);
  });

  it("read-only with nothing stored says 'Not set' for every field; also read-only when the server's canManage is false", () => {
    mount(view({ canManage: false }), true);
    expect(screen.getByTestId("google-ads-ids").textContent).toBe("Not set");
    expect(screen.queryByTestId("google-ads-form")).toBeNull();
  });

  it("the Google Ads section is not drawn for a failed read or a state that is not ok (no 'Not set' for an unknown)", () => {
    mount({ state: "unavailable", message: "The tracking tags could not be read: GitHub is down." });
    expect(screen.queryByTestId("google-ads")).toBeNull();
  });

  it("manager mode: the ids field, four labelled conversion fields and one Save, filled from the stored values; the LinkedIn editor stays", () => {
    mount(view({ googleAds: stored }));
    expect((screen.getByLabelText("Google Ads tag ids") as HTMLTextAreaElement).value).toBe("AW-123456789\nAW-987654321");
    expect((screen.getByLabelText("Form lead") as HTMLInputElement).value).toBe("AW-123456789/abc");
    expect((screen.getByLabelText("WhatsApp click") as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("Phone click")).toBeTruthy();
    expect((screen.getByLabelText("Email click") as HTMLInputElement).value).toBe("AW-987654321/e1");
    expect(saveBtn()).toBeTruthy();
    expect(screen.getByLabelText("LinkedIn partner id")).toBeTruthy();
    expect(screen.getByTestId("google-ads-help").textContent).toContain("accept marketing cookies");
  });

  it("client-side validation: a bad id, a conversion with an unlisted id and a bad conversion each show words and send nothing", () => {
    mount(view());
    type("Google Ads tag ids", "AW-12");
    fireEvent.click(saveBtn());
    expect(screen.getByTestId("google-ads-bad").textContent).toMatch(/is not a Google Ads tag id/);
    type("Google Ads tag ids", "AW-123456789");
    type("Form lead", "AW-999999999/x");
    fireEvent.click(saveBtn());
    expect(screen.getByTestId("google-ads-bad").textContent).toMatch(/not one of the tag ids/);
    type("Form lead", "nope");
    fireEvent.click(saveBtn());
    expect(screen.getByTestId("google-ads-bad").textContent).toMatch(/Form lead.*is not a conversion/);
    expect(saveAds).not.toHaveBeenCalled();
  });

  it("Save sends the text as typed, then shows the server's values and the next-rebuild sentence", async () => {
    saveAds.mockResolvedValue({ ok: true, result: "set", googleAds: { ids: ["AW-123456789"], conversions: { lead: "AW-123456789/abc" } }, message: "Google Ads (1 tag id, 1 conversion) was saved to gaiadabali/gaiada-web-revamp. It reaches the site at its next rebuild." });
    mount(view());
    type("Google Ads tag ids", " AW-123456789 ");
    type("Form lead", " AW-123456789/abc ");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByTestId("google-ads-ok")).toBeTruthy());
    expect(saveAds).toHaveBeenCalledWith({
      propertyId: "p-1", webdeskTenant: "gaiada", site: "site-1", ids: " AW-123456789 ",
      conversions: { lead: " AW-123456789/abc ", whatsapp: "", phone: "", email: "" },
    });
    expect(screen.getByTestId("google-ads-ok").textContent).toContain("next rebuild");
    expect((screen.getByLabelText("Form lead") as HTMLInputElement).value).toBe("AW-123456789/abc");
  });

  it("emptying every field and saving sends the empty section (a clear)", async () => {
    saveAds.mockResolvedValue({ ok: true, result: "cleared", googleAds: { ids: [], conversions: {} }, message: "Google Ads was removed." });
    mount(view({ googleAds: stored }));
    type("Google Ads tag ids", "");
    type("Form lead", "");
    type("Email click", "");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByTestId("google-ads-ok")).toBeTruthy());
    expect(saveAds).toHaveBeenCalledWith(expect.objectContaining({ ids: "", conversions: { lead: "", whatsapp: "", phone: "", email: "" } }));
    expect((screen.getByLabelText("Google Ads tag ids") as HTMLTextAreaElement).value).toBe("");
  });

  it("a server refusal is words and the fields keep what was typed; the LinkedIn section is untouched", async () => {
    saveAds.mockResolvedValue({ ok: false, message: "GitHub refused: permission: actions_variables. Nothing was saved." });
    mount(view({ linkedin: { partnerId: "42" } }));
    type("Google Ads tag ids", "AW-123456789");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByTestId("google-ads-bad")).toBeTruthy());
    expect(screen.getByTestId("google-ads-bad").textContent).toContain("actions_variables");
    expect((screen.getByLabelText("Google Ads tag ids") as HTMLTextAreaElement).value).toBe("AW-123456789");
    expect(screen.getByTestId("tracking-tags-value").textContent).toBe("42");
    expect(save).not.toHaveBeenCalled();
  });

  it("an action that throws is a sentence that says nothing changed", async () => {
    saveAds.mockRejectedValue(new Error("network"));
    mount(view());
    type("Google Ads tag ids", "AW-123456789");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByTestId("google-ads-bad").textContent).toContain("Nothing was changed"));
  });
});

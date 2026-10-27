import { describe, it, expect, vi, afterAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// SCP-1a: the reusable brand book form. It validates before it sends, shows the server's words for a refusal, is read-only with the reason without
// `canEdit`, and ROUND-TRIPS through the demo store: the actions are replaced by ones that call `socialDemo` (the same twin the app serves in DEMO_MODE),
// so a save is read back by the next load. The demo store seeds the current month's cycle from the day it is first touched, so the clock is pinned to
// mid-month before it is imported (hence vi.hoisted). Only Date is faked.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

vi.mock("@/lib/socialAllocationActions", async () => {
  const { socialDemo } = await import("@/lib/demoSocial");
  const { asBrandBook, brandBookRefusalText, validateBrandBook, EMPTY_BRAND_BOOK } = await import("@/lib/socialBrandBook");
  const call = (method: string, path: string, body?: unknown) =>
    socialDemo(method, `/api/co-agency/modules/social/${path}`, new URLSearchParams(), body === undefined ? undefined : JSON.stringify(body))!;
  return {
    saveAllocation: vi.fn(),
    loadBrandBook: vi.fn(async (clientId: string) => {
      const r = call("GET", `brand-profiles/${clientId}`);
      if (r.status === 404) return { ok: true, book: { ...EMPTY_BRAND_BOOK }, exists: false };
      return { ok: true, book: asBrandBook(r.json), exists: true };
    }),
    saveBrandBook: vi.fn(async (clientId: string, book: Parameters<typeof validateBrandBook>[0]) => {
      const checked = validateBrandBook(book);
      if (!checked.ok) return { ok: false, error: "invalid_field", field: checked.field, message: checked.message };
      const r = call("PATCH", `brand-profiles/${clientId}`, checked.book);
      if (r.status !== 200) {
        const j = r.json as { error: string; field?: string };
        return { ok: false, error: j.error, field: j.field, message: brandBookRefusalText(j.error, j.field) };
      }
      return { ok: true, book: checked.book };
    }),
  };
});

import { BrandBookForm, BRAND_EDIT_REFUSAL_REASON } from "./BrandBookForm";
import { loadBrandBook, saveBrandBook } from "@/lib/socialAllocationActions";
import { socialDemo } from "@/lib/demoSocial";
import { asBrandBook } from "@/lib/socialBrandBook";

const stored = (clientId: string) => asBrandBook(socialDemo("GET", `/api/co-agency/modules/social/brand-profiles/${clientId}`, new URLSearchParams())!.json);

describe("loading", () => {
  it("loads the client's book itself when none is given, and fills every field", async () => {
    render(<BrandBookForm clientId="cl-1" canEdit />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the brand book");
    expect(await screen.findByLabelText(/Tone in one line/)).toHaveValue("Warm, direct and a little playful.");
    expect(loadBrandBook).toHaveBeenCalledWith("cl-1");
    expect(screen.getByLabelText(/Content pillars/)).toHaveValue("Behind the scenes\nProduct stories");
    expect(screen.getByLabelText("Hashtag set 1 name")).toHaveValue("Always");
    expect(screen.getByLabelText("Hashtag set 1 tags")).toHaveValue("northwind madewithcare");
    expect(screen.getByLabelText("Channel 1 network")).toHaveValue("instagram");
    expect(screen.getByLabelText("Channel 1 handle")).toHaveValue("northwindtraders");
    expect(screen.getByLabelText("Key date 1 day")).toHaveValue("12-24");
    expect(screen.getByLabelText("Link 1 address")).toHaveValue("https://example.com/northwind/brand");
  });
  it("starts empty for a client with no profile yet, and does not load when the page already holds the book", async () => {
    render(<BrandBookForm clientId="cl-fresh" canEdit />);
    expect(await screen.findByLabelText(/Tone in one line/)).toHaveValue("");
    vi.mocked(loadBrandBook).mockClear();
    render(<BrandBookForm clientId="cl-1" canEdit initial={{ toneSummary: "Given", contentPillars: [], mustHaveNotes: [], brandRules: [], hashtagSets: [], channels: [], keyDates: [], links: [] }} />);
    expect(screen.getAllByLabelText(/Tone in one line/).some((e) => (e as HTMLInputElement).value === "Given")).toBe(true);
    expect(loadBrandBook).not.toHaveBeenCalled();
  });
});

describe("validating before it sends", () => {
  it("names the first problem and sends nothing", async () => {
    render(<BrandBookForm clientId="cl-1" canEdit />);
    fireEvent.change(await screen.findByLabelText(/Tone in one line/), { target: { value: "x".repeat(201) } });
    fireEvent.click(screen.getByRole("button", { name: "Save brand book" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Tone in one line: at most 200/);
    expect(saveBrandBook).not.toHaveBeenCalled();
  });
  it("refuses a link that is not http or https, and a key date that is not a real day", async () => {
    render(<BrandBookForm clientId="cl-1" canEdit />);
    fireEvent.change(await screen.findByLabelText("Link 1 address"), { target: { value: "ftp://files.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save brand book" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/must start with http/);
    fireEvent.change(screen.getByLabelText("Link 1 address"), { target: { value: "https://example.com/ok" } });
    fireEvent.change(screen.getByLabelText("Key date 1 day"), { target: { value: "02-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save brand book" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/real day/);
    expect(saveBrandBook).not.toHaveBeenCalled();
  });
});

describe("round trip through the demo store", () => {
  it("saves every field and reads it back; the sibling keys of tone and the hashtag rules survive", async () => {
    const beforeRaw = socialDemo("GET", "/api/co-agency/modules/social/brand-profiles/cl-1", new URLSearchParams())!.json as { tone: Record<string, unknown>; hashtagStrategy: Record<string, unknown> };
    const onSaved = vi.fn();
    render(<BrandBookForm clientId="cl-1" canEdit onSaved={onSaved} />);
    fireEvent.change(await screen.findByLabelText(/Tone in one line/), { target: { value: "Calm and clear." } });
    fireEvent.change(screen.getByLabelText(/Content pillars/), { target: { value: "Craft\n\nCommunity  " } });
    fireEvent.change(screen.getByLabelText("Hashtag set 1 tags"), { target: { value: "#northwind, madewithcare launch" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a link" }));
    fireEvent.change(screen.getByLabelText("Link 2 label"), { target: { value: "Press kit" } });
    fireEvent.change(screen.getByLabelText("Link 2 address"), { target: { value: "https://example.com/press" } });
    fireEvent.click(screen.getByRole("button", { name: "Save brand book" }));
    expect(await screen.findByText("Brand book saved.")).toBeInTheDocument();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const back = stored("cl-1");
    expect(back.toneSummary).toBe("Calm and clear.");
    expect(back.contentPillars).toEqual(["Craft", "Community"]);
    expect(back.hashtagSets).toEqual([{ name: "Always", tags: ["northwind", "madewithcare", "launch"] }]);
    expect(back.links).toEqual([{ label: "Brand guide", url: "https://example.com/northwind/brand" }, { label: "Press kit", url: "https://example.com/press" }]);
    const afterRaw = socialDemo("GET", "/api/co-agency/modules/social/brand-profiles/cl-1", new URLSearchParams())!.json as { tone: Record<string, unknown>; hashtagStrategy: Record<string, unknown> };
    expect(afterRaw.tone.traits).toEqual(beforeRaw.tone.traits);
    expect(afterRaw.hashtagStrategy.maxCount).toBe(beforeRaw.hashtagStrategy.maxCount);
    // a fresh mount reads what was saved
    render(<BrandBookForm clientId="cl-1" canEdit />);
    expect((await screen.findAllByLabelText(/Tone in one line/)).some((e) => (e as HTMLInputElement).value === "Calm and clear.")).toBe(true);
  });

  it("creates the profile of a client that had none", async () => {
    render(<BrandBookForm clientId="cl-created" canEdit />);
    fireEvent.change(await screen.findByLabelText(/Brand rules/), { target: { value: "No slang" } });
    fireEvent.click(screen.getByRole("button", { name: "Save brand book" }));
    expect(await screen.findByText("Brand book saved.")).toBeInTheDocument();
    expect(stored("cl-created").brandRules).toEqual(["No slang"]);
  });

  it("shows the server's words for a refusal", async () => {
    vi.mocked(saveBrandBook).mockResolvedValueOnce({ ok: false, error: "invalid_field", field: "hashtagSets", message: "Hashtag sets is not valid. Check its limits and try again." });
    render(<BrandBookForm clientId="cl-1" canEdit />);
    await screen.findByLabelText(/Tone in one line/);
    fireEvent.click(screen.getByRole("button", { name: "Save brand book" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Hashtag sets is not valid");
  });
});

describe("without the right to change it", () => {
  it("is read-only: every control and the Save button are disabled, with the reason in words and as the title", async () => {
    render(<BrandBookForm clientId="cl-1" canEdit={false} />);
    const tone = await screen.findByLabelText(/Tone in one line/);
    expect(tone).toBeDisabled();
    expect(screen.getByLabelText(/Content pillars/)).toBeDisabled();
    expect(screen.getByLabelText("Link 1 address")).toBeDisabled();
    const save = screen.getByRole("button", { name: "Save brand book" });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("title", BRAND_EDIT_REFUSAL_REASON);
    expect(screen.getByText(BRAND_EDIT_REFUSAL_REASON)).toBeInTheDocument();
    expect(tone).toHaveAttribute("aria-describedby", save.getAttribute("aria-describedby"));
  });
});

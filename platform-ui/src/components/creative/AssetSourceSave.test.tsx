import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AssetVersion } from "@/lib/creativeReviews";

// SCP-1h (BFF §63.6.6, §35.2): the Asset Library save gains Source and AI note. On "Upload new version" (the asset detail's save) the person names where
// the picture came from; an AI-made one must say how it was made before anything is sent; a plain save sends the body it always sent; the version
// history shows each version's own source and AI note. (The Image Studio's save form uses the same two fields, `AssetSourceFields`.)
const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("@/lib/imaging", () => ({ IDENTITY_GRADE: { exposure: 0 } }));
const saveCreativeAsset = vi.fn();
vi.mock("@/lib/creativeActions", () => ({ saveCreativeAsset: (...a: unknown[]) => saveCreativeAsset(...a), setAssetTraining: vi.fn() }));
vi.mock("@/lib/creativeReviewActions", () => ({ requestReview: vi.fn(), decideReview: vi.fn(), withdrawReview: vi.fn() }));

import { AssetActions, VersionHistory } from "./AssetDetail";
import { AssetSourceFields } from "./AssetSourceFields";
import { EMPTY_ASSET_SOURCE, type AssetSourceValue } from "@/lib/creativeSource";

const ver = (n: number, over: Partial<AssetVersion> = {}): AssetVersion => ({
  id: `a${n}`, name: "banner.webp", content_type: "image/webp", width: 10, height: 10, department_id: "d1",
  uploader_id: "u1", created_at: "2026-10-13T10:00:00Z", versionNo: n, versionGroupId: "a1", supersedesId: null,
  versionCount: 3, isLatest: n === 3, review: null, ...over,
});
const mountActions = () => render(<AssetActions deptId="d1" latest={ver(3)} current={ver(3)} rounds={{ kind: "ok", data: [] }} meId="u1" />);
const pick = () => new File([new Uint8Array([1, 2, 3])], "new.png", { type: "image/png" });
const upload = () => fireEvent.change(screen.getByLabelText("Upload new version"), { target: { files: [pick()] } });

beforeEach(() => {
  vi.clearAllMocks();
  saveCreativeAsset.mockResolvedValue({ ok: true, id: "a9", versionNo: 4 });
});

describe("AssetSourceFields", () => {
  function Harness({ start = EMPTY_ASSET_SOURCE, onValue }: { start?: AssetSourceValue; onValue?: (v: AssetSourceValue) => void }) {
    const [v, setV] = useState(start);
    return <AssetSourceFields value={v} onChange={(n) => { setV(n); onValue?.(n); }} />;
  }

  it("offers the five sources, Not sure first, and no note box until AI is chosen", () => {
    render(<Harness />);
    const select = screen.getByLabelText("Source") as HTMLSelectElement;
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ["unknown", "Not sure"], ["own", "Made by us"], ["client", "From the client"], ["stock", "Stock library"], ["ai", "Made with AI"],
    ]);
    expect(select.value).toBe("unknown");
    expect(screen.queryByLabelText(/AI note/)).toBeNull();
  });

  it("shows the note box, required and hinted, for an AI picture, and drops it for another source", () => {
    const seen: AssetSourceValue[] = [];
    render(<Harness onValue={(v) => seen.push(v)} />);
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "ai" } });
    const note = screen.getByLabelText("AI note (required)") as HTMLTextAreaElement;
    expect(note).toHaveAttribute("maxlength", "1000");
    expect(document.getElementById(note.getAttribute("aria-describedby") ?? "")).toHaveTextContent("Say how it was made: the tool and the prompt, and what was changed by hand.");
    fireEvent.change(note, { target: { value: "Made with an image model." } });
    expect(seen[seen.length - 1]).toEqual({ source: "ai", aiNote: "Made with an image model." });
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "own" } });
    expect(screen.queryByLabelText(/AI note/)).toBeNull();
  });

  it("is disabled as a whole while a save is running", () => {
    render(<AssetSourceFields value={{ source: "ai", aiNote: "x" }} onChange={() => undefined} disabled />);
    expect(screen.getByLabelText("Source")).toBeDisabled();
    expect(screen.getByLabelText("AI note (required)")).toBeDisabled();
  });
});

describe("Upload new version carries the source", () => {
  it("a plain upload sends the body it always sent: no source, no note", async () => {
    mountActions();
    upload();
    await waitFor(() => expect(saveCreativeAsset).toHaveBeenCalledTimes(1));
    const sent = saveCreativeAsset.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).toMatchObject({ name: "new.png", versionOf: "a3", contentType: "image/png", presetId: "custom" });
    expect(sent).not.toHaveProperty("source");
    expect(sent).not.toHaveProperty("aiNote");
  });

  it("sends the chosen source", async () => {
    mountActions();
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "stock" } });
    upload();
    await waitFor(() => expect(saveCreativeAsset).toHaveBeenCalledTimes(1));
    expect(saveCreativeAsset.mock.calls[0][0]).toMatchObject({ versionOf: "a3", source: "stock" });
    expect(saveCreativeAsset.mock.calls[0][0]).not.toHaveProperty("aiNote");
  });

  it("an AI picture without a note is not sent: the person is told what to add", async () => {
    mountActions();
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "ai" } });
    upload();
    expect(await screen.findByText("Add a note on how the AI picture was made.")).toBeInTheDocument();
    expect(saveCreativeAsset).not.toHaveBeenCalled();
  });

  it("an AI picture with its note is sent with both, trimmed", async () => {
    mountActions();
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "ai" } });
    fireEvent.change(screen.getByLabelText("AI note (required)"), { target: { value: "  Made with an image model; text set by hand.  " } });
    upload();
    await waitFor(() => expect(saveCreativeAsset).toHaveBeenCalledTimes(1));
    expect(saveCreativeAsset.mock.calls[0][0]).toMatchObject({ source: "ai", aiNote: "Made with an image model; text set by hand.", versionOf: "a3" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/departments/d1/assets/a9"));
  });

  it("says the server's refusal in words when the save is refused", async () => {
    saveCreativeAsset.mockResolvedValue({ ok: false, error: "That source isn't one of the choices." });
    mountActions();
    upload();
    expect(await screen.findByText("That source isn't one of the choices.")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("the version history shows each version's source", () => {
  it("shows a known source and an AI note, and nothing for an unknown or absent one", () => {
    render(
      <VersionHistory
        result={{ kind: "ok", data: [ver(3, { source: "ai", aiNote: "Made with an image model." }), ver(2, { source: "own" }), ver(1, { source: "unknown", aiNote: null })] }}
        currentId="a3" meId="u1"
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain("Source: Made with AI");
    expect(items[0].textContent).toContain("AI note: Made with an image model.");
    expect(items[1].textContent).toContain("Source: Made by us");
    expect(items[2].textContent).not.toContain("Source:");
  });
});

import { describe, it, expect } from "vitest";
import {
  AI_NOTE_MAX, ASSET_SOURCES, ASSET_SOURCE_LABEL, EMPTY_ASSET_SOURCE, assetSourceBody, assetSourceProblem, assetSourceText, isAssetSource,
} from "./creativeSource";
import { creativeErrorSentence } from "./creativeReviews";

// SCP-1h (BFF §63.6.6, §35.2): the Asset Library save's Source and AI note. The server owns the rules; this keeps the form honest before the round trip
// and words the answer.

describe("the five sources", () => {
  it("are the contract's, each with a plain label, and `unknown` is the default", () => {
    expect([...ASSET_SOURCES].sort()).toEqual(["ai", "client", "own", "stock", "unknown"]);
    expect(Object.keys(ASSET_SOURCE_LABEL).sort()).toEqual([...ASSET_SOURCES].sort());
    expect(EMPTY_ASSET_SOURCE).toEqual({ source: "unknown", aiNote: "" });
    expect(ASSET_SOURCES.every(isAssetSource)).toBe(true);
    expect(isAssetSource("AI")).toBe(false);
    expect(isAssetSource(undefined)).toBe(false);
  });
});

describe("assetSourceProblem", () => {
  it("has none for a plain save, or any non-AI source with or without a note", () => {
    expect(assetSourceProblem(EMPTY_ASSET_SOURCE)).toBeNull();
    expect(assetSourceProblem({ source: "own", aiNote: "" })).toBeNull();
    expect(assetSourceProblem({ source: "stock", aiNote: "Licensed." })).toBeNull();
  });
  it("needs a note for an AI picture, and a blank one is no note", () => {
    expect(assetSourceProblem({ source: "ai", aiNote: "" })).toBe("Add a note on how the AI picture was made.");
    expect(assetSourceProblem({ source: "ai", aiNote: "   " })).toBe("Add a note on how the AI picture was made.");
    expect(assetSourceProblem({ source: "ai", aiNote: "Made with an image model." })).toBeNull();
  });
  it("keeps the note to 1,000 characters, counted as characters", () => {
    expect(assetSourceProblem({ source: "ai", aiNote: "x".repeat(AI_NOTE_MAX) })).toBeNull();
    expect(assetSourceProblem({ source: "ai", aiNote: "x".repeat(AI_NOTE_MAX + 1) })).toBe("Keep the note to 1,000 characters or fewer.");
    expect(assetSourceProblem({ source: "ai", aiNote: "\u{1F600}".repeat(AI_NOTE_MAX) })).toBeNull();
  });
});

describe("assetSourceBody (what the save sends)", () => {
  it("sends nothing for a plain save, so today's body is unchanged and the server's default applies", () => {
    expect(assetSourceBody(EMPTY_ASSET_SOURCE)).toEqual({});
    expect(assetSourceBody({ source: "unknown", aiNote: "   " })).toEqual({});
  });
  it("sends the source, and the trimmed note when there is one", () => {
    expect(assetSourceBody({ source: "own", aiNote: "" })).toEqual({ source: "own" });
    expect(assetSourceBody({ source: "ai", aiNote: "  Made with an image model.  " })).toEqual({ source: "ai", aiNote: "Made with an image model." });
    expect(assetSourceBody({ source: "unknown", aiNote: "A note" })).toEqual({ source: "unknown", aiNote: "A note" });
  });
});

describe("assetSourceText", () => {
  it("is a quiet line for a known source, and nothing for unknown, absent or odd values", () => {
    expect(assetSourceText("ai")).toBe("Source: Made with AI");
    expect(assetSourceText("own")).toBe("Source: Made by us");
    expect(assetSourceText("unknown")).toBeNull();
    expect(assetSourceText(undefined)).toBeNull();
    expect(assetSourceText("weird")).toBeNull();
  });
});

describe("the server's refusals, in words", () => {
  it("words the three new tokens (in `reason`, as the backend sends them)", () => {
    expect(creativeErrorSentence({ status: 400, message: "ai_note_required: an AI-made asset needs a note", reason: "ai_note_required" })).toBe("Add a note on how the AI picture was made.");
    expect(creativeErrorSentence({ status: 400, reason: "source_invalid" })).toBe("That source isn't one of the choices.");
    expect(creativeErrorSentence({ status: 400, reason: "ai_note_invalid" })).toBe("That AI note isn't valid. Keep it to 1,000 characters or fewer.");
    expect(creativeErrorSentence({ status: 403 })).toBe("You can't do this on this asset.");
  });
});

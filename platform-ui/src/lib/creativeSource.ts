// SCP-1h (BFF §63.1 file 4, §63.6.6; §35.2) — where an Asset Library picture came from. Pure and client-safe: the save form
// (Image Studio, "Upload new version") and the asset detail import it.
//
// The server owns the rules: `source` is one of five values (default `unknown`), an `ai` source needs a note of 1 to 1,000
// characters (400 `ai_note_required`, `{field: "aiNote"}`), and the database refuses an AI row without one. This file only keeps
// the form honest before the round trip and words the answer; a refusal from the server is still said as itself.

export const ASSET_SOURCES = ["unknown", "own", "client", "stock", "ai"] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];

export const ASSET_SOURCE_LABEL: Readonly<Record<AssetSource, string>> = {
  unknown: "Not sure", own: "Made by us", client: "From the client", stock: "Stock library", ai: "Made with AI",
};

export const AI_NOTE_MAX = 1_000;
export const AI_NOTE_HINT = "Say how it was made: the tool and the prompt, and what was changed by hand.";

export interface AssetSourceValue { source: AssetSource; aiNote: string }
export const EMPTY_ASSET_SOURCE: AssetSourceValue = { source: "unknown", aiNote: "" };

export const isAssetSource = (v: unknown): v is AssetSource => typeof v === "string" && (ASSET_SOURCES as readonly string[]).includes(v);

/** The sentence to show before a save, or null when the form is fine. An AI-made picture must say how it was made. */
export function assetSourceProblem(v: AssetSourceValue): string | null {
  const note = v.aiNote.trim();
  if (v.source === "ai" && note === "") return "Add a note on how the AI picture was made.";
  if ([...note].length > AI_NOTE_MAX) return `Keep the note to ${AI_NOTE_MAX.toLocaleString("en-GB")} characters or fewer.`;
  return null;
}

/** What the save sends. Left at "Not sure" with no note, nothing is sent: the server's default is the same and a plain save keeps its old shape. */
export function assetSourceBody(v: AssetSourceValue): { source?: AssetSource; aiNote?: string } {
  const note = v.aiNote.trim();
  if (v.source === "unknown" && note === "") return {};
  return { source: v.source, ...(note !== "" ? { aiNote: note } : {}) };
}

/** A quiet line for a version row or card: "Source: Made with AI". Nothing when the server did not say, or said unknown. */
export function assetSourceText(source: string | null | undefined): string | null {
  return isAssetSource(source) && source !== "unknown" ? `Source: ${ASSET_SOURCE_LABEL[source]}` : null;
}

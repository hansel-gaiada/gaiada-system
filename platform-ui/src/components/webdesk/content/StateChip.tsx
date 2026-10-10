import { publishStateLabel } from "@/lib/webdeskContentModel";
import "./content.css";

/** A publish state as a chip. The label is the backend's own value humanised; the tone only ever
 *  colours the four states this UI knows — an unknown value gets the neutral chip, never a guess. */
export function StateChip({ state, deleted }: { state: string; deleted?: boolean }) {
  if (deleted) return <span className="wc-chip wc-chip--bad">Deleted</span>;
  const tone = state === "published" ? "ok" : state === "scheduled" ? "info" : state === "unpublished" ? "warn" : "";
  return <span className={`wc-chip${tone ? ` wc-chip--${tone}` : ""}`}>{publishStateLabel(state)}</span>;
}

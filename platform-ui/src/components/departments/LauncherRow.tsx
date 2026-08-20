import Link from "next/link";
import { TeachState } from "./TeachState";
import { TOOL_ICONS, type ToolIconName } from "./toolIcons";

// Compact launcher row — Build Tools MERGED into Home per decision #10/Q4
// (the old `/departments/[deptId]/tools` full-page grid becomes this one row).
// Same toolkit data (`lib/deptToolkits.ts` `DeptLauncher[]`) as the retired
// tools page.
//
// Icons only, names on hover/focus. The labelled version was six bordered cards
// each repeating "opens as hansel@gaiada.com", which is one sentence printed six
// times, and at any real card width the row scrolled sideways and cut the last
// tool in half. A person who has these tools knows their marks; the row's job is
// to be a place to click, not a place to read. Everything the cards said now
// lives in the tooltip and in each link's accessible name.
//
// `seatStatus`/`seatLabel` are optional forward-compat
// for C1 (decision #9): when a tool has a seat concept (Claude Code/Design),
// the caller passes whether THIS person's seat is mapped; tools without one
// (GitHub, Figma, VS Code) simply omit those fields. Dept-agnostic, props only.
export interface LauncherItem {
  key: string;
  label: string;
  desc?: string;
  href: string;
  /** Small brand glyph character, e.g. "⌘", "⎇", "△". The fallback when `icon` is absent. */
  glyph?: string;
  /** Vendored brand mark (`toolIcons.tsx`). Preferred over `glyph` when the set has the tool. */
  icon?: ToolIconName;
  /** Opens in a new tab. Defaults to true (external tool). */
  external?: boolean;
  /** Seat-mapping state for tools with a per-person seat (C1). Omit if none. */
  seatStatus?: "mapped" | "unmapped";
  /** Shown when seatStatus is "mapped", e.g. "opens as hansel@gaiada.com". */
  seatLabel?: string;
}

export interface LauncherRowProps {
  items: LauncherItem[];
  emptyTitle?: string;
  emptyBody?: string;
  emptyCtaLabel?: string;
  emptyCtaHref?: string;
}

export function LauncherRow({ items, emptyTitle, emptyBody, emptyCtaLabel, emptyCtaHref }: LauncherRowProps) {
  if (items.length === 0) {
    return (
      <TeachState
        glyph="＋"
        title={emptyTitle ?? "No tools configured yet"}
        body={emptyBody ?? "Build tools for this department haven't been set up."}
        ctaLabel={emptyCtaLabel}
        ctaHref={emptyCtaHref}
      />
    );
  }

  return (
    <div className="dept-launcher-row">
      {items.map((item) => {
        const external = item.external ?? true;
        const unmapped = item.seatStatus === "unmapped";
        // One line under the name in the tooltip. Seat state outranks the description: on a tool
        // with a seat, "opens as hansel@gaiada.com" is the thing a person needs before clicking,
        // and "Agentic coding in the terminal" is something they already know.
        const detail = item.seatStatus === "mapped" && item.seatLabel
          ? item.seatLabel
          : unmapped
            ? "Map your seat"
            : item.desc;
        const content = (
          <>
            {/* The mark is decorative — the LINK carries the name via aria-label, so a screen
                reader hears "Claude Code, opens as …" once and never reads the glyph character
                itself (assistive tech pronounces "⌘" as "place of interest sign").
                A vendored SVG when one exists, the typographic glyph when it does not; the two
                sit in the same box so a mixed row still aligns. */}
            <span className={`dept-launcher-icon__mark${item.icon ? " dept-launcher-icon__mark--svg" : ""}`} aria-hidden="true">
              {item.icon ? TOOL_ICONS[item.icon] : (item.glyph ?? "↗")}
            </span>
            {/* Hover/focus tooltip, and NOT a `title` attribute: the native one waits about a
                second, cannot be reached by keyboard, and would fire alongside this. Marked
                aria-hidden so it does not repeat what aria-label already says. */}
            <span className="dept-launcher-icon__tip" aria-hidden="true">
              <span className="dept-launcher-icon__tip-name">{item.label}</span>
              {detail && (
                <span className={`dept-launcher-icon__tip-detail${unmapped ? " dept-launcher-icon__tip-detail--unmapped" : ""}`}>
                  {detail}
                </span>
              )}
            </span>
          </>
        );
        // Icon-only rows are only usable if every icon still announces itself, so the accessible
        // name is assembled here rather than left to the glyph.
        const aria = detail ? `${item.label} — ${detail}` : item.label;
        const cls = `dept-launcher-icon${unmapped ? " dept-launcher-icon--unmapped" : ""}`;
        return external ? (
          <a key={item.key} href={item.href} target="_blank" rel="noopener noreferrer" className={cls} aria-label={aria}>{content}</a>
        ) : (
          <Link key={item.key} href={item.href} className={cls} aria-label={aria}>{content}</Link>
        );
      })}
    </div>
  );
}

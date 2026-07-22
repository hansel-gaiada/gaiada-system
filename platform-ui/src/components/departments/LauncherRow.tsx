import Link from "next/link";
import { TeachState } from "./TeachState";

// Compact launcher row — Build Tools MERGED into Home per decision #10/Q4
// (the old `/departments/[deptId]/tools` full-page grid becomes this one row).
// Same toolkit data (`lib/deptToolkits.ts` `DeptLauncher[]`) as the retired
// tools page, just denser. `seatStatus`/`seatLabel` are optional forward-compat
// for C1 (decision #9): when a tool has a seat concept (Claude Code/Design),
// the caller passes whether THIS person's seat is mapped; tools without one
// (GitHub, Figma, VS Code) simply omit those fields. Dept-agnostic, props only.
export interface LauncherItem {
  key: string;
  label: string;
  desc?: string;
  href: string;
  /** Small brand glyph character, e.g. "⌘", "⎇", "△". */
  glyph?: string;
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
    <div className="dept-launcher-row erp-scroll">
      {items.map((item) => {
        const external = item.external ?? true;
        const content = (
          <>
            <span className="dept-launcher-chip__glyph" aria-hidden="true">{item.glyph ?? "↗"}</span>
            <span className="dept-launcher-chip__body">
              <span className="dept-launcher-chip__label">{item.label}</span>
              {item.seatStatus === "mapped" && item.seatLabel ? (
                <span className="dept-launcher-chip__seat">{item.seatLabel}</span>
              ) : item.seatStatus === "unmapped" ? (
                <span className="dept-launcher-chip__seat dept-launcher-chip__seat--unmapped">Map your seat</span>
              ) : item.desc ? (
                <span className="dept-launcher-chip__seat">{item.desc}</span>
              ) : null}
            </span>
          </>
        );
        return external ? (
          <a key={item.key} href={item.href} target="_blank" rel="noopener noreferrer" className="dept-launcher-chip">{content}</a>
        ) : (
          <Link key={item.key} href={item.href} className="dept-launcher-chip">{content}</Link>
        );
      })}
    </div>
  );
}

"use client";
import { Menu } from "@/components/overlay/Menu";
import { toolLinkName, type ToolLink } from "@/lib/toolContext";
import "./openIn.css";

// DW-6c2: the "Open in" menu. A button with `aria-expanded` that opens a list of links to the workspace's
// outside tools, each carrying this page's context where an exact identifier exists (`lib/toolContext.ts`).
// Open/close behaviour (outside click, Escape) is the shared `Menu`; each link opens in a new tab and its
// accessible name says what it opens. A home link says "home" in quiet text, so the reader can tell.
export interface OpenInEntry extends ToolLink {
  /** The registry's small brand glyph, shown beside the name. */
  glyph?: string;
}

export function OpenInMenu({ entries }: { entries: readonly OpenInEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <Menu
      label="Open in"
      align="end"
      trigger={(s) => (
        <button
          type="button"
          className="lux-btn lux-btn--ghost lux-btn--sm"
          aria-haspopup="menu"
          aria-expanded={s.open}
          onClick={s.toggle}
        >
          Open in
        </button>
      )}
    >
      {(s) =>
        entries.map((e, i) => (
          <a
            key={`${e.key}:${e.href}:${i}`}
            role="menuitem"
            className="ov-menu__item open-in__item"
            href={e.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={toolLinkName(e)}
            onClick={s.close}
          >
            {e.glyph && <span className="open-in__glyph" aria-hidden="true">{e.glyph}</span>}
            <span className="open-in__text">
              <span>{e.label}</span>
              <span className="open-in__detail">{e.contextual && e.detail ? e.detail : "home"}</span>
            </span>
          </a>
        ))
      }
    </Menu>
  );
}

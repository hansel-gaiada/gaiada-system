"use client";
import { useRef } from "react";
import { Icon } from "./icons";
import type { PaletteOpenDetail } from "./CommandPalette";

// DW-2c: the workspace top bar's one search field (plan §2.5). It looks like a search input with a ⌘K
// hint, and clicking or focusing it opens the command palette, which does the actual searching.
//
// It is still a real `<form action="/search" method="get" role="search">` around a named `q` input, so
// without JS (or before hydration) a submit lands on `/search?q=`. With JS the palette is open before
// anything is typed; if a character does land here first, it is handed to the palette and cleared, so
// nothing is lost and nothing is typed twice.
//
// Closing the palette returns focus to the field it was opened from, and that focus must not open the
// palette again. The palette calls `onClose` just before it refocuses; `justClosed` swallows that one
// focus (and clears itself on the next tick, in case no focus follows).
//
// On a phone the field collapses to an icon (`.erp-top__searchbtn`), a plain link to `/search` that opens
// the palette instead when JS is there.
export function TopBarSearch() {
  const input = useRef<HTMLInputElement>(null);
  const justClosed = useRef(false);

  function openPalette(query = "") {
    const detail: PaletteOpenDetail = {
      query,
      onClose: () => {
        justClosed.current = true;
        window.setTimeout(() => { justClosed.current = false; }, 0);
      },
    };
    window.dispatchEvent(new CustomEvent("gaiada:palette:open", { detail }));
  }

  return (
    <>
      <form className="erp-top__search erp-top__search--palette" action="/search" method="get" role="search">
        <Icon name="search" size={18} />
        <input
          ref={input}
          name="q"
          type="search"
          autoComplete="off"
          placeholder="Search pages, people, records…"
          aria-label="Search"
          defaultValue=""
          onFocus={() => { if (!justClosed.current) openPalette(); }}
          onClick={() => openPalette()}
          onChange={(e) => {
            // A character typed before the palette took focus.
            const typed = e.currentTarget.value;
            if (!typed) return;
            e.currentTarget.value = "";
            openPalette(typed);
          }}
        />
        <kbd aria-hidden="true">⌘K</kbd>
      </form>
      <a
        href="/search"
        className="erp-top__searchbtn"
        aria-label="Find anything"
        onClick={(e) => { e.preventDefault(); openPalette(); }}
      >
        <Icon name="search" size={19} />
      </a>
    </>
  );
}

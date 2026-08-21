"use client";
import { useState, useTransition } from "react";
import { setThemeAction } from "@/lib/prefsActions";
import type { Theme } from "@/lib/prefs";

// Appearance switch, in the sidebar's account menu (P5-S1).
//
// It is a three-stop segmented control, not the two-state pill a theme toggle usually is, for two
// reasons. The model has THREE values — `auto | light | dark` (lib/prefs.ts), and `auto` is the
// default and the only one that follows the reader's own device; a two-state toggle cannot express
// it, and dropping it would take a working preference away from everyone who never set one. And
// the app already owns a segmented-control idiom — the Gantt's Day/Week/Month — so this needs no
// new shape: square, hairline-joined, the pressed stop in the house bronze. A rounded pill with a
// sliding knob would be the one control in the suite speaking a different language.
//
// `role="menuitemradio"` rather than plain buttons: this sits inside a `role="menu"` popover, where
// arbitrary children are invalid, and "pick exactly one of three" is precisely what menuitemradio
// describes.
const STOPS: { value: Theme; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemeSwitch({ current }: { current: Theme }) {
  const [theme, setTheme] = useState<Theme>(current);
  const [, startTransition] = useTransition();

  function pick(next: Theme) {
    if (next === theme) return;
    setTheme(next);
    // `data-theme` on <html> is exactly what the stylesheets read (styles/tokens/colors.css), so
    // writing it here is not a guess at the server's answer — it IS the answer, applied a
    // round-trip early. "auto" is the ABSENCE of the attribute, which is how layout.tsx renders it.
    const root = document.documentElement;
    if (next === "auto") delete root.dataset.theme;
    else root.dataset.theme = next;
    startTransition(() => { void setThemeAction(next); });
  }

  return (
    <div className="erp-themeswitch">
      <span className="erp-themeswitch__label">Appearance</span>
      <div className="erp-themeswitch__stops" role="group" aria-label="Appearance">
        {STOPS.map((s) => (
          <button
            key={s.value}
            type="button"
            role="menuitemradio"
            aria-checked={theme === s.value}
            className="erp-themeswitch__stop"
            onClick={() => pick(s.value)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

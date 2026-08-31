"use client";
import { useState, useTransition } from "react";
import type { Theme } from "@/lib/prefs";
import { setThemeAction } from "@/lib/prefsActions";
import { Icon } from "./icons";
import "./theme-toggle.css";

// Discoverable Auto/Light/Dark control in the TopBar — the ONLY prior way to change theme was a
// <select> buried on /account, and the default ("auto") silently renders as light on a light-mode
// machine. Deliberately three states, not a two-state light/dark switch: "auto" (follow the OS)
// has to stay reachable, it just needs a louder home than Account.
//
// A radiogroup, not three plain buttons: exactly one of the three is ever "the current theme",
// which is what aria-checked + role="radio" communicates natively (arrow-key roaming is free from
// the browser's native radiogroup handling once role+tabIndex are set up this way — see onKeyDown).
const OPTIONS: { value: Theme; label: string; icon: "auto" | "sun" | "moon" }[] = [
  { value: "auto", label: "Match device", icon: "auto" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

export function ThemeToggle({ theme }: { theme: Theme }) {
  // Local state so the pressed segment updates the instant it's clicked, not on the next
  // navigation — same "optimistic, not awaited for correctness" shape as the assistant rail
  // collapse toggle (`AssistantWorkspace` + `setAssistantRailCollapsedAction`).
  const [current, setCurrent] = useState<Theme>(theme);
  const [, startTransition] = useTransition();

  function choose(next: Theme) {
    if (next === current) return;
    setCurrent(next);
    // Applied to <html> directly and immediately — Shell/layout.tsx render `data-theme` from the
    // cookie on the SERVER, so without this the visible theme would only change after a full
    // navigation re-ran that server render. "auto" removes the attribute entirely, handing the
    // decision back to the prefers-color-scheme block in tokens/colors.css (see app/layout.tsx).
    if (next === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", next);
    // Persisted in the background — a failed write leaves the visible theme correct for this tab
    // and only risks reverting on the NEXT full load, never a flash on this one.
    startTransition(() => {
      void setThemeAction(next);
    });
  }

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = OPTIONS[(index + dir + OPTIONS.length) % OPTIONS.length];
    choose(next.value);
    (document.getElementById(`theme-opt-${next.value}`) as HTMLElement | null)?.focus();
  }

  return (
    <div className="erp-theme" role="radiogroup" aria-label="Appearance">
      {OPTIONS.map((opt, i) => (
        <button
          key={opt.value}
          id={`theme-opt-${opt.value}`}
          type="button"
          role="radio"
          aria-checked={current === opt.value}
          aria-label={opt.label}
          title={opt.label}
          className={`erp-theme__opt${current === opt.value ? " erp-theme__opt--active" : ""}`}
          tabIndex={current === opt.value ? 0 : -1}
          onClick={() => choose(opt.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <Icon name={opt.icon} size={15} />
          {/* The design shows the CURRENT theme as a labelled gold pill. All
              three options stay reachable — dropping to a two-state toggle
              would remove "Match device", which is a behaviour, not a style. */}
          {current === opt.value && <span className="erp-theme__label">{opt.label}</span>}
        </button>
      ))}
    </div>
  );
}

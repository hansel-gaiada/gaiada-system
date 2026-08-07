"use client";
import { useCallback, useState } from "react";
import type { SyntheticEvent } from "react";

const RAIL = "(min-width: 761px)";

// Labels for the collapsed rail. Fixed-positioned from the trigger rect rather
// than a CSS ::after, because the nav column scrolls and would clip anything
// outside the 64px rail. Native title is unstyled and ~1s slow.
export function useRailTooltip(label: string) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = useCallback((e: SyntheticEvent<HTMLElement>) => {
    if (document.documentElement.dataset.sidebar !== "collapsed") return;
    if (!window.matchMedia(RAIL).matches) return;
    // Rows inside a flyout already show their label.
    if (e.currentTarget.closest(".erp-railmenu")) return;
    const r = e.currentTarget.getBoundingClientRect();
    setPos({ top: r.top + r.height / 2, left: r.right + 8 });
  }, []);

  const hide = useCallback(() => setPos(null), []);

  const tip = pos ? (
    <span className="erp-railtip" style={{ top: pos.top, left: pos.left }} aria-hidden="true">
      {label}
    </span>
  ) : null;

  return { tip, triggerProps: { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide } };
}

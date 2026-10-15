import { WINDOW_LABEL } from "@/lib/itSecurityView";
import type { SecurityWindow } from "@/lib/itSecurity";

// DW-7h: the window of an IT > Network page, as links (the answer is a server read, so a choice is a new request and survives
// a reload). Only the windows the route accepts are offered; anything else is a 400 there.
export function WindowChoice({ base, options, current }: { base: string; options: readonly SecurityWindow[]; current: SecurityWindow }) {
  return (
    <nav className="nw-windows" aria-label="Time window">
      <span className="nw-windows__label">Show</span>
      {options.map((w) => (
        <a key={w} href={`${base}?window=${w}`} className="nw-windows__link" aria-current={w === current ? "true" : undefined}>
          {WINDOW_LABEL[w]}
        </a>
      ))}
    </nav>
  );
}

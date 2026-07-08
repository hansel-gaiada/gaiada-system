import type { ReactNode } from "react";
import "./systems.css";

// Quiet "connected but empty" note — e.g. no agent goals yet, no knowledge
// sources yet. Do NOT use ConnectionState here: that component means "the
// backend admin API isn't connected yet," which is the wrong message when
// the system is connected and simply has nothing to show.
export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="sys-empty-note">{children}</p>;
}

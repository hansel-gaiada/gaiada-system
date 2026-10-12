"use client";
import { createContext, useContext, useState, type ReactNode } from "react";

// A success confirmation that outlives the control that earned it.
//
// A server action that revalidates gets its RSC refresh applied right after it (Next 16.3), and when
// the action removes or changes the row/card holding the control — a seat's last holder removed, an
// employee terminated, a quarantined source approved — that control unmounts with whatever message it
// held. A control inside an OutcomeScope posts its success line to the scope instead (the scope sits
// above whatever the refresh can remove), and the scope renders it in one polite live region. Outside a
// scope `useOutcomePost()` is null and the control keeps showing its own result, as before.
const OutcomeContext = createContext<((message: string) => void) | null>(null);

export function useOutcomePost(): ((message: string) => void) | null {
  return useContext(OutcomeContext);
}

export function OutcomeScope({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <OutcomeContext.Provider value={setMessage}>
      {/* Always mounted, so the region exists before its text does and a screen reader announces it. */}
      <div role="status" className={message ? "lux-toast" : undefined}>{message}</div>
      {children}
    </OutcomeContext.Provider>
  );
}

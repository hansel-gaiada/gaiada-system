"use client";
import { useEffect, useState } from "react";

// Shared debounce for every client-side search box in the systems consoles (Chats/Logs/Controls
// tabs, and the SearchableTable lists on Automation/Hub/Gateway) so typing doesn't refilter on
// every keystroke. `value` is returned immediately on the first render (no artificial initial
// delay) and only lags behind afterwards, once it starts changing.
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}

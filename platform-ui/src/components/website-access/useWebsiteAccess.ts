"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  displayName,
  type WebsiteAccessReadResult,
  type WebsiteAccessRow,
  type WebsiteAccessWriteResult,
} from "@/lib/clientWebsiteAccessView";

// The ONE state machine behind both website-access surfaces (staff Contacts, portal People), so the
// honesty rules cannot drift between them:
//
//   * the rows shown are the SERVER'S last answer, never a guess: no optimistic flip;
//   * `changed: false` is reported as "nothing changed", never as an update;
//   * a 403 LOCKS the surface (`locked`): staff render read-only, the portal hides the section;
//   * a 404 means the contact is gone: the row disappears and the list is re-read;
//   * every message goes to ONE polite status line (`message`), errors included.
//
// The writes and the re-read are INJECTED, so the staff and portal actions are the only difference.

export type Message = { tone: "ok" | "info" | "error"; text: string } | null;

export interface WebsiteAccessDeps {
  clientId: string;
  initialRows: WebsiteAccessRow[];
  setEditor: (input: { clientId: string; contactId: string; grant: boolean }) => Promise<WebsiteAccessWriteResult>;
  refresh: (clientId: string) => Promise<WebsiteAccessReadResult>;
}

export function useWebsiteAccess({ clientId, initialRows, setEditor, refresh }: WebsiteAccessDeps) {
  const [rows, setRows] = useState<WebsiteAccessRow[]>(initialRows);
  // Re-seed when the server hands down a new list (a revalidation after a revoke on the other panel):
  // "derive state from props", compared by identity, done during render so there is no stale frame.
  const [seed, setSeed] = useState(initialRows);
  if (seed !== initialRows) {
    setSeed(initialRows);
    setRows(initialRows);
  }

  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<Message>(null);
  // A second click on the same row while its write is in flight must not fire a second write; `busy`
  // is state (re-renders the disabled switch) and this ref is the synchronous guard.
  const inFlight = useRef<Set<string>>(new Set());
  // The polite status line is also where focus goes when the control the user was on has been REMOVED
  // (a 404 drops the row): otherwise focus falls to <body> and the keyboard user loses their place. The
  // line carries `tabIndex={-1}` and this ref; `focusTick` asks for the move after the commit.
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    if (focusTick > 0) statusRef.current?.focus();
  }, [focusTick]);

  const mark = useCallback((key: string, on: boolean) => {
    if (on) inFlight.current.add(key);
    else inFlight.current.delete(key);
    setBusy(new Set(inFlight.current));
  }, []);

  const patchRow = useCallback((contactId: string, patch: Partial<WebsiteAccessRow>) => {
    setRows((rs) => rs.map((r) => (r.contactId === contactId ? { ...r, ...patch } : r)));
  }, []);

  /** A 404: the contact is gone. Drop the row now, then re-read so the rest of the list is true too. */
  const handleGone = useCallback(
    async (who: string, contactId: string) => {
      setRows((rs) => rs.filter((r) => r.contactId !== contactId));
      const fresh = await refresh(clientId);
      setFocusTick((t) => t + 1);
      if (fresh.kind === "ok") {
        setRows(fresh.contacts);
        setMessage({ tone: "info", text: `${who} is no longer a contact here, so the list has been refreshed.` });
      } else if (fresh.kind === "forbidden") {
        setLocked(true);
      } else {
        setMessage({
          tone: "error",
          text: `${who} is no longer a contact here. The list could not be refreshed, so it may be out of date.`,
        });
      }
    },
    [clientId, refresh],
  );

  const toggleEditor = useCallback(
    async (row: WebsiteAccessRow, grant: boolean) => {
      const key = `${row.contactId}:editor`;
      if (inFlight.current.has(key)) return;
      const who = displayName(row);
      mark(key, true);
      setMessage(null);
      try {
        const r = await setEditor({ clientId, contactId: row.contactId, grant });
        if (r.ok) {
          // Show what the server says is stored, whatever we asked for.
          const now = typeof r.websiteEditor === "boolean" ? r.websiteEditor : grant;
          patchRow(row.contactId, { websiteEditor: now });
          if (r.changed) {
            setMessage({
              tone: "ok",
              text: now ? `Website access given to ${who}.` : `Website access removed from ${who}.`,
            });
          } else {
            setMessage({
              tone: "info",
              text: now
                ? `${who} already has website access, so nothing changed.`
                : `${who} did not have website access, so nothing changed.`,
            });
          }
        } else if (r.kind === "forbidden") {
          setLocked(true);
          setMessage({ tone: "error", text: "You don't have permission to change website access. Nothing was changed." });
        } else if (r.kind === "not_found") {
          await handleGone(who, row.contactId);
        } else {
          setMessage({ tone: "error", text: `${r.message} Nothing was changed.` });
        }
      } catch {
        // A thrown server action (network, deploy skew). The row keeps its last known state.
        setMessage({ tone: "error", text: "Could not reach the server. Nothing was changed." });
      } finally {
        mark(key, false);
      }
    },
    [clientId, setEditor, handleGone, mark, patchRow],
  );

  return { statusRef, rows, setRows, patchRow, locked, setLocked, busy, mark, message, setMessage, toggleEditor, handleGone };
}

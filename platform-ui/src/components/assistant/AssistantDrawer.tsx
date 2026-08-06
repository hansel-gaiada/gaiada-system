"use client";
import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import "./assistant-drawer.css";

// ASST-22 — slide-over shell for the intercepted `/assistant` route, the SAME pattern
// `components/pm/TaskDrawer.tsx` already established for `@drawer/(.)tasks/[taskId]` (read that
// file's header first — this is deliberately not a second drawer mechanism).
//
// Closing is `router.back()`, not a push to a fixed href, for the identical reason TaskDrawer gives:
// the drawer was opened by INTERCEPTING a navigation, so going back is what actually dismisses the
// interception and returns to whatever page you came from, with its scroll position intact.
//
// ── FOCUS MANAGEMENT (the ticket's own bar: "a drawer that traps or loses focus is unusable with a
//    keyboard") ──────────────────────────────────────────────────────────────────────────────────
// On open: focus moves into the panel (not just "somewhere" — `panel.current.focus()` on the dialog
// container itself, same as TaskDrawer). On close: focus returns to the FAB that opened it. TaskDrawer
// doesn't need this second half explicitly — its trigger is one of many in-page links, and landing
// back on the underlying page reads fine either way. The assistant's trigger is a SINGLE persistent
// FAB (`AssistantFab.tsx`, mounted once in `Shell`, `id="asst-fab-trigger"`) that exists identically
// on every page, so explicitly refocusing it by that stable id — rather than trusting whatever the
// browser's default post-navigation focus happens to be — is both correct and cheap.
//
// The refocus lives in an EFFECT CLEANUP, not inside `close()` itself: `close()` only asks the
// router to go back — exactly when React actually unmounts this component (Escape, scrim click, the
// close button, OR the browser's own Back button) is the router's timing, not this component's, and
// a fixed-delay guess (a `setTimeout`/`requestAnimationFrame` in `close()`) raced that timing and
// lost — verified by a real Playwright run in this ticket (Escape closed the drawer but focus landed
// on `<body>`, not the FAB, because the guessed delay fired before commit). A cleanup function runs
// exactly once, synchronously as part of the SAME commit that removes this component's DOM — the one
// timing signal that is actually correct here, whichever of the four close paths triggered it.
// VER-03 — the set of elements a keyboard user can actually land on inside the panel. Re-queried on
// every Tab press rather than cached once: the panel's content is the live `AssistantWorkspace`
// tree (rail rows, panel toggles, the right-rail family) whose focusable set changes constantly —
// a thread gets renamed, a right-rail panel opens/closes, the composer disables mid-send. A stale
// snapshot would trap Tab on elements that no longer exist or miss ones that just appeared.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AssistantDrawer({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => router.back(), [router]);

  useEffect(() => {
    // VER-03 — a real focus TRAP, not just the Escape/refocus-on-close pair this already had:
    // nothing previously stopped Tab/Shift+Tab from walking off the last/first focusable element
    // in the panel and landing on the app shell BEHIND the scrim (the sidebar, top bar, the page
    // underneath all still sit in the DOM's normal tab order — `aria-modal="true"` tells a screen
    // reader's browse mode to treat them as inert, but it does nothing for a sighted keyboard-only
    // user's physical Tab key). Wrapping is the only fix; `TaskDrawer.tsx` — the pattern this file
    // otherwise mirrors — has the identical gap and is out of this ticket's surface.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if (e.key !== "Tab" || !panel.current) return;
      const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        // Nothing tabbable inside (a rare, brief loading state) — keep focus pinned on the panel
        // itself rather than letting it escape.
        e.preventDefault();
        panel.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    // Lock the page behind the drawer — TaskDrawer's own note applies verbatim: two scrollbars
    // racing each other is the usual slide-over bug.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [close]);

  useEffect(() => {
    // Move focus into the panel on open — a keyboard user is not left behind on the page underneath,
    // and a screen reader announces the dialog rather than continuing to read what's behind it.
    panel.current?.focus();
    // Return focus to the FAB on close — see the header note above for why this is a cleanup, not a
    // post-`close()` guess.
    return () => {
      document.getElementById("asst-fab-trigger")?.focus();
    };
  }, []);

  return (
    <>
      <button type="button" className="asst-drawer__scrim" aria-label="Close assistant" onClick={close} />
      <div
        className="asst-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Assistant"
        tabIndex={-1}
        ref={panel}
      >
        <div className="asst-drawer__bar">
          <span className="asst-drawer__crumb">Assistant</span>
          <button type="button" className="asst-drawer__close" onClick={close} aria-label="Close assistant">
            Close ✕
          </button>
        </div>
        <div className="asst-drawer__body">{children}</div>
      </div>
    </>
  );
}

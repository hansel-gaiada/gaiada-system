"use client";
import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

// Slide-over shell for the intercepted task route.
//
// Closing is `router.back()`, not a push to a fixed href: the drawer is opened by intercepting a
// navigation, so going back is what actually dismisses the interception and returns you to whatever
// list you came from — /tasks, the calendar, a board, a department console — with its scroll
// position and query state intact. Pushing "/tasks" instead would strand anyone who opened a task
// from the calendar.
//
// Escape and a backdrop click both close. The backdrop is a real <button> so it is reachable and
// announced rather than being a div with an onClick.
//
// VER-03 follow-up — the set of elements a keyboard user can actually land on inside the panel.
// Re-queried on every Tab press rather than cached once: the panel's content is the live task detail
// (assignee pickers, comment composer, subtask rows, status controls) whose focusable set changes as
// the user works, so a stale snapshot would trap Tab on elements that no longer exist or miss ones
// that just appeared. Kept byte-identical to `assistant/AssistantDrawer.tsx`'s copy on purpose — if a
// THIRD drawer ever needs this, extract the pair into a shared `useFocusTrap` hook rather than
// growing a third copy. Two copies is the deliberate cheaper trade today, because unifying them
// would refactor two files across two different ownership lanes for no behavioural gain.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function TaskDrawer({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => router.back(), [router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      // VER-03 follow-up — a real focus TRAP. Escape and focus-on-open already existed, but nothing
      // stopped Tab/Shift+Tab from walking off the last/first focusable element in the panel and
      // landing on the app shell BEHIND the scrim: the sidebar, top bar and the task list underneath
      // all remain in the DOM's normal tab order. `aria-modal="true"` tells a screen reader's browse
      // mode to treat them as inert, but it does NOTHING for a sighted keyboard-only user's physical
      // Tab key — so the drawer looked modal and behaved porous. Wrapping is the only fix.
      if (e.key !== "Tab" || !panel.current) return;
      const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        // Nothing tabbable inside (a brief loading state) — pin focus on the panel itself rather
        // than letting it escape to the page behind the scrim.
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
    // Lock the page behind the drawer: two scrollbars racing each other is the usual slide-over bug.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [close]);

  useEffect(() => {
    // Move focus into the panel on open so keyboard users are not left behind on the list, and a
    // screen reader announces the dialog rather than continuing to read the page underneath.
    panel.current?.focus();
  }, []);

  return (
    <>
      <button type="button" className="pm-drawer__scrim" aria-label="Close task" onClick={close} />
      <div
        className="pm-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Task detail"
        tabIndex={-1}
        ref={panel}
      >
        <div className="pm-drawer__bar">
          <span className="pm-drawer__crumb">Task</span>
          <span className="pm-drawer__tools">
            <button type="button" className="pm-drawer__btn" onClick={close} aria-label="Close task detail">
              Close ✕
            </button>
          </span>
        </div>
        <div className="pm-drawer__body erp-scroll">{children}</div>
      </div>
    </>
  );
}

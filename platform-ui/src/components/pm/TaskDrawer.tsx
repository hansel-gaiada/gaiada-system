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
export function TaskDrawer({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => router.back(), [router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
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

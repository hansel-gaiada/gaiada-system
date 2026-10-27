"use client";
// SCP-1e (plan §6.3) — the slide-over shell of the intercepted post route, after `pm/TaskDrawer.tsx`: a client-side navigation to `{D}/posts/[postId]` from any list
// (the Plan grid, the List, the Calendar, Messages, Needs you) renders the post in this drawer instead of replacing the list; a hard load of the same URL (a shared link,
// a refresh, a new tab) renders the full page. One URL, two presentations, the same `PostView` inside.
//
// Closing is `router.back()`, not a push to a fixed address: the drawer is opened by intercepting a navigation, so going back is what dismisses it and returns to whatever
// list the person came from with its scroll and filters intact. Escape and the scrim close it, except while one of the action dialogs is open: the dialog's own Escape
// closes that first, and the drawer stays. The focus trap and the scroll lock are the shared overlay hook (`useFocusTrap`), the one TaskDrawer's header asks for.
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useFocusTrap } from "@/components/overlay/useFocusTrap";

export function PostDrawer({ children }: { children: ReactNode }) {
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => router.back(), [router]);
  // An action dialog (`Modal`) inside the drawer owns Escape while it is open.
  const escape = useCallback(() => { if (!document.querySelector(".ov-modal-layer")) close(); }, [close]);
  useFocusTrap(panel, true, escape);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <>
      <button type="button" className="pm-drawer__scrim" aria-label="Close post" onClick={close} />
      <div className="pm-drawer" role="dialog" aria-modal="true" aria-label="Post" tabIndex={-1} ref={panel}>
        <div className="pm-drawer__bar">
          <span className="pm-drawer__crumb">Post</span>
          <span className="pm-drawer__tools">
            <button type="button" className="pm-drawer__btn" onClick={close} aria-label="Close the post panel">Close ✕</button>
          </span>
        </div>
        <div className="pm-drawer__body erp-scroll">{children}</div>
      </div>
    </>
  );
}

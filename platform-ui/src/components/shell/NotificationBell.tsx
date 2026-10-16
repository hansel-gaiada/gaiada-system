"use client";
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";

// DW-2c: the workspace top bar's bell. A disclosure button opens a small pop-over with the latest unread
// notifications and "Open inbox".
//
// The server reads the notifications (the same read the count always used) and hands over the count and
// the newest few. `unread === null` means the read failed: no count, and the pop-over says so, never a
// made-up 0. The titles are the notifications' own `payload.title`.

export interface BellItem { id: string; title: string; createdAt: string }

/** "Just now", "5 min ago", "3 h ago", "2 d ago", then the date. Empty for a date it cannot read. */
export function formatAge(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!iso || Number.isNaN(t)) return "";
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function NotificationBell({ unread, items, loading = false }: {
  unread: number | null; items: BellItem[];
  /** The read is still in flight (the top bar streams it): drawn with no count, and the pop-over says so instead of "Couldn't load". */
  loading?: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Following a link in the pop-over (or any navigation) is done with it.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Escape" || !open) return;
    e.stopPropagation();
    setOpen(false);
    btn.current?.focus();
  }

  const failed = unread === null;
  const count = unread ?? 0;
  const now = Date.now();

  return (
    <div className="erp-bell" ref={wrap} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={btn}
        className="erp-top__bell"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={count > 0 ? `Notifications, ${count} unread` : "Notifications"}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="bell" size={19} />
        {count > 0 && <span className="erp-top__badge" aria-hidden="true">{count > 9 ? "9+" : count}</span>}
      </button>
      {open && (
        <div className="erp-bell__pop" id={panelId} role="region" aria-label="Notifications">
          {loading ? (
            <p className="erp-bell__note">Loading notifications…</p>
          ) : failed ? (
            <p className="erp-bell__note">Couldn&apos;t load notifications</p>
          ) : items.length === 0 ? (
            <p className="erp-bell__note">Nothing new</p>
          ) : (
            <ul className="erp-bell__list">
              {items.map((n) => (
                <li key={n.id} className="erp-bell__item">
                  <span className="erp-bell__title">{n.title}</span>
                  <span className="erp-bell__age">{formatAge(n.createdAt, now)}</span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/me/inbox" className="erp-bell__all" onClick={() => setOpen(false)}>Open inbox</Link>
        </div>
      )}
    </div>
  );
}

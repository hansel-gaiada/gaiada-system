"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { logout } from "@/app/(app)/account/actions";

// The portal's account button. Two items only: the client's own profile, and sign out.
//
// It reuses the STAFF `logout` server action rather than duplicating it — that action clears the shared
// `gaiada_session` cookie and redirects to `/login`, which is exactly right for a client too (same realm,
// same session mechanism). A second implementation would be a second thing to get wrong about signing
// out, and getting sign-out wrong on an external-facing surface is the worst class of bug here.
//
// Not a reuse of `shell/UserMenu`: that one links to `/account` (staff preferences: density, width,
// theme) and carries the sidebar's name/role card. This links to `/portal/profile` and is a bare icon
// button, because the header already shows who the person is.
export function PortalUserMenu({ initials }: { initials: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="erp-usermenu" ref={ref}>
      {open && (
        <div className="erp-usermenu__pop" role="menu" aria-label="Account menu">
          <Link href="/portal/profile" role="menuitem" className="erp-usermenu__item" onClick={() => setOpen(false)}>
            Your profile
          </Link>
          <form action={logout}>
            <button type="submit" role="menuitem" className="erp-usermenu__item erp-usermenu__item--danger">
              Sign out
            </button>
          </form>
        </div>
      )}
      <button
        type="button"
        className="erp-side__avatar erp-usermenu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
      >
        {initials}
      </button>
    </div>
  );
}

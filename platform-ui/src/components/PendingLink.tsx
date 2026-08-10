"use client";
import Link from "next/link";
import { useLinkStatus } from "next/link";
import type { ReactNode } from "react";
import "./feedback.css";

// A Link that says it was clicked.
//
// Next renders a `loading.tsx` boundary when a route SEGMENT changes. The suite's most-used
// navigations are not segment changes: the project workspace's tabs, the calendar's view/date
// stepper and the scope pills are all `?query=` links on the SAME segment. Next re-renders those
// server-side with no boundary at all, so the old content sits there — indistinguishable from a
// click that never registered — until the new payload arrives. On a cold segment that is seconds.
//
// `useLinkStatus` (Next 15.3+) reports the pending state of the enclosing Link, which is exactly
// this gap. It only works from a component INSIDE the Link, hence the inner <Status/>.
function Status({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus();
  return (
    <span className={`fb-pending${pending ? " fb-pending--on" : ""}`}>
      {children}
      {/* aria-live so a screen reader hears the wait rather than sitting in silence. */}
      <span className="fb-pending__dot" aria-hidden="true" />
      {pending && <span className="fb-sr-only" role="status">Loading…</span>}
    </span>
  );
}

export function PendingLink({ href, className, children, ...rest }: {
  href: string;
  className?: string;
  children: ReactNode;
  "aria-selected"?: boolean;
  // "page" — the value every OTHER tab row in this app uses for "this is the active view"
  // (`/pm`'s own inline `tab()`, `PmSurfaceTabs`) — added so the project workspace's tab row can
  // finally match (it never set `aria-current` at all before P4-UX1).
  "aria-current"?: "page" | "true" | undefined;
  "aria-label"?: string;
  role?: string;
  title?: string;
}) {
  return (
    <Link href={href} className={className} {...rest}>
      <Status>{children}</Status>
    </Link>
  );
}

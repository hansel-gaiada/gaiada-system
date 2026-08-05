"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { assistantDrawerHref } from "@/lib/assistantContext";
import "./assistant-fab.css";

// ASST-22 — the persistent trigger that makes the assistant reachable from anywhere in the ERP, not
// only at `/assistant`. Mounted once in `Shell` (every app page renders through `Shell`), mirroring
// aivory's `AivoryAssistant.tsx`/`AiraFloatingAssistant.tsx` FAB — same idea, one difference: this
// FAB is a plain `next/link`, not a component holding its own open/close state. The "open" state IS
// the Next.js router's own state (whether `/assistant` is the current route) — clicking it triggers
// the SAME client-side navigation the intercepted drawer route
// (`app/(app)/@drawer/(.)assistant/page.tsx`) is set up to catch, so there is nothing here to keep
// in sync with that route's own rendering.
//
// `id="asst-fab-trigger"` is load-bearing: `AssistantDrawer`'s close handler looks up this exact id
// to return focus here when the drawer closes (see that file's header on why an explicit lookup,
// not just "wherever the browser leaves focus", is used).
//
// Hidden on `/assistant` itself (both the full page and — impossible in practice, since the drawer
// intercepts navigation TO `/assistant` FROM elsewhere — the drawer): a floating trigger for a
// surface you're already looking at is redundant chrome, not a helpful shortcut.
export function AssistantFab({ tenantId }: { tenantId: string | null }) {
  const pathname = usePathname();
  if (pathname === "/assistant") return null;
  return (
    <Link
      id="asst-fab-trigger"
      href={assistantDrawerHref(pathname, tenantId)}
      className="asst-fab"
      aria-label="Open assistant"
    >
      Assistant
    </Link>
  );
}

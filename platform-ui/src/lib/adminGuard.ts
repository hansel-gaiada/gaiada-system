// DW-D20: the one line every Admin-area page runs. A route the table (`lib/adminAccess.ts`) denies is a
// 404; a route it allows, or does not know, renders as before and the server stays the authority.
import { notFound } from "next/navigation";
import type { Me } from "@/lib/platform";
import { adminRouteAllowed } from "@/lib/adminAccess";

export function guardAdminRoute(pathname: string, me: Me, tenantId: string | null): void {
  if (adminRouteAllowed(pathname, me, tenantId) === false) notFound();
}

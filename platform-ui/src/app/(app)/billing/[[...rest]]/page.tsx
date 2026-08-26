import { permanentRedirect } from "next/navigation";

// `/billing` moved to `/invoices` (2026-08-26). This keeps the old path working.
//
// The module was renamed because every route, table and Cerbos kind already said "invoice" while
// the module key, its permissions and this path said "billing" — and "billing" separately meant a
// client's billing ADDRESS and vendor billing in the search providers, so it named three things.
//
// ── WHY A REDIRECT RATHER THAN JUST DELETING THE ROUTE ─────────────────────────────────────────
// The old path is in places this rename cannot reach: bookmarks, an emailed invoice link, a
// notification row already written to the database (`seed/agency.ts` wrote `href: "/billing"`, and
// notifications are historical records — rewriting them would be falsifying what was sent). A
// deleted route would 404 those, which reads as "the app is broken" rather than "this moved".
//
// The optional catch-all forwards the whole tail, so `/billing/<id>` lands on that same invoice
// rather than dumping the reader on the list and making them find it again.
//
// `permanentRedirect` (308) rather than a temporary one: the move is not provisional, and a 308
// lets a browser stop asking. It also PRESERVES THE METHOD, which a 302 does not — a form POSTing
// to an old path would be silently downgraded to GET and would look like a write that vanished.
//
// This is a compatibility shim with an expiry: once the live notification rows carrying `/billing`
// have aged out, it can go. Until then it costs one file and prevents a dead link.
export default async function BillingRedirect({
  params,
}: {
  params: Promise<{ rest?: string[] }>;
}) {
  const { rest } = await params;
  permanentRedirect(`/invoices${rest?.length ? `/${rest.join("/")}` : ""}`);
}

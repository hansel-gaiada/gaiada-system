import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listPortalInvoices } from "@/lib/portal-data";
import { money, portalDate } from "@/lib/portal";
import { Card, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalFigure, PortalPageHead, PortalStatus } from "@/components/portal/PortalBits";

// CP-13 — the client's statement.
//
// Open invoices first, then settled ones. `draft` invoices never reach this page (the BFF excludes them):
// a draft is our internal working copy, and showing a client a number nobody has decided to charge them
// is worse than showing nothing.
//
// The per-currency split is respected rather than summed. `invoices.currency` is per-row, and adding two
// currencies produces a total that is wrong in a way nobody notices until it is quoted back at you.
export default async function PortalInvoicesPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>No workspace selected.</EmptyNote>;

  const invoices = await listPortalInvoices(userId, tenant);
  const open = invoices.filter((i) => i.balance > 0 && i.status !== "void");
  const settled = invoices.filter((i) => !(i.balance > 0 && i.status !== "void"));

  // Totals per currency, computed from the rows already on the page so the headline can never disagree
  // with the list beneath it.
  const totals = new Map<string, { outstanding: number; pending: number }>();
  for (const i of open) {
    const t = totals.get(i.currency) ?? { outstanding: 0, pending: 0 };
    t.outstanding += i.balance;
    t.pending += i.pendingConfirmation;
    totals.set(i.currency, t);
  }

  return (
    <>
      <PortalPageHead
        eyebrow="Your account"
        title="Invoices"
        lead="What we've billed, what you've paid, and how to tell us about a transfer."
        actions={<PortalLive topics={["invoices"]} />}
      />

      {invoices.length === 0 ? (
        <EmptyNote>No invoices yet.</EmptyNote>
      ) : (
        <div className="cp-stack">
          {totals.size > 0 && (
            <Card title="Outstanding">
              <div className="cp-grid">
                {[...totals.entries()].map(([currency, t]) => (
                  <div key={currency}>
                    <PortalFigure
                      label={`Due (${currency})`}
                      value={money(t.outstanding, currency)}
                      tone="danger"
                      foot={t.pending > 0 ? `${money(t.pending, currency)} awaiting our verification` : undefined}
                    />
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card title={open.length > 0 ? "Open invoices" : "Nothing outstanding"}>
            {open.length === 0 ? (
              <EmptyNote>Everything is settled — thank you.</EmptyNote>
            ) : (
              <div style={{ display: "grid", gap: 14 }}>
                {open.map((i) => <Row key={i.id} i={i} />)}
              </div>
            )}
          </Card>

          {settled.length > 0 && (
            <Card title="Settled">
              <div style={{ display: "grid", gap: 14 }}>
                {settled.map((i) => <Row key={i.id} i={i} />)}
              </div>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

function Row({ i }: { i: Awaited<ReturnType<typeof listPortalInvoices>>[number] }) {
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap" }}>
      <div style={{ minWidth: 0, flex: "1 1 220px" }}>
        <Link href={`/portal/invoices/${i.id}`} style={{ font: "500 14px/1.4 var(--font-body)", color: "var(--ink-strong)", textDecoration: "none" }}>
          {/* The period is what a client recognises an invoice by, far more than its id. */}
          {i.periodStart && i.periodEnd ? `${portalDate(i.periodStart)} — ${portalDate(i.periodEnd)}` : `Invoice ${i.id}`}
        </Link>
        <div style={{ font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
          Issued {portalDate(i.issuedAt)}
          {/* `overdue` is computed server-side against the DB clock, not from the browser's date. */}
          {i.overdue && <span style={{ color: "var(--status-danger-fg)", fontWeight: 500 }}> · overdue</span>}
          {i.pendingConfirmation > 0 && <span> · {money(i.pendingConfirmation, i.currency)} being verified</span>}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <Eyebrow style={{ display: "block", fontSize: 10, opacity: 0.55 }}>
          {i.balance > 0 ? "Due" : "Total"}
        </Eyebrow>
        <span className="cp-money cp-money--sm" style={i.balance > 0 && i.overdue ? { color: "var(--status-danger-fg)" } : undefined}>
          {money(i.balance > 0 ? i.balance : i.total, i.currency)}
        </span>
      </div>
      <PortalStatus status={i.status} />
    </div>
  );
}

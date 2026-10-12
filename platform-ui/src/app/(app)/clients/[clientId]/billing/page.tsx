import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import type { ReactNode } from "react";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listProjects } from "@/lib/entities";
import { readResult, type ReadResult } from "@/lib/readResult";
import { getContract, listClientInvoices, listClientPayments, listContracts } from "@/lib/contracts-data";
import { groupContracts, type ContractDetail } from "@/lib/contracts";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { ContractForm } from "@/components/clients/billing/ContractForm";
import { ContractRow } from "@/components/clients/billing/ContractRow";
import { PaymentRow } from "@/components/clients/billing/PaymentRow";
import { formatDate, money } from "@/lib/format";
import "@/components/clients/billing/billing.css";

// PV3-08 — the hub's CONTRACTS & BILLING area (`/clients/[id]/billing`; BFF §16e).
//
// Before this, staff could not draft, send or countersign a contract, or confirm a payment a client
// reported, without calling the API by hand: no screen existed, and the Overview's "send a drafted
// agreement" item linked to a page that was never built. Three sections, in the order a relationship runs:
//   1. Contracts: Draft · Sent · Signed · Void (and Declined or expired when there are any).
//   2. Payments to confirm: this client's pending claims, with Confirm and Reject.
//   3. Invoices: a LIST ONLY. Deeper invoice work stays on `/invoices/[id]` until D7 is decided.
//
// ── EVERY READ REFUSES EXPLICITLY ───────────────────────────────────────────────────────────────
// Each of the four reads goes through `readResult()`, and a denied or failed one renders `<ReadRefusal>`
// in its own section, so one refused read never blanks the others. An empty list means the read succeeded
// and found nothing. There is no `.catch(() => [])` on this page (readiness-bar criterion 5), and the
// invoices read deliberately does NOT use `listInvoices` from lib/invoice.ts, which folds a 403 into `[]`.
//
// ── THE H1 IS THE LAYOUT'S ──────────────────────────────────────────────────────────────────────
// The hub layout renders the client's name as the page's one `<h1>`; this page starts at `<h2>`.
//
// ── NO VISIBILITY MARKERS ───────────────────────────────────────────────────────────────────────
// Which rows the client sees is PV3-09's, from a field the backend computes (trap 9). This page says
// nothing about it.
export default async function ClientBillingPage({ params }: { params: Promise<{ clientId: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { clientId } = await params;
  if (!tenant) notFound();

  const [contractsRes, paymentsRes, invoicesRes, projectsRes] = await Promise.all([
    readResult(listContracts(userId, tenant, clientId)),
    readResult(listClientPayments(userId, tenant, clientId, "pending")),
    readResult(listClientInvoices(userId, tenant, clientId)),
    // Only to offer "tie this to a project" on the draft form. Its refusal is said on the form itself.
    readResult(listProjects(userId, tenant, clientId)),
  ]);
  const projects = projectsRes.kind === "ok" ? projectsRes.data.map((p) => ({ id: p.id, name: p.name })) : null;

  // Who has signed is on the DETAIL read, not the list. Only a contract that is out with the client needs
  // it, and there are few of those, so one read per sent contract (each refusal kept per row).
  const detailById = new Map<string, ReadResult<ContractDetail>>();
  if (contractsRes.kind === "ok") {
    const sent = contractsRes.data.filter((c) => c.status === "sent");
    const details = await Promise.all(sent.map((c) => readResult(getContract(userId, tenant, c.id))));
    sent.forEach((c, i) => detailById.set(c.id, details[i]));
  }

  function renderContracts(): ReactNode {
    if (contractsRes.kind !== "ok") {
      return <ReadRefusal subject="this client's contracts" kind={contractsRes.kind} reason={reasonOf(contractsRes)} />;
    }
    const groups = groupContracts(contractsRes.data);
    return (
      <>
        <details className="bl-new" open={contractsRes.data.length === 0}>
          <summary>New draft contract</summary>
          <ContractForm clientId={clientId} projects={projects} />
        </details>
        {contractsRes.data.length === 0 && (
          <EmptyNote>No contract has been drafted for this client yet. Draft one above; it stays invisible to the client until you send it.</EmptyNote>
        )}
        {groups.map((g) => (
          <div key={g.key} className="bl-group">
            <h3 className="bl-group__title">{g.label} · {g.rows.length}</h3>
            <p className="bl-group__hint">{g.hint}</p>
            {g.rows.length === 0 ? (
              <p className="bl-none">None.</p>
            ) : (
              <Card>
                <ul style={{ margin: 0, padding: 0 }}>
                  {g.rows.map((c) => {
                    const d = detailById.get(c.id);
                    return (
                      <ContractRow
                        key={c.id}
                        contract={c}
                        clientId={clientId}
                        projects={projects}
                        signatures={d?.kind === "ok" ? d.data.signatures : undefined}
                        signaturesRefused={d && d.kind !== "ok" ? (d.kind === "forbidden" ? "you may not read it" : d.reason) : undefined}
                      />
                    );
                  })}
                </ul>
              </Card>
            )}
          </div>
        ))}
      </>
    );
  }

  function renderPayments(): ReactNode {
    if (paymentsRes.kind !== "ok") {
      return <ReadRefusal subject="this client's payments" kind={paymentsRes.kind} reason={reasonOf(paymentsRes)} />;
    }
    if (paymentsRes.data.length === 0) {
      return <EmptyNote>No payment is waiting for confirmation. When this client reports a payment in their portal it appears here.</EmptyNote>;
    }
    return (
      <Card>
        <ul style={{ margin: 0, padding: 0 }}>
          {paymentsRes.data.map((p) => <PaymentRow key={p.id} payment={p} clientId={clientId} />)}
        </ul>
      </Card>
    );
  }

  function renderInvoices(): ReactNode {
    if (invoicesRes.kind !== "ok") {
      return <ReadRefusal subject="this client's invoices" kind={invoicesRes.kind} reason={reasonOf(invoicesRes)} />;
    }
    if (invoicesRes.data.kind === "off") {
      return <EmptyNote>Invoicing is not turned on for this company, so there is no invoice list to show here. This is not a statement that the client has none.</EmptyNote>;
    }
    const invoices = invoicesRes.data.invoices;
    if (invoices.length === 0) return <EmptyNote>No invoice has been raised for this client.</EmptyNote>;
    return (
      <Card>
        <HairlineTable
          columns={[{ label: "Period" }, { label: "Status" }, { label: "Total", align: "right" }]}
          rows={invoices.map((i) => [
            <Link key="p" href={`/invoices/${i.id}`} style={{ color: "var(--ink-strong)", textDecoration: "none" }}>
              {i.periodStart && i.periodEnd ? `${formatDate(i.periodStart)} to ${formatDate(i.periodEnd)}` : `Invoice ${i.id}`}
            </Link>,
            <StatusBadge key="s" label={i.status} />,
            money(i.total, i.currency),
          ])}
        />
      </Card>
    );
  }

  return (
    <div className="bl-sections">
      <section aria-labelledby="bl-contracts">
        <h2 id="bl-contracts" className="bl-section__title">Contracts</h2>
        <p className="bl-section__lede">
          Draft, send and countersign agreements. A contract becomes Signed once both parties have signed, in
          either order.
        </p>
        {renderContracts()}
      </section>

      <section aria-labelledby="bl-payments">
        <h2 id="bl-payments" className="bl-section__title">Payments to confirm</h2>
        <p className="bl-section__lede">
          Payments the client says they made. The balance does not move until someone other than whoever
          recorded the payment confirms it.
        </p>
        {renderPayments()}
      </section>

      <section aria-labelledby="bl-invoices">
        <h2 id="bl-invoices" className="bl-section__title">Invoices</h2>
        <p className="bl-section__lede">The list only. Open an invoice to work on it.</p>
        {renderInvoices()}
      </section>
    </div>
  );
}

function reasonOf(r: { kind: string; reason?: string }): string | undefined {
  return r.kind === "unavailable" ? r.reason : undefined;
}

import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can, isElevated } from "@/lib/rbac";
import { listClients } from "@/lib/entities";
import { listBillableInstalmentsResult } from "@/lib/contractBilling-data";
import { dueByOrToday } from "@/lib/contractBilling";
import { formatDate, todayIsoInDisplayZone } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { InvoiceForm } from "@/components/forms/InvoiceForm";
import { InstalmentPicker } from "@/components/billing/InstalmentPicker";
import { createInvoiceAction } from "@/lib/invoiceActions";
import "@/components/billing/billing-screens.css";

// DW-10f-3b (BFF §61.5, §61.9, DW-D45, DW-D48) — a new invoice is drafted FROM A CONTRACT'S PAYMENT SCHEDULE.
//
// Pick a client and "Due up to" (today by default): the checklist is `GET invoices/billable-instalments` for that client, every `due`
// row ticked, `upcoming` rows shown with their date and not selectable, `invoicing` rows linking their draft. "Create from the
// schedule" makes the draft. The hourly form is the EXPLICIT EXCEPTION (DW-D48): it sits behind "From logged hours (exception)",
// unchanged, and an invoice is never both.
//
// The choice is a plain GET form (client and date in the URL), so the page is a server render with no client state to lose, and a
// link to "this client, up to that date" works. The read never swallows a refusal: a failed or refused read says so (`ReadRefusal`),
// and an empty list says what it means ("Nothing is due for this client up to <date>"), never a blank table.
//
// Gate: unchanged. `company.manage` (or elevated) sees it; the server authorizes `invoice` `create` and is the authority.
export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<{ clientId?: string; dueBy?: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const crumbs = [{ label: "Invoices", href: "/invoices" }, { label: "New invoice" }];
  if (!tenant || (!can(me, "company.manage", tenant) && !isElevated(me))) {
    return (<><PageHeader eyebrow="Business" title="New invoice" breadcrumbs={crumbs} /><EmptyNote>Invoicing is limited to finance administrators.</EmptyNote></>);
  }
  const clients = (await listClients(userId, tenant)).map((c) => ({ id: c.id, name: c.name }));
  const sp = await searchParams;
  const clientId = clients.some((c) => c.id === sp.clientId) ? (sp.clientId as string) : "";
  const { dueBy, invalid } = dueByOrToday(sp.dueBy, todayIsoInDisplayZone());
  const billable = clientId ? await listBillableInstalmentsResult(userId, tenant, { clientId, dueBy }) : null;

  return (
    <>
      <PageHeader eyebrow="Business" title="New invoice" breadcrumbs={crumbs} />
      <Card title="From the payment schedule">
        <div className="bs-pickform">
          <form method="get" action="/invoices/new" aria-label="Choose what to bill" className="bs-pickform__row">
            <div className="bs-field">
              <label className="bs-field__label" htmlFor="bill-client">Client</label>
              <select id="bill-client" name="clientId" defaultValue={clientId} required>
                <option value="" disabled>Choose a client</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="bs-field">
              <label className="bs-field__label" htmlFor="bill-due-by">Due up to</label>
              <input id="bill-due-by" name="dueBy" type="date" defaultValue={dueBy} required />
            </div>
            <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Show instalments</button>
          </form>
          <p className="bs-note">
            Instalments of signed agreements that are due by that date. Each is invoiced once. Move the date forward to invoice ahead of a due date.
          </p>
          {invalid && <p className="bs-error" role="alert">That &quot;Due up to&quot; date is not a date, so today is used.</p>}

          {!clientId ? (
            <EmptyNote>Choose a client to see what is due to invoice.</EmptyNote>
          ) : billable && billable.kind !== "ok" ? (
            <ReadRefusal subject="this client's billable instalments" kind={billable.kind} reason={billable.kind === "unavailable" ? billable.reason : undefined} inline />
          ) : billable ? (
            <>
              {!billable.data.items.some((i) => i.state === "due") && (
                <EmptyNote>Nothing is due for this client up to {formatDate(billable.data.dueBy)}.</EmptyNote>
              )}
              {billable.data.items.length > 0 && (
                <InstalmentPicker key={`${clientId}:${billable.data.dueBy}`} clientId={clientId} dueBy={billable.data.dueBy} items={billable.data.items} />
              )}
            </>
          ) : null}
        </div>
      </Card>

      {/* DW-D48: the hourly draft stays as an explicit exception, unchanged. An invoice is either instalments or hours, never both. */}
      <details className="bs-exception" style={{ marginTop: 20 }}>
        <summary>From logged hours (exception)</summary>
        <div className="bs-exception__body">
          <p className="bs-note">
            Use this only for work that no agreement&apos;s payment schedule covers. An invoice is made from the schedule or from logged hours, never both.
          </p>
          <Card><InvoiceForm action={createInvoiceAction} clients={clients} /></Card>
        </div>
      </details>
    </>
  );
}

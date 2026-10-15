import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { PaymentRow } from "@/components/clients/billing/PaymentRow";
import type { InvoicePayment } from "@/lib/contracts";
import type { ReadResult } from "@/lib/readResult";

// DW-7e-2: Finance's company-wide queue of client payments waiting for a decision, on Receivables. It is the target of the
// Finance Overview's "Client payments to confirm" tile and its "Confirm payments" quick action (`#payments-to-confirm`).
//
// Each row is the client hub's own `PaymentRow` (Confirm, Reject with the reason the client reads, the maker-checker
// refusal in words), which decides through `decidePaymentAction`. The queue is read through `ReadResult`: a refused or
// failed read says so in words and is NEVER the empty note, because "none are waiting" is a claim about client money.
// Whether the section is offered at all is the page's call (it mirrors the `invoice` update rule); the server decides.
export function PaymentsToConfirm({ result }: { result: ReadResult<InvoicePayment[]> }) {
  return (
    <div id="payments-to-confirm" style={{ marginTop: 22, scrollMarginTop: 16 }}>
      <Card
        title={result.kind === "ok" ? `Payments to confirm · ${result.data.length}` : "Payments to confirm"}
        hint="Payments clients say they made. Confirming books the money and can settle the invoice; the person who recorded a payment cannot be the one who confirms it. Rejecting needs a reason, which the client reads in their portal."
      >
        {result.kind === "forbidden" && <ReadRefusal subject="payments to confirm" kind="forbidden" inline />}
        {result.kind === "unavailable" && (
          <p className="sys-empty-note" role="alert">
            Could not load payments to confirm. This is not a statement that none are waiting; it means we cannot tell right now.
            {result.reason ? <span className="sys-refusal__reason"> {result.reason}</span> : null}
          </p>
        )}
        {result.kind === "ok" && result.data.length === 0 && (
          <EmptyNote>No client payment is waiting for confirmation. When a client reports a payment in their portal it appears here.</EmptyNote>
        )}
        {result.kind === "ok" && result.data.length > 0 && (
          <ul style={{ margin: 0, padding: 0 }}>
            {result.data.map((p) => <PaymentRow key={p.id} payment={p} showClient />)}
          </ul>
        )}
      </Card>
    </div>
  );
}

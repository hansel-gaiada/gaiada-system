import { StatusBadge } from "@/components/ui";
import { STATUS_LABEL } from "@/lib/mail";

// MAIL-15 — "accepted ≠ delivered" honesty (design §7.7/§13, ticket AC "status chips must not
// imply delivery"). `sent` is the ceiling in dev: Mailpit accepts and discards, there is no
// provider event feed at all, so `delivered_at` never populates against the sink. `StatusBadge`
// alone would just print "Sent" in a neutral tone — accurate but easy to misread as "delivered".
// This wraps it with the explicit caption so nobody has to know the backend nuance to read it right.
export function MailStatusChip({ status }: { status: string }) {
  const caption = status === "sent" ? STATUS_LABEL.sent : null;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
      <StatusBadge label={status} />
      {caption && (
        <span style={{ font: "400 11px/1.3 var(--font-body)", color: "var(--ink-subtle)" }}>
          {caption}
        </span>
      )}
    </span>
  );
}

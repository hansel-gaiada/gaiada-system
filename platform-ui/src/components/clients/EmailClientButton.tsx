import Link from "next/link";
import { composeHref } from "@/lib/gmail";
import "@/components/mail/mail.css";

// DW-8j (BFF §48.4): "Email this client". Small and self-contained so the PV owner can move it. It sits OUTSIDE the portal: the portal
// Conversation stays the client channel of record (PV-D5), so this is the secondary (ghost) style and reads "Email (Gmail)". The "emailed"
// activity row it leads to is staff-only; nothing here renders anything client-visible.
export const NO_CONTACT_EMAIL = "This client has no contact email";

export function EmailClientButton({ clientId, email }: { clientId: string; email: string | null }) {
  if (!email) {
    // A disabled button is not focusable, so the reason is visible text tied to it with aria-describedby (a screen reader announces it).
    const whyId = `email-client-why-${clientId}`;
    return (
      <span className="gm-contact">
        <button type="button" disabled aria-describedby={whyId} className="lux-btn lux-btn--ghost lux-btn--sm">Email (Gmail)</button>
        <span id={whyId} className="gm-why">{NO_CONTACT_EMAIL}</span>
      </span>
    );
  }
  return (
    <Link href={composeHref({ client: clientId, to: email })} className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={`Email (Gmail) ${email}`}>
      Email (Gmail)
    </Link>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { readGmailStatus } from "@/lib/gmail-data";
import { NOT_CONNECTED_TEXT, NO_MAILBOX_FOR_ROLE } from "@/lib/gmail";
import { Card } from "@/components/ui";
import { SimulatedLabel } from "@/components/mail/SimulatedLabel";
import { ComposeForm } from "@/components/mail/ComposeForm";
import "@/components/mail/mail.css";

// `/me/mail/new?to=&client=`: compose (BFF §48.4). `to` only prefills the field; the client id travels as the send's `context`, and the
// platform checks the caller may read that client. Plain text only.
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? "" : v ?? "");

export default async function NewMailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const sp = await searchParams;
  if (!tenant) return <p className="gm-note">Select a company first.</p>;

  const status = await readGmailStatus(userId, tenant);
  if (status.kind === "forbidden") return <Card><p className="gm-note">{NO_MAILBOX_FOR_ROLE}</p></Card>;
  if (status.kind === "unavailable") return <Card><p className="gm-note" role="alert">{status.reason}</p></Card>;
  if (!status.data.connected) {
    return <Card><SimulatedLabel mode={status.data.mode} /><p className="gm-note">{NOT_CONNECTED_TEXT}</p><Link href="/me/mail" className="lux-btn lux-btn--solid lux-btn--sm">Go to Mail</Link></Card>;
  }

  const clientId = one(sp.client);
  return (
    <Card title="New message" headerRight={<Link href="/me/mail" className="lux-btn lux-btn--ghost lux-btn--sm">Back to Mail</Link>}>
      <SimulatedLabel mode={status.data.mode} />
      <ComposeForm initial={{ to: one(sp.to), subject: "" }} clientId={clientId || undefined} />
    </Card>
  );
}

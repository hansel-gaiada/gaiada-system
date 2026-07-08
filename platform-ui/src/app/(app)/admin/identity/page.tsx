import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listIdentityLinks } from "@/lib/adminData";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { LinkActions } from "@/components/admin/LinkActions";
import { verifyLinkAction, unlinkAction } from "./actions";

const COLUMNS = [
  { label: "User" },
  { label: "Provider" },
  { label: "External ID" },
  { label: "Status" },
  { label: "Actions" },
];
const TCOLS = "1.4fr 1fr 1.6fr 1fr 1.6fr";

const SUBTITLE =
  "Provider identities (WhatsApp, Telegram, OIDC) linked to platform users. A link is trusted only once it is verified (D4 dual-proof) — unverified identities are never auto-trusted.";

export default async function AdminIdentityPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  let links: Awaited<ReturnType<typeof listIdentityLinks>>;
  try {
    links = tenant ? await listIdentityLinks(userId, tenant) : [];
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Admin" title="Identity Links" subtitle={SUBTITLE} />
          <Card>
            <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)" }}>
              This page is limited to administrators.
            </p>
          </Card>
        </>
      );
    }
    throw e;
  }

  return (
    <>
      <PageHeader eyebrow="Admin" title="Identity Links" subtitle={SUBTITLE} />
      <Card>
        {links.length === 0 ? (
          <EmptyNote>Identity links appear here once the backend endpoint is connected.</EmptyNote>
        ) : (
          <HairlineTable
            tcols={TCOLS}
            columns={COLUMNS}
            rows={links.map((l) => [
              l.user_name ?? l.user_id,
              l.provider,
              l.external_id,
              <StatusBadge key={`${l.id}-status`} label={l.verified_at ? "Verified" : "Unverified"} />,
              <LinkActions
                key={`${l.id}-actions`}
                verified={!!l.verified_at}
                verify={verifyLinkAction.bind(null, l.id)}
                unlink={unlinkAction.bind(null, l.id)}
              />,
            ])}
          />
        )}
      </Card>
      <p style={{ margin: "16px 2px 0", font: "400 13px/1.5 var(--font-body)", color: "rgba(26,25,22,.5)", maxWidth: 640 }}>
        D4 note: identity links pair an external provider identity with a platform user. Verification requires
        dual-proof — a second, independent signal beyond the initial claim — before the link is trusted for
        sensitive actions. Unverified links can be unlinked but are never treated as trusted identity.
      </p>
    </>
  );
}

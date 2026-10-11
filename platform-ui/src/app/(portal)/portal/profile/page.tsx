import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { getPortalProfile } from "@/lib/portal-data";
import { getPortalWebsiteAccess } from "@/lib/clientWebsiteAccess";
import { portalDate } from "@/lib/portal";
import { describeAccess, groupPeople } from "@/lib/portalPeople";
import { Card, Eyebrow, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalChangeRequestForm, PortalOwnDetailsForm } from "@/components/portal/PortalProfileForms";
import { PortalCopyEmail } from "@/components/portal/PortalCopyEmail";
import { PortalWebsiteAccessCard } from "@/components/portal/PortalWebsiteAccessCard";
import { PortalFacts, PortalPageHead, PortalStatus } from "@/components/portal/PortalBits";

// CP-15 — who the client is, who their people are, and what this account may do.
//
// The ACCESS card is the part that earns its place. A view-only contact who finds the sign button
// disabled has no way to know whether the portal is broken, whether they are the wrong person, or whether
// something is wrong with the agreement — so the portal states their capability plainly and names the
// remedy (ask the account manager). Governance information a client owns, surfaced rather than implied.
export default async function PortalProfilePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return <EmptyNote>No client account is linked to your sign-in, so there is nothing to show here. Overview explains why.</EmptyNote>;

  const profile = await getPortalProfile(userId, tenant);
  if (!profile) {
    return (
      <>
        <PortalPageHead eyebrow="Your details" title="People" />
        <EmptyNote>We couldn&apos;t load your profile. Please try again shortly.</EmptyNote>
      </>
    );
  }

  const groups = groupPeople(profile);
  // WSK-49f: a client ADMIN also sees who may edit the website. The profile names the caller's own
  // client-wide admin grants; only for those clients do we ask the BFF, and the BFF stays the authority:
  // a 403 (or anything that is not an answer) leaves the section out, never a disabled copy of it.
  const adminClientIds = adminClientsOf(profile);
  const websiteAccess = (
    await Promise.all(
      adminClientIds.map(async (clientId) => ({ clientId, result: await getPortalWebsiteAccess(userId, tenant, clientId) })),
    )
  ).flatMap((r) => (r.result.kind === "forbidden" ? [] : [{ clientId: r.clientId, result: r.result }]));
  const client = profile.clients[0] ?? null;
  const contact = (client?.contact ?? {}) as Record<string, unknown>;
  const contactRow = (key: string, label: string) =>
    typeof contact[key] === "string" && contact[key] ? [{ k: label, v: String(contact[key]) }] : [];

  return (
    <>
      <PortalPageHead
        eyebrow="Your details"
        title="People"
        lead="Your own details, your organisation's record with us, and who else has access."
      />

      <div className="cp-stack">
        <Card title="Your details">
          {profile.me ? (
            <>
              <PortalFacts
                rows={[
                  { k: "Email", v: profile.me.email },
                  { k: "With us since", v: portalDate(profile.me.memberSince) },
                ]}
              />
              <div style={{ marginTop: 16 }}>
                <PortalOwnDetailsForm name={profile.me.name} title={profile.me.title} />
              </div>
            </>
          ) : (
            <EmptyNote>Your account details are unavailable.</EmptyNote>
          )}
        </Card>

        <Card title="Your access" hint="What this login can do on the portal. Set by your account manager.">
          <PortalFacts
            rows={[
              {
                k: "Can sign",
                v: profile.access.canSign
                  ? "Yes — you can sign agreements and approve work"
                  : "No — you can read everything and send feedback",
                strong: true,
              },
              {
                k: "Covers",
                v: profile.access.wholeClient
                  ? "Every project on your account"
                  : profile.access.grants
                      .map((g) => g.projectName)
                      .filter(Boolean)
                      .join(", ") || "Specific projects only",
              },
            ]}
          />
          {!profile.access.canSign && (
            <p style={{ margin: "12px 0 0", font: "400 12px/1.55 var(--font-body)", color: "var(--ink-subtle)" }}>
              If you need to be able to sign, ask your account manager to change your access — it takes them
              a moment.
            </p>
          )}
        </Card>

        {client && (
          <Card title={client.name} headerRight={<PortalStatus status={client.status} />}>
            <PortalFacts
              rows={[
                { k: "Projects", v: String(client.projectCount) },
                ...contactRow("email", "Billing email"),
                ...contactRow("phone", "Phone"),
                ...contactRow("address", "Address"),
              ]}
            />
            <div style={{ marginTop: 20 }}>
              <Eyebrow style={{ display: "block", marginBottom: 8, opacity: 0.6 }}>Need something changed?</Eyebrow>
              <PortalChangeRequestForm clientId={client.id} />
            </div>
          </Card>
        )}

        <Card
          title="Your people"
          hint="Everyone from your organisation who can sign in to this portal. Ask your account manager to add or remove someone."
        >
          {groups.yourPeople.length === 0 ? (
            <EmptyNote>No other contacts.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Name" }, { label: "Email" }, { label: "Access" }, { label: "Status" }]}
              tcols="1fr 1fr 190px 140px"
              rows={groups.yourPeople.map((c) => [
                c.id === profile.me?.id ? `${c.name} (you)` : c.name,
                c.email,
                accessText(c),
                // `invited` is a real and confusing state - the person has been sent a link and has not
                // used it. Surfacing it lets the client chase their own colleague instead of asking us
                // why someone cannot get in.
                <PortalStatus key={c.id} status={c.status === "invited" ? "pending" : c.status} />,
              ])}
            />
          )}
        </Card>

        {websiteAccess.map(({ clientId, result }) => (
          <PortalWebsiteAccessCard
            key={clientId}
            clientId={clientId}
            clientName={profile.clients.find((c) => c.id === clientId)?.name ?? "your account"}
            showClientName={websiteAccess.length > 1}
            meUserId={profile.me?.id ?? null}
            initial={result}
          />
        ))}

        {groups.accountManagers.length > 0 && (
          <Card title="Your account manager" hint="The person at our company who looks after your account.">
            <PortalFacts
              rows={groups.accountManagers.map((m) => ({
                k: groups.accountManagers.length > 1 ? m.clientName : "Name",
                v: (
                  <>
                    {m.name}
                    {" · "}
                    <PortalCopyEmail email={m.email} />
                  </>
                ),
              }))}
            />
          </Card>
        )}

        {groups.onOurSide.length > 0 && (
          <Card title="On our side">
            <p style={{ margin: "0 0 12px", font: "400 13px/1.55 var(--font-body)", color: "var(--ink-muted)" }}>
              People from our company who also hold access to your account.
            </p>
            <HairlineTable
              columns={[{ label: "Name" }, { label: "Email" }, { label: "Access" }]}
              tcols="1fr 1fr 190px"
              rows={groups.onOurSide.map((c) => [c.name, c.email, accessText(c)])}
            />
          </Card>
        )}
      </div>
    </>
  );
}

/** The clients where the caller holds the client-wide `admin` capability, per their own profile. A
 *  project-scoped admin row carries no website power (the server refuses it), so it is not counted. */
function adminClientsOf(profile: { access: { grants: Array<{ capability: string; clientId: string; projectId: string | null }> } }): string[] {
  return [...new Set(profile.access.grants.filter((g) => g.capability === "admin" && g.projectId === null).map((g) => g.clientId))];
}

function accessText(c: { capability: string; projectId: string | null }): string {
  const a = describeAccess(c);
  return `${a.capability}, ${a.scope.toLowerCase()}`;
}

import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPortalProfile } from "@/lib/portal-data";
import { portalDate } from "@/lib/portal";
import { Card, Eyebrow, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalChangeRequestForm, PortalOwnDetailsForm } from "@/components/portal/PortalProfileForms";
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
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>No workspace selected.</EmptyNote>;

  const profile = await getPortalProfile(userId, tenant);
  if (!profile) {
    return (
      <>
        <PortalPageHead eyebrow="Your details" title="Profile" />
        <EmptyNote>We couldn&apos;t load your profile. Please try again shortly.</EmptyNote>
      </>
    );
  }

  const client = profile.clients[0] ?? null;
  const contact = (client?.contact ?? {}) as Record<string, unknown>;
  const contactRow = (key: string, label: string) =>
    typeof contact[key] === "string" && contact[key] ? [{ k: label, v: String(contact[key]) }] : [];

  return (
    <>
      <PortalPageHead
        eyebrow="Your details"
        title="Profile"
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
          title="Who has access"
          hint="Everyone from your organisation who can sign in to this portal. Ask your account manager to add or remove someone."
        >
          {profile.contacts.length === 0 ? (
            <EmptyNote>No other contacts.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Name" }, { label: "Email" }, { label: "Can sign" }, { label: "Status" }]}
              tcols="1fr 1fr 110px 140px"
              rows={profile.contacts.map((c) => [
                c.id === profile.me?.id ? `${c.name} (you)` : c.name,
                c.email,
                c.capability === "signer" ? "Yes" : "No",
                // `invited` is a real and confusing state — the person has been sent a link and has not
                // used it. Surfacing it lets the client chase their own colleague instead of asking us
                // why someone cannot get in.
                <PortalStatus key={c.id} status={c.status === "invited" ? "pending" : c.status} />,
              ])}
            />
          )}
        </Card>
      </div>
    </>
  );
}

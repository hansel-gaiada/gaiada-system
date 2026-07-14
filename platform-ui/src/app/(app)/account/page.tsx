import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { PageHeader } from "@/components/PageHeader";
import { Card, StatusBadge } from "@/components/ui";
import { DescriptionList } from "@/components/DescriptionList";
import { logout } from "./actions";

const SCOPE_LABEL: Record<string, string> = {
  global: "Global",
  company: "Company",
  team: "Team",
};

export default async function AccountPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);

  const identity = [
    { label: "Name", value: me.name },
    { label: "Email", value: me.email },
    { label: "Title", value: me.title ?? "—" },
    { label: "Assurance", value: <StatusBadge label={me.assurance === "high" ? "configured" : me.assurance} /> },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Your profile"
        subtitle="The principal the platform recognises for you, the companies you can act in, and the roles you hold."
        actions={
          <form action={logout}>
            <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Sign out</button>
          </form>
        }
      />

      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <Card title="Identity">
          <DescriptionList items={identity} />
        </Card>

        <Card title="Companies">
          {me.companies.length === 0 ? (
            <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.6)" }}>
              You are not a member of any company yet.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {me.companies.map((c) => (
                <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <span style={{ font: "400 14px var(--font-body)", color: "var(--text-primary)" }}>{c.name}</span>
                  {c.type && (
                    <span style={{ font: "700 10px var(--font-body)", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>
                      {c.type}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Roles">
          {me.roles.length === 0 ? (
            <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.6)" }}>
              No roles assigned. You have general access only.
            </p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {me.roles.map((r, i) => (
                <span
                  key={`${r.role}-${i}`}
                  style={{ display: "inline-flex", alignItems: "center", gap: 8, border: "0.5px solid var(--erp-hairline)", padding: "7px 12px" }}
                >
                  <span style={{ font: "400 13px var(--font-body)", color: "var(--text-primary)" }}>{r.role}</span>
                  <span style={{ font: "700 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>
                    {SCOPE_LABEL[r.scopeType] ?? r.scopeType}
                  </span>
                </span>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

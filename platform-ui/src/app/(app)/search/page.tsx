import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { globalSearch, type SearchGroup } from "@/lib/search";
import { PageHeader } from "@/components/PageHeader";
import { Card, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

type SP = Promise<Record<string, string | string[] | undefined>>;

function HitRow({ hit }: { hit: SearchGroup["hits"][number] }) {
  const inner = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "11px 4px" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ font: "400 14px var(--font-body)", color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{hit.label}</div>
        {hit.sublabel && <div style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>{hit.sublabel}</div>}
      </div>
      {hit.status && <StatusBadge label={hit.status} />}
    </div>
  );
  if (!hit.href) return <div className="lux-hit">{inner}</div>;
  return <Link href={hit.href} className="lux-hit lux-hit--link">{inner}</Link>;
}

export default async function SearchPage({ searchParams }: { searchParams: SP }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q ?? "").trim();

  const groups = q ? await globalSearch(userId, tenant, q) : [];
  const total = groups.reduce((n, g) => n + g.hits.length, 0);

  return (
    <>
      <PageHeader
        eyebrow="Search"
        title={q ? `Results for "${q}"` : "Search"}
        subtitle={q ? `${total} match${total === 1 ? "" : "es"} across companies, projects, tasks, campaigns and people.` : "Find records, people and approvals across every company you can access."}
      />

      {!q ? (
        <Card><EmptyNote>Type at least two characters in the top bar to search.</EmptyNote></Card>
      ) : total === 0 ? (
        <Card><EmptyNote>No matches. Try a different term, or switch company in the top bar.</EmptyNote></Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {groups.map((g) => (
            <Card key={g.key} title={`${g.label} · ${g.hits.length}`}>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {g.hits.map((hit, i) => (
                  <HitRow key={`${g.key}-${i}`} hit={hit} />
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import Link from "next/link";
import {
  getSystemStatus, getKnowledgeSources, searchKnowledge, KNOWLEDGE_QUERY_INVALID,
  type KnowledgeSearchFamily, type KnowledgeSearchResponse,
} from "@/lib/admin";
import type { ReadResult } from "@/lib/readResult";
import { formatTimestamp } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Button, Card, HairlineTable, StatusBadge } from "@/components/ui";
import { Field } from "@/components/forms/Field";
import { StatusCard } from "@/components/systems/StatusCard";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReviewButtons } from "@/components/systems/ReviewButtons";
import { OutcomeScope } from "@/components/OutcomeScope";
import { reviewSource } from "./actions";

const FAMILY_LABEL: Record<KnowledgeSearchFamily, string> = {
  client: "Client", project: "Project", task: "Task", pmtask: "Task",
  deliverable: "Deliverable", meeting: "Meeting", pmdoc: "Document", file: "File",
};

// DW-8i (BFF section 46): search for staff. The query lives in the URL (a plain GET form, so it works
// with no JS and the result page can be linked). The backend drops every hit the viewer cannot open,
// so "Nothing you can open matches." is evidence; unavailable and forbidden are their own states and
// are never rendered as "no results".
function SearchPanel({ q, res }: { q: string; res: ReadResult<KnowledgeSearchResponse> | null }) {
  const tooShort = q.length > 0 && q.length < 2;
  const invalid = res?.kind === "unavailable" && res.reason === KNOWLEDGE_QUERY_INVALID;
  const indexedAt = res?.kind === "ok" ? res.data.indexedAt : null;
  return (
    <Card title="Search company knowledge">
      <form method="get" action="/knowledge" style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <Field name="q" label="Search" defaultValue={q} placeholder="Clients, projects, tasks, meetings, documents, files" />
        </div>
        <Button type="submit">Search</Button>
      </form>
      <div role="status" style={{ marginTop: 14 }}>
        {(tooShort || invalid) && <EmptyNote>Type at least 2 characters.</EmptyNote>}
        {res?.kind === "unavailable" && !invalid && <EmptyNote>Search isn&apos;t available right now.</EmptyNote>}
        {res?.kind === "forbidden" && <EmptyNote>You can&apos;t search company knowledge.</EmptyNote>}
        {res?.kind === "ok" && res.data.results.length === 0 && (
          <>
            <EmptyNote>Nothing you can open matches.</EmptyNote>
            <p style={{ margin: "6px 0 0", font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-50)" }}>Results include only records you can open.</p>
          </>
        )}
        {res?.kind === "ok" && res.data.results.length > 0 && (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
            {res.data.results.map((r) => (
              <li key={r.sourceRef}>
                <Link href={r.href} style={{ font: "500 14px/1.4 var(--font-body)" }}>{r.title}</Link>
                <span style={{ marginLeft: 8, font: "400 12px/1.4 var(--font-body)", color: "var(--erp-ink-50)" }}>{FAMILY_LABEL[r.family] ?? r.family}</span>
                <p style={{ margin: "2px 0 0", font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-70)" }}>{r.snippet}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p style={{ margin: "14px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-50)" }}>
        Indexed every 6 hours{indexedAt ? ` (last: ${formatTimestamp(indexedAt)})` : ""}. PDF and Word files are found by name, not by their contents.
      </p>
    </Card>
  );
}

// Knowledge is tenant-scoped — the knowledge/memory platform (D9) keeps
// provenance and quarantine per company. This page renders METADATA ONLY
// (source name, provenance, status) — never document content.
export default async function KnowledgePage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const sp = (await searchParams) ?? {};
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q ?? "").trim();

  const [status, sources, search] = await Promise.all([
    getSystemStatus(userId, "knowledge"),
    tenant ? getKnowledgeSources(userId, tenant) : Promise.resolve([]),
    q.length >= 2 && tenant ? searchKnowledge(userId, tenant, q) : Promise.resolve(null),
  ]);

  const quarantined = sources.filter((s) => s.status === "quarantined");

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Knowledge"
        subtitle="The knowledge/memory platform for this company — source provenance, pre-filter-before-rank retrieval and quarantine review. Metadata only, never document content."
      />

      <SearchPanel q={q} res={search} />

      <div style={{ marginTop: 20 }}>
        <StatusCard status={status} />
      </div>

      <div style={{ marginTop: 20 }}>
        <Card title="Sources">
          {sources.length > 0 ? (
            <HairlineTable
              columns={[{ label: "Source" }, { label: "Provenance" }, { label: "Status" }]}
              rows={sources.map((s) => [
                s.source,
                s.provenance ?? "—",
                <StatusBadge key={`${s.id}-status`} label={s.status} />,
              ])}
            />
          ) : (
            <EmptyNote>Knowledge sources appear once the knowledge admin API is connected.</EmptyNote>
          )}
        </Card>
      </div>

      {/* The scope sits ABOVE the conditional: approving the last quarantined source removes the card. */}
      <OutcomeScope>
      {quarantined.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <Card title="Quarantine">
            <HairlineTable
              columns={[{ label: "Source" }, { label: "Provenance" }, { label: "Review", align: "right" }]}
              rows={quarantined.map((s) => [
                s.source,
                s.provenance ?? "—",
                <ReviewButtons
                  key={s.id}
                  approveAction={reviewSource.bind(null, s.id, "approved")}
                  rejectAction={reviewSource.bind(null, s.id, "rejected")}
                />,
              ])}
            />
          </Card>
        </div>
      )}
      </OutcomeScope>

      <div style={{ marginTop: 20 }}>
        <Card title="Search test console">
          <Field name="query" label="Query" disabled />
          <p style={{ margin: "10px 0 0", font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-50)" }}>
            Search testing arrives once the knowledge admin API is connected.
          </p>
        </Card>
      </div>
    </>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { getMyWorkQueue, projectQueueForCompany } from "@/lib/queue";
import type { QueueItem, QueueItemType } from "@/lib/queueUrgency";
import { resolveGmTab, GmTabRefusal } from "@/components/departments/gm/gmTab";

type Params = Promise<{ deptId: string }>;

const TITLE = "Decisions";

// GM console → Command → Decisions (GM-06).
//
// ── THIS IS A PROJECTION, NOT A SECOND APPROVALS IMPLEMENTATION ──────────────────────────────────
// `/approvals` owns the approval surface, and the console shell's My-work rail already projects the
// SAME `getMyWorkQueue` spine (restricted to approval/gate rows) on every tab of this console —
// including this one. So this page deliberately does NOT fetch approvals itself. It calls the same
// spine and widens the projection: every type, ranked, with the one thing a GM needs that the rail's
// compact strip cannot show — **how long each thing has been waiting**, and a count of what is past
// the point where waiting is itself the problem.
//
// `projectQueueForCompany(queue, companyId, {types})` is a PURE FILTER over `queue.items` by
// construction (its own header says so, and a test asserts rail-equivalence), so calling it twice
// with different options cannot produce two disagreeing answers. That is why widening here is safe
// where a parallel fetch would not be.
//
// ── WHY "ACT" IS A LINK AND NOT A BUTTON ─────────────────────────────────────────────────────────
// `QueueItem.decidable` says whether this principal may act, and each row carries an `origin` +
// `originId` for the decide endpoint. Wiring decide buttons here would put a THIRD write path onto
// the same records (after `/approvals` and the automation console) — three surfaces to keep in step
// on every future change to the decide contract. The GM console's job at this altitude is to say
// what needs deciding and hand off; the decision happens where it already happens. A non-decidable
// row still renders, marked, because "this is waiting and you may not act on it" is information a GM
// wants — it names the person who has to.
//
// ── WHAT IS NOT HERE YET ─────────────────────────────────────────────────────────────────────────
// Two of the design's four sources are absent, and neither is faked:
//   • **Dept-head assignment requests** (BFF contract §11.2's owner end-state). Real endpoints, but
//     no `lib/*` reader today; adding one is its own ticket, not a side-effect of this page.
//   • **Ball-held-too-long.** Deriving it means walking every project's task list to find stale ball
//     holders — an N-project fan-out this tab must not do on every render. It belongs on a computed
//     read, and the per-department `ball` tab already answers it at department grain.
// Stated in the page rather than silently omitted, so the tab does not read as "nothing else is
// waiting on you".

/** Bands, not a single threshold. A queue nobody has touched in a month puts every row past one
 *  cut-off, and "everything is late" marks nothing. Three bands let the eye find the tail. */
const STALE_DAYS = 5;
const CRITICAL_DAYS = 14;

const TYPE_LABEL: Record<QueueItemType, string> = {
  approval: "Approval",
  gate: "Pipeline gate",
  task: "Task",
  mention: "Mention",
};

function ageDays(createdAt: string, todayIso: string): number | null {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return null;
  const now = Date.parse(`${todayIso}T00:00:00Z`);
  // Floor, not round: something raised 30 hours ago has been waiting "1d", never "2d". Same rule
  // the console layout's rail applies, deliberately — two surfaces showing the same row must not
  // disagree about its age by a day.
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

export default async function GmDecisionsPage({ params }: { params: Params }) {
  const { deptId } = await params;
  const ctx = await resolveGmTab(deptId);
  if (!ctx.ok) return <GmTabRefusal reason={ctx.reason} title={TITLE} />;

  // `getMyWorkQueue` needs the `Me` for its per-company `approvals.decide` check, which decides
  // each row's `decidable` flag. Re-resolved here rather than threaded through `resolveGmTab`: the
  // guard's contract is "may this principal see this console", and handing callers a `Me` would
  // invite them to re-derive authorization from it instead of asking the guard.
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);

  const today = new Date().toISOString().slice(0, 10);
  let queueFailed = false;
  let items: QueueItem[] = [];
  let excluded = false;
  let lostSources: string[] = [];
  try {
    const queue = await getMyWorkQueue(me, ctx.userId, [{ id: ctx.tenantId, name: ctx.tenantId }]);
    items = projectQueueForCompany(queue, ctx.tenantId);
    // The envelope reports incompleteness two ways, and BOTH matter here — its own comment says the
    // distinction "matters most on a work queue: an empty one reads as 'you are done', and a short
    // one reads as 'this is all of it'".
    //   `included: false`   → you saw NONE of this company.
    //   `partialSources`    → you saw SOME of it and a named source failed. The quieter, more
    //                         dangerous case, and the one a GM would never notice unaided.
    const leg = queue.companies.find((c) => c.id === ctx.tenantId);
    excluded = leg ? !leg.included : false;
    lostSources = leg?.partialSources ?? [];
  } catch {
    queueFailed = true;
  }

  // Decisions first, then everything else — the tier weights already rank approvals/gates above
  // tasks/mentions, so `rankByUrgency`'s order is kept as-is rather than re-sorted here.
  const decisions = items.filter((i) => i.type === "approval" || i.type === "gate");
  const rest = items.filter((i) => i.type === "task" || i.type === "mention");

  const withAge = decisions.map((i) => ({ item: i, days: ageDays(i.createdAt, today) }));
  const stale = withAge.filter((r) => r.days !== null && r.days >= STALE_DAYS).length;
  const critical = withAge.filter((r) => r.days !== null && r.days >= CRITICAL_DAYS).length;
  const blocked = decisions.filter((i) => !i.decidable).length;

  return (
    <>
      <Card
        title="Waiting on you"
        headerRight={
          <Link href="/approvals" className="lux-btn lux-btn--ghost lux-btn--sm">Approvals</Link>
        }
      >
        {queueFailed ? (
          <EmptyNote>The work queue could not be read just now — a failed read, not an empty queue.</EmptyNote>
        ) : decisions.length === 0 ? (
          <EmptyNote>Nothing is waiting on a decision.</EmptyNote>
        ) : (
          <>
            <div style={KPI_ROW}>
              <KpiTile label="Awaiting a decision" value={String(decisions.length)} foot="approvals and pipeline gates" />
              <KpiTile
                label={`Waiting ${STALE_DAYS}d+`}
                value={String(stale)}
                foot={critical > 0 ? `${critical} past ${CRITICAL_DAYS} days` : "none past two weeks"}
                hint={`Age is measured from when the item was raised. Two bands: ${STALE_DAYS} days is "this has been sitting", ${CRITICAL_DAYS} days is "the wait is now the problem".`}
              />
              <KpiTile
                label="Not yours to decide"
                value={String(blocked)}
                foot={blocked ? "someone else must act" : "you can act on all of them"}
                hint="Still listed on purpose: a GM needs to know a decision is stuck even when the decision is not theirs."
              />
            </div>
            <HairlineTable
              columns={[{ label: "What" }, { label: "Kind" }, { label: "Context" }, { label: "Waiting", align: "right" }, { label: "", align: "right" }]}
              rows={withAge.map(({ item, days }) => [
                item.title,
                TYPE_LABEL[item.type],
                item.meta ?? "—",
                days === null ? "—" : days === 0 ? "today" : `${days}d`,
                item.href ? (
                  <Link key="go" href={item.href} style={LINK}>
                    {item.decidable ? "Decide" : "Open"}
                  </Link>
                ) : (
                  // No href means no deep link exists for this row. Rendering unlinked text is the
                  // house rule — never a dead link that looks clickable.
                  <span key="go" style={{ color: "var(--erp-ink-50)" }}>no link</span>
                ),
              ])}
              tcols="2.2fr 1fr 1.6fr 0.8fr 0.7fr"
            />
          </>
        )}
        {excluded && (
          <p style={NOTE}>
            This queue is empty because the whole company was excluded from the read — not because
            nothing is waiting.
          </p>
        )}
        {lostSources.length > 0 && (
          <p style={NOTE}>
            <strong>This list is incomplete.</strong> These sources failed and are missing from it:{" "}
            {lostSources.join(", ")}.
          </p>
        )}
      </Card>

      <Card title="Your own work" headerRight={
        <Link href="/pm" className="lux-btn lux-btn--ghost lux-btn--sm">Project Management</Link>
      }>
        {queueFailed ? (
          <EmptyNote>Not read.</EmptyNote>
        ) : rest.length === 0 ? (
          <EmptyNote>No open tasks or unread mentions assigned to you.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "What" }, { label: "Kind" }, { label: "Due", align: "right" }, { label: "", align: "right" }]}
            rows={rest.map((i) => [
              i.title,
              TYPE_LABEL[i.type],
              i.dueDate ?? "—",
              i.href ? <Link key="go" href={i.href} style={LINK}>Open</Link> : <span key="go" style={{ color: "var(--erp-ink-50)" }}>no link</span>,
            ])}
            tcols="2.6fr 1fr 0.9fr 0.7fr"
          />
        )}
      </Card>

      <Card title="Not wired yet">
        <EmptyNote>
          Two sources the GM decision queue is meant to carry are not here: dept-head assignment
          requests (endpoints exist, no reader yet) and work whose ball has been held too long (needs
          a computed read rather than a per-project fan-out on every render). The per-department Ball
          tab answers the second at department grain today.
        </EmptyNote>
      </Card>
    </>
  );
}

const KPI_ROW: React.CSSProperties = {
  display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", marginBottom: 16,
};
const LINK: React.CSSProperties = { color: "var(--erp-accent)", textDecoration: "underline", textUnderlineOffset: 2 };
const NOTE: React.CSSProperties = { margin: "10px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" };

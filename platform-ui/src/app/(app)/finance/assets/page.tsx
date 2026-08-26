import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  listAssets, reconcileAssets, listDepreciationRuns, getAssetSchedule, listPeriods, money,
} from "@/lib/finance";
import { Card, KpiTile, HairlineTable, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { RunDepreciationForm } from "@/components/finance/RunDepreciationForm";

// Fixed assets — the register, the schedule, and the depreciation actually charged.
//
// ── BOOK AND TAX ARE BOTH SHOWN, ALWAYS ────────────────────────────────────────────────────────
// These are two different numbers for the same asset and they are SUPPOSED to differ. The book side
// follows PSAK 16 over the asset's useful life; the tax side follows UU PPh Ps. 11 golongan, which
// prescribes its own rates and ignores what the company thinks the life is.
//
// The asymmetry runs deeper than the rates: the BOOK figure is derived from what was actually POSTED
// to the ledger, while the TAX figure comes from the schedule, because tax depreciation is never
// posted at all — it exists to compute a tax return and a deferred-tax position. A single "net book
// value" column would have to silently pick one, and whichever it picked would be wrong for half its
// readers. The difference between them IS the temporary difference that drives deferred tax, so
// collapsing it would hide the input to another whole calculation.
export default async function FinanceAssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string; asset?: string }>;
}) {
  const sp = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const periods = await listPeriods(userId, tenant);
  if (periods == null) return <EmptyNote>You do not have finance access for this company.</EmptyNote>;

  const today = new Date().toISOString().slice(0, 10);
  const current = periods.find((p) => p.startDate <= today && p.endDate >= today);
  const asOf = sp.asOf ?? current?.endDate ?? periods[periods.length - 1]?.endDate ?? today;

  const [assets, rec, runs] = await Promise.all([
    listAssets(userId, tenant, asOf),
    reconcileAssets(userId, tenant),
    listDepreciationRuns(userId, tenant),
  ]);

  // A schedule is only fetched when one is asked for. Fetching all of them would be dozens of
  // round trips for a table most readers never open.
  const selected = sp.asset ? assets.find((a) => a.id === sp.asset) ?? null : null;
  const schedule = selected ? await getAssetSchedule(userId, tenant, selected.id) : [];

  const cost = assets.reduce((t, a) => t + Number(a.cost), 0);
  const bookNbv = assets.reduce((t, a) => t + Number(a.bookNbv ?? 0), 0);
  const taxNbv = assets.reduce((t, a) => t + Number(a.taxNbv ?? 0), 0);
  const chargedPeriodIds = new Set(runs.map((r) => r.periodId));
  const uncharged = periods.filter((p) => p.state === "OPEN" && !chargedPeriodIds.has(p.id));

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Fixed assets</h1>
        <p className="fin-page__asof">Carrying values as at {asOf}</p>
      </header>

      <div className="fin-kpis">
        <KpiTile label="Assets" value={String(assets.length)} foot="in the register" />
        <KpiTile label="Cost" value={money(cost)} foot="original acquisition cost" />
        <KpiTile
          label="Book NBV"
          value={money(bookNbv)}
          foot="from POSTED depreciation"
          hint="Carrying value on the balance sheet. Derived from charges actually posted to the ledger, never from the schedule — so it matches what the accounts say, not what they should say."
        />
        <KpiTile
          label="Tax NBV"
          value={money(taxNbv)}
          foot="from the SCHEDULE — never posted"
          hint="Tax written-down value under UU PPh Ps. 11. This is never posted to the ledger; it exists to compute the return and the deferred-tax position. The gap between this and book NBV is the temporary difference."
        />
      </div>

      <Card title="Register-to-ledger tie-out" style={{ marginTop: 22 }}>
        <div className="fin-verdict">
          {rec == null ? (
            <>
              <StatusBadge label="archived" />
              <span className="fin-verdict__note">
                The tie-out could not be read, so whether the register agrees with the balance sheet
                is unknown. That is not a pass.
              </span>
            </>
          ) : rec.clean ? (
            <>
              <StatusBadge label="active" />
              <span className="fin-verdict__note">
                Register cost ties to the fixed-asset control account, and posted depreciation ties to
                accumulated depreciation.
              </span>
            </>
          ) : (
            <>
              <StatusBadge label="blocked" />
              <span className="fin-verdict__note">
                {rec.problems.length} difference(s) between the register and the ledger.
              </span>
            </>
          )}
        </div>
        {rec && !rec.clean ? (
          <HairlineTable
            columns={[{ label: "Problem" }, { label: "Detail" }]}
            rows={rec.problems.map((p) => [p.problem, p.detail])}
          />
        ) : null}
      </Card>

      <Card
        title="The register"
        hint="Book and tax carrying values are both shown because they are supposed to differ — different rules, and only the book side is ever posted."
        style={{ marginTop: 22 }}
      >
        {assets.length === 0 ? (
          <EmptyNote>
            No assets are capitalised for this company. An asset enters this register through the
            fixed-asset subledger, never by a manual journal to the control account — that bar is what
            lets this table be trusted to tie to the balance sheet.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Code" }, { label: "Asset" }, { label: "Class" },
              { label: "In service" }, { label: "Cost", align: "right" },
              { label: "Book NBV", align: "right" }, { label: "Tax NBV", align: "right" },
              { label: "" },
            ]}
            rows={assets.map((a) => [
              a.code,
              a.status === "active" ? a.name : `${a.name} (${a.status})`,
              `${a.classCode} · ${a.taxGolongan ?? "—"}`,
              a.inServiceDate ?? "not in service",
              money(a.cost),
              a.bookNbv == null ? "—" : money(a.bookNbv),
              a.taxNbv == null ? "—" : money(a.taxNbv),
              <a key={a.id} href={`/finance/assets?asset=${a.id}`}>schedule</a>,
            ])}
          />
        )}
      </Card>

      {selected ? (
        <Card
          title={`Schedule — ${selected.code} · ${selected.name}`}
          hint="Derived, never stored. A change to the asset's life or method changes every remaining row."
          style={{ marginTop: 22 }}
        >
          {schedule.length === 0 ? (
            <EmptyNote>
              No schedule. An asset with no in-service date has not started depreciating — which is a
              state, not an error.
            </EmptyNote>
          ) : (
            <HairlineTable
              columns={[
                { label: "#" }, { label: "Period" },
                { label: "Book charge", align: "right" }, { label: "Book NBV", align: "right" },
                { label: "Tax charge", align: "right" }, { label: "Tax NBV", align: "right" },
              ]}
              rows={schedule.map((r) => [
                String(r.seq), r.periodStart,
                money(r.bookCharge), money(r.bookNbv),
                money(r.taxCharge), money(r.taxNbv),
              ])}
            />
          )}
        </Card>
      ) : null}

      <Card
        title="Depreciation charged"
        hint="What has actually been posted. A period missing here has not been charged — depreciation does not accrue by itself."
        style={{ marginTop: 22 }}
      >
        {runs.length === 0 ? (
          <EmptyNote>
            No depreciation has been charged for this company. That is a real state, not a loading
            failure: until a period is run, the book NBV above equals cost.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Period" }, { label: "Assets", align: "right" },
              { label: "Book charge", align: "right" }, { label: "Tax charge", align: "right" },
              { label: "Journal" },
            ]}
            rows={runs.map((r) => [
              r.periodName,
              String(r.assetCount),
              money(r.bookTotal),
              // The tax total is recorded and NOT posted — shown so the two are visibly different
              // quantities rather than one figure the reader assumes hit the ledger.
              `${money(r.taxTotal)} (not posted)`,
              r.journalId ? <a key={r.id} href={`/finance/journals/${r.journalId}`}>view entry</a> : "—",
            ])}
          />
        )}

        <RunDepreciationForm periods={uncharged.map((p) => ({ id: p.id, name: p.name }))} />
      </Card>
    </div>
  );
}

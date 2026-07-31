"use client";
// SM-47 — the campaign detail page's ad-group list: create/select/delete. Selecting a row sets
// `?adGroupId=` so the page below can render that group's ads (same querystring-selection pattern
// KeywordWorkbench/the keywords tab uses for a keyword set). No provenance is rendered here on
// purpose — `GET campaigns/:id/ad-groups` does not return it (see `PlannedAdGroupResult`'s header
// note in searchMarketingShared.ts); provenance is only ever shown once, at plan-generation time.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HairlineTable, Button } from "@/components/ui";
import { createAdGroup, deleteAdGroup } from "@/lib/searchMarketingActions";
import type { SearchAdGroup } from "@/lib/searchMarketingShared";

export function AdGroupsPanel({
  tenantId, deptId, campaignId, adGroups, selectedAdGroupId, canManage,
}: {
  tenantId: string;
  deptId: string;
  campaignId: string;
  adGroups: SearchAdGroup[];
  selectedAdGroupId?: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function create() {
    setError(null);
    if (!name.trim()) {
      setError("Name the ad group first.");
      return;
    }
    startTransition(async () => {
      const res = await createAdGroup(tenantId, campaignId, name.trim());
      if (!res.ok || !res.id) {
        setError(res.error ?? "Couldn't create the ad group.");
        return;
      }
      setName("");
      router.push(`/departments/${deptId}/planner/${campaignId}?adGroupId=${res.id}`);
      router.refresh();
    });
  }

  function remove(adGroupId: string) {
    setError(null);
    setPendingId(adGroupId);
    startTransition(async () => {
      const res = await deleteAdGroup(tenantId, campaignId, adGroupId);
      setPendingId(null);
      if (!res.ok) {
        setError(res.error ?? "Couldn't delete this ad group.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      {error && (
        <p role="alert" style={{ font: "400 12px var(--font-body)", color: "var(--erp-danger, var(--status-critical-fg))", marginBottom: 8 }}>
          {error}
        </p>
      )}
      {adGroups.length === 0 ? (
        <p style={{ font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
          No ad groups yet. Generate a plan from the Planner list, or add one manually below.
        </p>
      ) : (
        <HairlineTable
          columns={[{ label: "Ad group" }, { label: "Cluster" }, { label: "" }]}
          rows={adGroups.map((g) => [
            <a
              key="n"
              href={`/departments/${deptId}/planner/${campaignId}?adGroupId=${g.id}`}
              style={{ font: "600 13px var(--font-body)", color: g.id === selectedAdGroupId ? "var(--erp-accent)" : "var(--text-primary)" }}
            >
              {g.name}
            </a>,
            g.clusterId ? g.clusterId.slice(0, 8) : "—",
            canManage ? (
              <Button key="d" variant="ghost" size="sm" disabled={pendingId === g.id} onClick={() => remove(g.id)}>
                Delete
              </Button>
            ) : (
              <span key="d" />
            ),
          ])}
          tcols="2fr 1fr .8fr"
        />
      )}

      {canManage && (
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginTop: 12, paddingTop: 12, borderTop: adGroups.length > 0 ? "0.5px solid var(--erp-hairline)" : undefined }}>
          <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
            New ad group name
            <input
              value={name} onChange={(e) => setName(e.target.value)} disabled={pending}
              placeholder="Brand — exact match"
              style={{ display: "block", marginTop: 6, width: 220, font: "400 13px var(--font-body)", padding: "5px 8px" }}
            />
          </label>
          <Button variant="solid" size="sm" onClick={create} disabled={pending}>
            {pending ? "Adding…" : "Add ad group"}
          </Button>
        </div>
      )}
    </div>
  );
}

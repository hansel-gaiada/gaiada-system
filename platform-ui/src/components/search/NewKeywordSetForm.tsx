"use client";
// SM-12 — the inline "+ new keyword set" affordance on the Keywords tab. A keyword set is the
// container `import`/`embed`/`cluster` all key off (`keyword-sets/:id/...`), so an engagement with
// no sets yet needs a way to create the first one before the workbench has anything to show. Kept
// deliberately tiny (name + source only) — this is not a full keyword-set management surface.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { createKeywordSet } from "@/lib/searchMarketingActions";

const SOURCES = ["client", "gsc", "research", "ai"] as const;

export function NewKeywordSetForm({
  tenantId, engagementId, deptId,
}: {
  tenantId: string;
  engagementId: string;
  deptId: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [source, setSource] = useState<(typeof SOURCES)[number]>("client");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    if (!name.trim()) {
      setError("Name the set first (e.g. \"Core service pages\").");
      return;
    }
    startTransition(async () => {
      const res = await createKeywordSet(tenantId, engagementId, name.trim(), source);
      if (!res.ok || !res.id) {
        setError(res.error ?? "Couldn't create the keyword set.");
        return;
      }
      setName("");
      router.push(`/departments/${deptId}/keywords?engagementId=${engagementId}&setId=${res.id}`);
      router.refresh();
    });
  }

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
      <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
        New set name
        <input
          value={name} onChange={(e) => setName(e.target.value)} disabled={pending}
          placeholder="Core service pages"
          style={{ display: "block", marginTop: 6, width: 220, font: "400 13px var(--font-body)", padding: "5px 8px" }}
        />
      </label>
      <label style={{ font: "600 11px var(--font-body)", letterSpacing: "0.04em", color: "var(--erp-ink-60)" }}>
        Source
        <select
          value={source} disabled={pending}
          onChange={(e) => setSource(e.target.value as (typeof SOURCES)[number])}
          style={{ display: "block", marginTop: 6, font: "400 13px var(--font-body)", padding: "5px 8px" }}
        >
          {SOURCES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </label>
      <Button variant="solid" size="sm" onClick={submit} disabled={pending}>
        {pending ? "Creating…" : "Create set"}
      </Button>
      {error && <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-danger, var(--status-critical-fg))" }}>{error}</span>}
    </div>
  );
}

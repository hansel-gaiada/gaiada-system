"use client";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { HrScopeCompany, HrEnvelopeCompany } from "@/lib/hr";
import "@/components/forms/forms.css";
import "@/components/systems/systems.css";

// The HR-staff company selector (WSD-5 / UX-2 §4, built directly against
// Me.serviceScopes — the generic ScopePill primitive, ORG-13, isn't built yet).
// Single reachable company -> a static label (matches the existing
// canSwitchCompany / ScopePill §4.3 convention); more than one -> a dropdown
// over `?company=all|<id>`, preserving every other search param.
export function HrCompanyScope({ companies, value }: { companies: HrScopeCompany[]; value: "all" | string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  if (companies.length === 0) return null;
  if (companies.length === 1) {
    return <span className="lux-badge" style={{ fontSize: 12 }}>{companies[0].name}</span>;
  }

  function go(v: string) {
    const params = new URLSearchParams(sp.toString());
    params.set("company", v);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ font: "700 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>
        Scope
      </span>
      <select
        value={value}
        onChange={(e) => go(e.target.value)}
        className="lux-field__control"
        style={{ width: "auto", minWidth: 220 }}
        aria-label="Company scope"
      >
        {/* Not "served" — the set also holds companies reachable only via elevation, where HR may
            be switched off entirely. Claiming they were served contradicted the envelope banner
            right below, which reports those same companies as "not served". */}
        <option value="all">All companies in scope ({companies.length})</option>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}{c.role === "home" ? "" : c.role === "elevated" ? " · via elevated access" : ` · ${c.role}`}
          </option>
        ))}
      </select>
    </label>
  );
}

// `not_served` is the fan-out's reading of a 404, which the backend returns BOTH when hr isn't
// served to that company and when the hr module is switched off there. Saying only "not served"
// sent operators hunting for a service assignment when the real answer was a disabled module.
const REASON_LABEL: Record<string, string> = {
  no_access: "no access", not_served: "HR not enabled or not served", suspended: "suspended", error: "unavailable",
};

// Renders nothing when every company is included — never a fixed-height banner
// eating space on the common case (UX-2 §4.3 "All included -> No banner").
export function HrEnvelopeBanner({ companies }: { companies: HrEnvelopeCompany[] }) {
  const excluded = companies.filter((c) => !c.included);
  if (excluded.length === 0) return null;
  const included = companies.length - excluded.length;
  return (
    <p className="sys-empty-note" role="status" style={{ marginBottom: 16 }}>
      Showing {included} of {companies.length} companies scope — {excluded.length} you can&apos;t view (
      {excluded.map((c) => `${c.name}: ${REASON_LABEL[c.reason ?? "error"]}`).join(", ")}).
    </p>
  );
}

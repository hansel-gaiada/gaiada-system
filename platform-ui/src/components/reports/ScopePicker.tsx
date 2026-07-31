"use client";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

// A plain `?scopeRef=` selector for the project/department grain pages (§6.2's `overview` endpoint
// supplies the candidate list — "console landing" scopes + headline KPIs). Preserves every other
// search param (notably `periodKind`/`start`/`end`) exactly like `HrCompanyScope`'s company switcher,
// so switching scope never resets the period a reader had selected.
export function ScopePicker({ options, value, label }: {
  options: { scopeRef: string; scopeName: string }[];
  value: string | undefined;
  label: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  if (options.length === 0) return null;

  function go(v: string) {
    const params = new URLSearchParams(sp.toString());
    params.set("scopeRef", v);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ font: "700 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>
        {label}
      </span>
      <select value={value ?? ""} onChange={(e) => go(e.target.value)} className="lux-field__control" style={{ width: "auto", minWidth: 220 }} aria-label={label}>
        <option value="" disabled>Choose one…</option>
        {options.map((o) => (
          <option key={o.scopeRef} value={o.scopeRef}>{o.scopeName}</option>
        ))}
      </select>
    </label>
  );
}

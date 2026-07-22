// The ONE inclusion-envelope shape every cross-company / cross-served-company
// fan-out returns, per UX-2 §4.2 and FRONTEND-BFF-CONTRACT.md §9(d). A backend
// list that spans more than one company MUST wrap its rows in this shape
// instead of returning a bare array — excluded companies are counted with a
// reason, never silently dropped (owner decision 4).
//
// This is the generic/shared primitive (ORG-13). `lib/hr.ts` predates it with
// its own local `HrEnvelope`/`HrEnvelopeCompany` (built before ORG-13 shipped,
// per its own comment) — structurally identical, kept as-is to avoid an
// unrelated churn; a future pass can rebase it onto this file as a pure rename.
export interface EnvelopeCompany {
  id: string;
  name: string;
  included: boolean;
  reason?: "no_access" | "not_served" | "suspended" | "error";
}

export interface Envelope<T> {
  items: T[];
  companies: EnvelopeCompany[];
}

export const REASON_LABEL: Record<string, string> = {
  no_access: "no access",
  not_served: "not served",
  suspended: "suspended",
  error: "unavailable",
};

// True when every company in the envelope is included — the banner renders
// nothing in this case (UX-2 §4.3 "All included -> No banner").
export function isFullyIncluded(companies: EnvelopeCompany[]): boolean {
  return companies.every((c) => c.included);
}

// Coerces whatever a backend returns into a well-formed Envelope<T>:
// - the canonical `{items, companies}` shape passes through, with a missing
//   `reason` on an excluded company defaulted to "no_access" per contract §9(d)
//   (the UI must never invent a reason the backend didn't send, but it also
//   must never render an excluded row with no reason at all);
// - a bare array (an older/partial endpoint that hasn't adopted the wrapper
//   yet) is treated as fully-included with no company breakdown — better to
//   show the rows than to throw a shape away that's merely ungraduated;
// - anything else falls back to `fallback` so a caller degrades instead of
//   crashing on the first render.
export function normalizeEnvelope<T>(raw: unknown, fallback: Envelope<T> = { items: [], companies: [] }): Envelope<T> {
  if (raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)) {
    const r = raw as { items: T[]; companies?: EnvelopeCompany[] };
    const companies = Array.isArray(r.companies) ? r.companies : [];
    return {
      items: r.items,
      companies: companies.map((c) => ({ ...c, reason: c.included ? undefined : (c.reason ?? "no_access") })),
    };
  }
  if (Array.isArray(raw)) return { items: raw as T[], companies: [] };
  return fallback;
}

// Merges N single-company legs (each already tagged included/excluded) into
// one envelope — the shape every client-side fan-out (a per-company loop that
// can't move server-side yet) should converge on instead of ad hoc arrays.
export function mergeLegs<T>(
  legs: { company: { id: string; name: string }; ok: boolean; rows: T[]; reason?: EnvelopeCompany["reason"] }[],
): Envelope<T> {
  return {
    items: legs.flatMap((l) => l.rows),
    companies: legs.map((l) => ({
      id: l.company.id,
      name: l.company.name,
      included: l.ok,
      reason: l.ok ? undefined : (l.reason ?? "error"),
    })),
  };
}

// WSUX-6 — the client-safe half of lib/approvals.ts: pure types/constants/
// formatters with no "server-only" import, so client components (ApprovalRow,
// ApprovalsList, OriginFilterBar) can use them without pulling the server-only
// `listApprovals` fetcher into the browser bundle. `lib/approvals.ts`
// re-exports all of this for server-component callers (the page) so there's
// still one import path from the server side.
export type ApprovalOrigin = "agency" | "pipeline" | "hr" | "automation" | "agent";
export type ApprovalStatus = "pending" | "decided";
export type ApprovalSort = "urgency" | "age";

export const ORIGINS: ApprovalOrigin[] = ["agency", "pipeline", "hr", "automation", "agent"];
export const ORIGIN_LABEL: Record<ApprovalOrigin, string> = {
  agency: "Agency",
  pipeline: "Pipeline",
  hr: "HR",
  automation: "Automation",
  agent: "Agent",
};

// Matches the backend's UnifiedApprovalItem (approvals.controller.ts) exactly —
// kept as a local mirror rather than a shared package per this repo's
// "separate standalone projects" convention.
export interface UnifiedApprovalItem {
  id: string;
  origin: ApprovalOrigin;
  tenantId: string;
  company: string;
  subject: string;
  subjectHref?: string;
  previewUrl?: string;
  createdAt: string;
  ageMs: number;
  urgencyScore: number;
  decidable: boolean;
  status: string;
}

// D14-08 — the second, honest axis. `status` (above, on UnifiedApprovalItem) is the DECISION;
// this is what actually happened to the write once approved. Mirrors `automation_approvals.
// execution_status` (0078) exactly. Only automation/agent/hr-origin items ever carry one — agency
// and pipeline approvals have no execution step, so those origins are never looked up here.
export type ExecutionStatus = "not_applicable" | "pending" | "executing" | "executed" | "failed";
export interface ExecutionInfo {
  status: ExecutionStatus;
  error: string | null;
  attempts: number | null;
}

export function originCounts(items: Pick<UnifiedApprovalItem, "origin">[]): Record<ApprovalOrigin, number> {
  const counts = { agency: 0, pipeline: 0, hr: 0, automation: 0, agent: 0 } as Record<ApprovalOrigin, number>;
  for (const item of items) counts[item.origin] += 1;
  return counts;
}

export function isApprovalOrigin(v: string | undefined): v is ApprovalOrigin {
  return !!v && (ORIGINS as string[]).includes(v);
}

// Elapsed-time label for the row's age chip ("⏱ 2d" / "⏱ 6h" / "⏱ new") — UX-2
// §2.2 mockup. Approvals have no due date (only age), so this replaces the
// queue's NOW/TODAY/SOON due-date bands with a plain elapsed-time read.
export function formatAge(ageMs: number): string {
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 1) return "new";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

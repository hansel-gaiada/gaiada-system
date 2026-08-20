import "server-only";
// MON-09i — reader for the Plane A (our infrastructure) admin console.
//
// Plane A vs Plane B, because the distinction is the whole design and easy to lose:
//   * THIS file  = our own box. Staff/platform-admin only. Never tenant-scoped, never sellable.
//   * lib/monitoring.ts = the CLIENT's websites and services. Tenant-scoped, Cerbos-gated, product.
// They must never be merged into one surface (docs/blueprints/monitoring-program.md §8.1); Gaia
// Nexus merged them and that is the root cause of its fabricated dashboard.
//
// BFF CONTRACT: GET /api/admin/observability -> ObservabilitySnapshot (403 unless platform admin).
// Shapes mirror platform-nest/src/admin/observability.controller.ts.
import { platformFetch, PlatformError } from "./platform";

/** `value: null` means "asked, got nothing" — never zero, and never rendered as healthy. */
export interface Reading {
  value: number | null;
  note?: string | null;
}

export interface HostHealth {
  cpuBusyPct: Reading;
  memUsedPct: Reading;
  diskUsedPct: Reading;
  diskFreeGb: Reading;
  diskFreeGb24h: Reading;
  load1: Reading;
  uptimeDays: Reading;
}

export interface TargetSummary {
  up: number;
  down: number;
  downJobs: string[];
}

export interface DatastoreHealth {
  postgres: { instance: string; up: boolean }[];
  redis: { instance: string; up: boolean }[];
}

export interface FiringAlert {
  name: string;
  severity: string;
}

export interface ObservabilitySnapshot {
  available: boolean;
  reason?: string | null;
  grafanaHint: string;
  host: HostHealth | null;
  targets: TargetSummary | null;
  datastores: DatastoreHealth | null;
  alerts: FiringAlert[] | null;
  collectedAt: string;
}

/**
 * Returns null ONLY when the caller may not see this (403) or the endpoint is absent (404/405).
 * A 500 propagates: this page must be allowed to look broken. Note it does NOT synthesise an
 * `available:false` snapshot on 403 — "you cannot see it" and "the box is unmonitored" are
 * different facts and the page words them differently.
 */
export async function getObservability(userId: string): Promise<ObservabilitySnapshot | null> {
  try {
    return await platformFetch<ObservabilitySnapshot>("/api/admin/observability", userId);
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 403 || e.status === 404 || e.status === 405)) {
      return null;
    }
    throw e;
  }
}

// --- Pure presentation helpers (unit-testable, no I/O) -------------------------------------------

/** One decimal, or an em dash. Never prints "0" for missing data. */
export function fmt(r: Reading | undefined, suffix = ""): string {
  if (!r || r.value === null) return "—";
  return `${r.value.toFixed(1)}${suffix}`;
}

/**
 * Utilisation tier for a percentage. Thresholds match `DiskSpaceLow` (fires below 15% free, i.e.
 * above 85% used) so the console and the pager agree — a console that stays green while an alert
 * fires teaches people to distrust the console.
 */
export function utilLevel(pct: number | null): "ok" | "warn" | "critical" | "unknown" {
  if (pct === null) return "unknown";
  if (pct >= 85) return "critical";
  if (pct >= 70) return "warn";
  return "ok";
}

/** Maps a tier onto the shared STATUS_FAMILY vocabulary in components/ui.tsx. */
export function levelLabel(level: "ok" | "warn" | "critical" | "unknown"): string {
  switch (level) {
    case "ok": return "active";
    case "warn": return "at risk";
    case "critical": return "critical";
    default: return "draft"; // renders as the idle/unknown family, never as a pass
  }
}

/**
 * The projection is only worth showing when it says something actionable. Free space that is
 * stable or growing produces a large positive number that reads as noise beside the current value.
 */
export function diskProjectionNote(current: Reading, projected: Reading): string | null {
  if (current.value === null || projected.value === null) return null;
  if (projected.value < 0) return "projected to fill within 24h";
  const delta = current.value - projected.value;
  if (delta <= 0.2) return null; // flat or recovering
  return `trending down ~${delta.toFixed(1)} GB/day`;
}

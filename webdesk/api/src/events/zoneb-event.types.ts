// WSK-12 — the B->A event envelope shape. Mirrors platform-nest's `webdev_zoneb_event_log`
// CHECK-enumerated `kind` vocabulary EXACTLY (202608261440_webdev_zoneb_event_log.sql) — the two
// lists must be kept in sync by hand across the zone boundary (no shared package crosses it, by
// design: §01 "separate projects, not a monorepo package").
export type ZoneBEventKind =
  | "form.received"
  | "deploy.done"
  | "promote.done"
  | "rollback.done"
  | "contract.published"
  | "alert.raised";

/** The wire envelope. `data` is a SLIM PROJECTION per kind (§04: "never the raw blob") — for
 *  `form.received`, no submitted field VALUES ever appear here, only correlators. */
export type ZoneBEventEnvelope<TData extends Record<string, unknown> = Record<string, unknown>> = {
  eventId: string;
  kind: ZoneBEventKind;
  tenantId: string; // Zone A companies.id (Zone B's own `tenants.company_ref`, per 0001's comment)
  originSite: string;
  occurredAt: string; // ISO 8601
  data: TData;
};

/** The `form.received` slim projection — correlators only, never a submitted field value. Matches
 *  the containment statement in §03's channel-1 row: "May cause, at most: Notification rows,
 *  webdev_zoneb_event_log rows ... May never cause: any privileged transition." Nothing here can
 *  be replayed into a write anywhere — it is purely descriptive. */
export type FormReceivedData = {
  siteSlug: string;
  formId: string;
  submissionId: string;
  hasAttachments: boolean;
};

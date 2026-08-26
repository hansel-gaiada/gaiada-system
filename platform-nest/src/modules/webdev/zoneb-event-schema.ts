// WSK-12 — Zone A's own schema-check on a Zone B fact, run AFTER the n8n flow's own HMAC-verify +
// schema-check (§10) and BEFORE the idempotent insert. Defense in depth, not redundant paranoia:
// the n8n Code node's schema-check is hand-transliterated JS with no compiler behind it (see
// `webdesk/api/src/events/zoneb-event-signature.ts`'s header for the same duplication-across-the-
// zone-boundary reasoning) — this is the one place a malformed-but-signed envelope is refused with
// a compiler-checked, unit-tested validator before it can occupy an idempotency slot.
//
// Mirrors `webdesk/api/src/events/zoneb-event.types.ts`'s `ZoneBEventKind`/`FormReceivedData`
// EXACTLY — the two lists are kept in sync by hand across the zone boundary, same as the migration
// header (202608261440_webdev_zoneb_event_log.sql) already documents for the DB CHECK constraint.
const ZONEB_EVENT_KINDS = [
  "form.received", "deploy.done", "promote.done", "rollback.done",
  "contract.published", "alert.raised",
] as const;
export type ZoneBEventKind = (typeof ZONEB_EVENT_KINDS)[number];

export type ZoneBEventInput = {
  eventId: string;
  kind: ZoneBEventKind;
  tenantId: string;
  originSite: string;
  occurredAt: string;
  data: Record<string, unknown>;
};

export type SchemaCheck = { ok: true; value: ZoneBEventInput } | { ok: false; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** `form.received`'s slim-projection shape (§04: "never the raw blob") — correlators only. */
function validateFormReceivedData(data: Record<string, unknown>): string | null {
  if (!isNonEmptyString(data.siteSlug)) return "data.siteSlug is required";
  if (!isNonEmptyString(data.formId)) return "data.formId is required";
  if (!isNonEmptyString(data.submissionId)) return "data.submissionId is required";
  if (typeof data.hasAttachments !== "boolean") return "data.hasAttachments must be a boolean";
  return null;
}

/**
 * Validates an envelope already believed to have come from a genuinely-verified Zone B webhook
 * (the n8n flow's HMAC step ran first — this function does not re-verify signatures, it validates
 * SHAPE). `routeTenantId` is the `:tenantId` the HTTP route was called with; a body `tenantId` that
 * disagrees is refused rather than silently trusted or silently overridden — an envelope claiming
 * to be about a DIFFERENT tenant than the one the caller is authorized against is exactly the kind
 * of mismatch §03's containment statement exists to catch, not paper over.
 */
export function validateZoneBEvent(routeTenantId: string, body: unknown): SchemaCheck {
  if (!isPlainObject(body)) return { ok: false, reason: "body must be a JSON object" };

  if (!isNonEmptyString(body.eventId)) return { ok: false, reason: "eventId is required" };
  if (typeof body.kind !== "string" || !(ZONEB_EVENT_KINDS as readonly string[]).includes(body.kind)) {
    return { ok: false, reason: `kind must be one of: ${ZONEB_EVENT_KINDS.join(", ")}` };
  }
  if (!isNonEmptyString(body.tenantId)) return { ok: false, reason: "tenantId is required" };
  if (body.tenantId !== routeTenantId) {
    return { ok: false, reason: "body tenantId does not match the route tenant" };
  }
  if (!isNonEmptyString(body.originSite)) return { ok: false, reason: "originSite is required" };
  if (!isNonEmptyString(body.occurredAt) || Number.isNaN(Date.parse(body.occurredAt))) {
    return { ok: false, reason: "occurredAt must be a parseable ISO timestamp" };
  }
  if (!isPlainObject(body.data)) return { ok: false, reason: "data must be a JSON object" };

  const kind = body.kind as ZoneBEventKind;
  if (kind === "form.received") {
    const dataError = validateFormReceivedData(body.data);
    if (dataError) return { ok: false, reason: dataError };
  }
  // Other kinds (deploy.done | promote.done | rollback.done | contract.published | alert.raised)
  // are P3+/P5 work this ticket does not build the emitter side of yet (§12: WSK-12's own AC names
  // only `form.received` as buildable now, WSK-10 being the only DEV-VERIFIED emitter). Their
  // `data` is accepted as an opaque, schema-checked-as-an-object payload here; a per-kind shape
  // validator is added alongside whichever ticket builds that emitter, not invented ahead of it.

  return {
    ok: true,
    value: {
      eventId: body.eventId,
      kind,
      tenantId: body.tenantId,
      originSite: body.originSite,
      occurredAt: body.occurredAt,
      data: body.data,
    },
  };
}

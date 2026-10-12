// M5-V3-a -- consent.status: the control-plane read that makes WebDesk's consent log (migration 0017, M5-G6) the
// EVIDENCE for the ERP's visitor profiles (design docs/plans/2026-10-12-m5-phase5-design.md 4.3, D5). A browser's
// claim that it consented can be forged; the log cannot. For up to 100 consent ids it returns each id's LATEST
// record, and nothing for an id with no record: absence is "no proof", never an error.
//
// TENANCY. The route's tenant slug is resolved first (platform context; unknown or archived = 404). The read then
// runs under THAT tenant's `webdesk.tenant_ctx` (db.withTenant: an unset context reads ZERO rows silently, so the
// context is entered explicitly) AND filters tenant_id in the query (the second wall). Another tenant's consent id
// matches zero rows and is simply OMITTED, exactly like an id that never existed, so the answer confirms nothing.
//
// LATEST WINS. `ORDER BY recorded_at DESC, id DESC` per consent id. Consumers must key on `analytics`, never on
// `action`: the site records an analytics-only withdrawal as action "update" with analytics false.
//
// NOT RETURNED: user_agent_class (and there is no IP or raw UA in the table). Like every control read it takes no
// editorial assertion and writes no audit row.
import { Injectable } from "@nestjs/common";
import { DbService } from "../../db/db.service";
import { problems } from "../content/content-problem";
import { parseConsentStatusBody } from "./consent-status-body";

export interface ConsentStatus {
  consentId: string;
  analytics: boolean;
  marketing: boolean;
  action: "grant" | "update" | "withdraw";
  noticeVersion: string;
  recordedAt: string;
}

type Row = {
  consent_id: string;
  analytics: boolean;
  marketing: boolean;
  action: "grant" | "update" | "withdraw";
  notice_version: string;
  recorded_at: Date | string;
};

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

@Injectable()
export class ConsentStatusService {
  constructor(private readonly db: DbService) {}

  async status(tenantSlug: string, rawBody: unknown): Promise<{ statuses: ConsentStatus[] }> {
    const tenant = await this.db.withPlatformCtx(async (client) => {
      const { rows } = await client.query<{ id: string; slug: string; status: string }>(
        `SELECT id, slug, status FROM tenants WHERE slug = $1`,
        [tenantSlug],
      );
      return rows[0] ?? null;
    });
    if (!tenant || tenant.status !== "active") throw problems.siteNotFound();

    const req = parseConsentStatusBody(rawBody);
    // The Zone B "siteSlug" IS the tenant slug (a site row has no slug); a different one names no site of this tenant.
    if (req.siteSlug !== null && req.siteSlug !== tenant.slug) throw problems.siteNotFound();

    const rows = await this.db.withTenant(tenant.id, async (db) => {
      const res = await db.query<Row>(
        `SELECT DISTINCT ON (consent_id) consent_id, analytics, marketing, action, notice_version, recorded_at
           FROM consent_records
          WHERE tenant_id = $1 AND consent_id = ANY($2::uuid[])
          ORDER BY consent_id, recorded_at DESC, id DESC`,
        [tenant.id, req.consentIds],
      );
      return res.rows;
    });

    return {
      statuses: rows.map((r) => ({
        consentId: r.consent_id,
        analytics: r.analytics,
        marketing: r.marketing,
        action: r.action,
        noticeVersion: r.notice_version,
        recordedAt: iso(r.recorded_at),
      })),
    };
  }
}

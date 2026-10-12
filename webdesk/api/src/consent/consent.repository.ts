// M5-G6 — raw SQL for consent_records (migration 0017). Every method runs under an ALREADY-ACTIVE tenant context
// (the guard entered it) and still filters tenant_id explicitly (WSK-D16: a GUC gap must degrade to a wrong
// app-layer filter, never a silent cross-tenant read). The table is append-only for the app role: nothing here
// UPDATEs, and DELETE is used only by the retention purge (consent-purge.service.ts) and privacy.erase
// (privacy/privacy.repository.ts).
import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";
import type { ConsentAction, UserAgentClass } from "./consent-body";

export type ConsentInsert = {
  consentId: string;
  tenantId: string;
  siteId: string;
  analytics: boolean;
  marketing: boolean;
  noticeVersion: string;
  action: ConsentAction;
  userAgentClass: UserAgentClass;
};

@Injectable()
export class ConsentRepository {
  constructor(private readonly db: DbService) {}

  /**
   * The site an Origin belongs to: the tenant's environment whose public domain equals the origin's host, over
   * either scheme (the same allowlist source and matching as the forms route: environments.domain carries no
   * scheme). Production wins when two sites share a domain. Null when no environment matches (=> 403).
   */
  async siteIdForOrigin(tenantId: string, origin: string): Promise<string | null> {
    const m = /^https?:\/\/([^/?#]+)\/*$/i.exec(origin.trim());
    if (!m) return null;
    const host = m[1].toLowerCase();
    // Explicit tenant context (the forms submit path does the same with db.withTenant): the guard's
    // enterTenantContext does not reliably survive into the handler, and RLS is FORCEd.
    const { rows } = await this.db.withTenant(tenantId, (db) =>
      db.query<{ site_id: string }>(
        `SELECT site_id FROM environments
          WHERE tenant_id = $1 AND domain IS NOT NULL AND lower(btrim(domain, ' /')) = $2
          ORDER BY (name = 'production') DESC, site_id
          LIMIT 1`,
        [tenantId, host],
      ),
    );
    return rows[0]?.site_id ?? null;
  }

  async insert(r: ConsentInsert): Promise<void> {
    await this.db.withTenant(r.tenantId, (db) =>
      db.query(
      `INSERT INTO consent_records (consent_id, tenant_id, site_id, analytics, marketing, notice_version, action, user_agent_class)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [r.consentId, r.tenantId, r.siteId, r.analytics, r.marketing, r.noticeVersion, r.action, r.userAgentClass],
      ),
    );
  }
}

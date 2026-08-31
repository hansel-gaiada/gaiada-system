// WSK-11 — per-tenant template lookup, rendered under RLS. `mail_templates` carries FORCE RLS +
// a `tenant_isolation` policy keyed on `webdesk_tenant_ctx()` (0004_mail.sql) — the ACTUAL
// enforcement that stops tenant B ever seeing tenant A's template. This service's own
// `site_id = $1` predicate is the app-layer half of the WSK-D16 doctrine ("a GUC gap must
// degrade to a wrong app-layer filter, never a silent cross-tenant read"), not a substitute for
// the policy — every call here MUST run inside an already-active tenant context
// (db.withTenant(...) in mail.service.ts / mail-sender.processor.ts), same rule as every other
// service in this codebase that touches DbService.query() directly.
import { Injectable, NotFoundException } from "@nestjs/common";
import { DbService } from "../db/db.service";

export type MailTemplateRow = {
  id: string;
  key: string;
  subject: string;
  body_html: string;
  body_text: string | null;
};

@Injectable()
export class MailTemplatesService {
  constructor(private readonly db: DbService) {}

  async findBySiteAndKey(siteId: string, key: string): Promise<MailTemplateRow | null> {
    const { rows } = await this.db.query<MailTemplateRow>(
      `SELECT id, key, subject, body_html, body_text FROM mail_templates WHERE site_id = $1 AND key = $2`,
      [siteId, key],
    );
    return rows[0] ?? null;
  }

  async requireBySiteAndKey(siteId: string, key: string): Promise<MailTemplateRow> {
    const row = await this.findBySiteAndKey(siteId, key);
    if (!row) throw new NotFoundException(`mail template "${key}" not found for this site`);
    return row;
  }
}

// M5-L1d — forms.define (the write), forms.def.list and forms.def.get (the reads): the control-plane path to a
// site's form definitions. Before this, a `form_defs` row could only be created by raw SQL; the forms module
// (src/forms/**) only ever READS them (form-lookup.service.ts).
//
// forms.define is an UPSERT by (site, key), the table's own UNIQUE (site_id, key). Redefining a form keeps its
// `id`: the site posts to `/v1/t/:tenantSlug/forms/:formId/submit`, so the id is part of the site's configuration.
//
// IT RUNS IN THE SHARED COMMAND ENVELOPE (../command-envelope.ts), like schema.apply: idempotency claim -> ONE
// transaction (audit row `control.forms.define` FIRST, the effect, the idempotency record) -> replay returns the
// stored body with `replayed: true`. MEDIUM / webdesk:operate, no WS4 approval: it changes what a public form
// accepts, but it never touches `/v1` delivery and never publishes content. It is NOT an editorial command (no
// content principal, the same family as schema.apply), so it is not on the client-editor allow-list either: a
// client-editor assertion cannot be expressed on this route, and the ERP route behind it is staff-only.
//
// THE NOTICE RULE (409 `consent-version-unchanged`). Every submission snapshots the consent notice TEXT and
// VERSION it was accepted under (consent.ts). `form_defs` has a version column but no text column; the text
// lives in `schema.consentNotice.text`. Changing the text without moving the version would make the stored
// version of record describe two different notices, so it is refused. The comparison uses what a submission
// would snapshot (resolveConsentRecord: the trimmed text, else the config default; the version column, else the
// config default), so a form that was created by raw SQL with no notice is compared against the defaults it has
// actually been recording. A version change with identical text is allowed (a re-affirmation).
//
// No personal data is read or written here. The audit row carries the form key, the notice version and counts;
// never the notice text, never a field value (there is none).
import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DbService } from "../../db/db.service";
import { CommandEnvelope } from "../command-envelope";
import { ContentCommandsService } from "../content/content-commands.service";
import { ControlProblem, problems } from "../content/content-problem";
import { computeCommandHash } from "../auth/ws4-assertion";
import { resolveConsentRecord } from "../../forms/consent";
import type { FormSchemaDef } from "../../forms/form-schema.service";
import { FORM_KEY_RE, parseFormDefinition, type FormDefinition } from "./form-definition";

export interface FormDefView {
  formId: string;
  key: string;
  siteId: string;
  schema: unknown;
  notify: unknown;
  retentionDays: number;
  consentNoticeVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FormDefineResult {
  form: FormDefView;
  /** True when this call created the definition; false when it replaced an existing one (same `formId`). */
  created: boolean;
  /** True when the notice text differs from the previous definition's (the version moved with it, or it was refused). */
  consentNoticeChanged: boolean;
}

interface Row {
  id: string;
  key: string;
  site_id: string;
  schema: unknown;
  notify: unknown;
  retention_days: number;
  consent_notice_version: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLUMNS = `id, key, site_id, schema, notify, retention_days, consent_notice_version, created_at, updated_at`;
const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export const formDefNotFound = () => new ControlProblem(404, "form-not-found", "Form not found", "No such form on this site.");

export const consentVersionUnchanged = (version: string) =>
  new ControlProblem(
    409,
    "consent-version-unchanged",
    "Consent notice changed without a new version",
    "The consent notice text differs from the one in force, but consentNoticeVersion is unchanged. Every submission snapshots the notice text and version it was accepted under, so a changed text needs a new version. Nothing was changed.",
    { consentNoticeVersion: version },
  );

function view(r: Row): FormDefView {
  return {
    formId: r.id,
    key: r.key,
    siteId: r.site_id,
    schema: r.schema,
    notify: r.notify,
    retentionDays: r.retention_days,
    consentNoticeVersion: r.consent_notice_version,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export interface FormDefineContext {
  tenant: { id: string; slug: string };
  siteId: string;
  /** The control principal's subject (the ERP's service identity), as for schema.apply. */
  actor: string;
  idempotencyKey: string;
}

@Injectable()
export class FormDefsService {
  constructor(
    private readonly db: DbService,
    private readonly envelope: CommandEnvelope,
    private readonly content: ContentCommandsService,
  ) {}

  resolveTenantSite(tenantSlug: string, siteId: string) {
    return this.content.resolveTenantSite(tenantSlug, siteId);
  }

  // ── forms.define ─────────────────────────────────────────────────────────────────────────────
  async define(ctx: FormDefineContext, def: FormDefinition): Promise<FormDefineResult & { replayed: boolean }> {
    const schemaJson = JSON.stringify(def.schema);
    const notifyJson = JSON.stringify(def.notify);
    return this.envelope.run<FormDefineResult>({
      command: "forms.define",
      scope: { kind: "tenant", tenantId: ctx.tenant.id },
      scopeKey: `${ctx.tenant.slug}:forms.define:${ctx.idempotencyKey}`,
      requestHash: computeCommandHash("forms.define", {
        tenantSlug: ctx.tenant.slug,
        siteId: ctx.siteId,
        key: def.key,
        schema: def.schema,
        notify: def.notify,
        retentionDays: def.retentionDays,
        consentNoticeVersion: def.consentNoticeVersion,
      }),
      actor: ctx.actor,
      // Identifiers and counts only. Not the notice text, not a field label.
      auditArgs: {
        tenantSlug: ctx.tenant.slug,
        siteId: ctx.siteId,
        formKey: def.key,
        consentNoticeVersion: def.consentNoticeVersion,
        retentionDays: def.retentionDays,
        fieldCount: def.schema.fields.length,
      },
      ws4ApprovalId: null, // MEDIUM: no WS4 approval to claim
      mapError: (err) => {
        // Two first-time defines of the same (site, key) racing: the loser hits UNIQUE (site_id, key).
        const e = err as { code?: string; constraint?: string };
        if (e?.code === "23505" && typeof e.constraint === "string" && e.constraint.startsWith("form_defs")) {
          return problems.conflict("form-define-conflict", "Concurrent definition", "Another request defined this form at the same moment. Re-read it and retry.");
        }
        return err;
      },
      effect: async (client) => {
        const { rows } = await client.query<Row>(
          `SELECT ${COLUMNS} FROM form_defs WHERE site_id = $1 AND key = $2 AND tenant_id = $3 FOR UPDATE`,
          [ctx.siteId, def.key, ctx.tenant.id],
        );
        const existing = rows[0] ?? null;
        let consentNoticeChanged = false;
        if (existing) {
          const was = resolveConsentRecord(existing.schema as FormSchemaDef, existing.consent_notice_version);
          const nowText = def.schema.consentNotice.text;
          consentNoticeChanged = was.text !== nowText;
          if (consentNoticeChanged && was.version === def.consentNoticeVersion) throw consentVersionUnchanged(def.consentNoticeVersion);
        }
        const saved = existing ? await this.update(client, ctx, existing.id, def, schemaJson, notifyJson) : await this.insert(client, ctx, def, schemaJson, notifyJson);
        return { result: { form: view(saved), created: existing === null, consentNoticeChanged } };
      },
    });
  }

  private async insert(client: PoolClient, ctx: FormDefineContext, def: FormDefinition, schemaJson: string, notifyJson: string): Promise<Row> {
    const { rows } = await client.query<Row>(
      `INSERT INTO form_defs (id, tenant_id, site_id, key, schema, notify, retention_days, consent_notice_version)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
       RETURNING ${COLUMNS}`,
      [randomUUID(), ctx.tenant.id, ctx.siteId, def.key, schemaJson, notifyJson, def.retentionDays, def.consentNoticeVersion],
    );
    return rows[0];
  }

  private async update(client: PoolClient, ctx: FormDefineContext, id: string, def: FormDefinition, schemaJson: string, notifyJson: string): Promise<Row> {
    const { rows } = await client.query<Row>(
      `UPDATE form_defs
          SET schema = $1::jsonb, notify = $2::jsonb, retention_days = $3, consent_notice_version = $4, updated_at = now()
        WHERE id = $5 AND tenant_id = $6
        RETURNING ${COLUMNS}`,
      [schemaJson, notifyJson, def.retentionDays, def.consentNoticeVersion, id, ctx.tenant.id],
    );
    return rows[0];
  }

  // ── reads (live SELECTs: no audit row, no idempotency, like every control read) ─────────────────
  async list(tenantId: string, siteId: string): Promise<{ forms: FormDefView[] }> {
    const rows = await this.db.withTenant(tenantId, async (db) => {
      const r = await db.query<Row>(`SELECT ${COLUMNS} FROM form_defs WHERE site_id = $1 AND tenant_id = $2 ORDER BY key`, [siteId, tenantId]);
      return r.rows;
    });
    return { forms: rows.map(view) };
  }

  /** `key` is the form's stable key; a uuid is not accepted here (the form id is in the answer). */
  async get(tenantId: string, siteId: string, key: string): Promise<{ form: FormDefView }> {
    if (!FORM_KEY_RE.test(key)) throw formDefNotFound();
    const row = await this.db.withTenant(tenantId, async (db) => {
      const r = await db.query<Row>(`SELECT ${COLUMNS} FROM form_defs WHERE site_id = $1 AND key = $2 AND tenant_id = $3`, [siteId, key, tenantId]);
      return r.rows[0] ?? null;
    });
    if (!row) throw formDefNotFound();
    return { form: view(row) };
  }
}

/** Parses and validates; 422 `form-definition-invalid` with every issue, before anything is claimed or audited. */
export function parseOrRefuse(key: string, body: unknown): FormDefinition {
  const r = parseFormDefinition(key, body);
  if (!r.ok) {
    throw new ControlProblem(422, "form-definition-invalid", "Form definition invalid", "The form definition is not acceptable. Nothing was changed.", { issues: r.issues });
  }
  return r.value;
}

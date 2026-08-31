import type { FastifyRequest } from "fastify";

/** The resolved form_defs row this submission targets — set once, by FormContextGuard, before the
 *  controller or FormRateLimitGuard ever run. Mirrors auth/webdesk-request.ts's own pattern
 *  (`request.webdesk`), one field per guard-resolved concern. */
export type ResolvedForm = {
  formId: string;
  tenantId: string;
  tenantSlug: string;
  siteId: string;
  key: string;
  schema: Record<string, unknown>;
  notify: Record<string, unknown>;
  retentionDays: number;
  consentNoticeVersion: string | null;
};

export type WebdeskFormRequest = FastifyRequest & { webdeskForm?: ResolvedForm };

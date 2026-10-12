import type { FastifyRequest } from "fastify";

/** Set once by ConsentContextGuard before the rate-limit guard or the controller run. */
export type ResolvedConsentContext = {
  tenantId: string;
  tenantSlug: string;
  /** The site whose environment domain matches the request Origin. */
  siteId: string;
};

export type WebdeskConsentRequest = FastifyRequest & { webdeskConsent?: ResolvedConsentContext };

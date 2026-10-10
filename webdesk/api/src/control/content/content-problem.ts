// WSK-41 — RFC 9457 problem details for the content commands (write-plane design §3.4).
//
// `type` is https://webdesk.gaiada.online/errors/<slug>, the same base the /v1 envelope's problem
// details use (delivery/vocabulary/problem-details.ts) and the two control routes that already answer
// with a problem body (contract.controller.ts, lifecycle.service.ts). Extra members (`issues`,
// `currentHeadVersion`, ...) sit at the top level, as RFC 9457 §3.2 allows.
//
// ControlProblem is an HttpException, so a service can throw it from inside a transaction and the
// rollback happens on the way out. ControlProblemFilter only rewrites the content type to
// `application/problem+json`; the body is exactly what the exception carries. It is bound with
// @UseFilters on the content controller, which also covers the guards in that controller's chain
// (EditorialAssertionGuard throws ControlProblem for the 401/403/503 editorial refusals). Every other
// exception keeps Nest's default handling, so the existing L1-L4 refusals are unchanged.
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import type { FastifyReply } from "fastify";

export const PROBLEM_TYPE_BASE = "https://webdesk.gaiada.online/errors";

export interface ControlProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  [extra: string]: unknown;
}

export class ControlProblem extends HttpException {
  readonly slug: string;

  constructor(status: number, slug: string, title: string, detail?: string, extra?: Record<string, unknown>) {
    const body: ControlProblemBody = { type: `${PROBLEM_TYPE_BASE}/${slug}`, title, status };
    if (detail !== undefined) body.detail = detail;
    if (extra) Object.assign(body, extra);
    super(body, status);
    this.slug = slug;
  }
}

/** One composition/content issue, as validateItemContent and validateCollectionComposition report it. */
export interface ProblemIssue {
  path: string;
  message: string;
  expected?: string;
}

export const problems = {
  invalidRequest: (detail: string) => new ControlProblem(400, "invalid-request", "Invalid request", detail),
  itemNotFound: () => new ControlProblem(404, "item-not-found", "Item not found", "No such item on this site."),
  collectionNotFound: () =>
    new ControlProblem(404, "collection-not-found", "Collection not found", "No such collection on this site."),
  siteNotFound: () => new ControlProblem(404, "site-not-found", "Site not found", "No such site for this tenant."),
  compositionViolation: (issues: ProblemIssue[], detail = "The content does not satisfy the collection's composition.") =>
    new ControlProblem(422, "composition-violation", "Composition violation", detail, { issues }),
  payloadTooLarge: (detail: string) => new ControlProblem(413, "payload-too-large", "Payload too large", detail),
  conflict: (slug: string, title: string, detail: string, extra?: Record<string, unknown>) =>
    new ControlProblem(409, slug, title, detail, extra),
};

@Catch(ControlProblem)
export class ControlProblemFilter implements ExceptionFilter {
  catch(exception: ControlProblem, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    reply.status(exception.getStatus()).header("content-type", "application/problem+json").send(exception.getResponse());
  }
}

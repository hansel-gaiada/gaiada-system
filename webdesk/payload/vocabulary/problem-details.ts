// webdesk/payload/vocabulary/problem-details.ts
//
// WSK-06 — the frozen error envelope (webdesk-design.md §05 v1.1 amendment, WSK-D18): RFC 9457
// Problem Details for HTTP APIs, one shape for every /v1 failure across every tenant/collection.
export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail?: string
  instance: string
  requestId: string
}

const PROBLEM_BASE = 'https://webdesk.gaiada.online/errors'

export function problemDetails(input: {
  /** Appended to PROBLEM_BASE, e.g. "tenant-key-scope" -> .../errors/tenant-key-scope. */
  slug: string
  title: string
  status: number
  detail?: string
  instance: string
  requestId: string
}): ProblemDetails {
  return {
    type: `${PROBLEM_BASE}/${input.slug}`,
    title: input.title,
    status: input.status,
    detail: input.detail,
    instance: input.instance,
    requestId: input.requestId,
  }
}

/** `application/problem+json`, per RFC 9457 §3. */
export function problemResponse(problem: ProblemDetails, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders)
  headers.set('content-type', 'application/problem+json')
  return new Response(JSON.stringify(problem), { status: problem.status, headers })
}

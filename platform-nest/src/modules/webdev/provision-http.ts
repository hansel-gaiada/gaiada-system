// PRV-02 — the `provision-http` driver. THE ONLY FILE IN `src/modules/webdev/` THAT TALKS OUTWARD.
// `egress-inventory.test.ts` enforces that sentence statically; if you add a `fetch` anywhere else in
// this module, that test fails BY NAME rather than a security control quietly evaporating.
//
// Design: docs/blueprints/provision-erp-seam-design.md §03 (Zone B′, the ONE control channel, custody
// map) + §04 (the provision-side contract, which this driver does not get to reinterpret).
//
// ── STATUS (WSK-D33, 2026-09-01): RETAINED, NOT WIRED INTO ANY LIVE CONTROLLER PATH ───────────────
// The `provision` host (gda-s01) this driver calls is DECOMMISSIONED — `https://provision.gaiada.
// online` measures 000 on every request, and the live `.env` carries no `PROVISION_*` vars at all.
// `webdev.controller.ts#resolveProvider` no longer constructs this driver under any config value —
// see that file's own header. It is kept, unmodified, rather than deleted, for three reasons: (1)
// this file and its test suite are the only place the `ProvisionProvider` interface's original,
// fully-synchronous contract (create/conflict/reject, the 409 adopt-only-if-ours shape) is exercised
// end-to-end against a real driver — `erp-repo-control-provider.ts`'s tests cover the NEW,
// approval-mediated shape instead, and losing this coverage would lose the historical proof that the
// interface itself once supported a provider that never needed a human in the loop; (2) the retry/
// timeout/credential-redaction discipline here (the `#`-private fields, `redact()`, the
// transport-only retry policy) is real, load-bearing design knowledge for whatever eventually
// implements a genuine `WebdeskProvider` (design D-P2) over its own HTTP seam; (3) deleting it would
// also delete `PROVISION_WIRE_FRAMEWORK`'s canonical->wire alias table, which is the only place that
// mapping is written down. If this ever needs to be reachable again, that is a deliberate wiring
// change in `webdev.controller.ts`, not a config value someone can flip by accident — there is no
// `PROVISION_BASE_URL`-shaped escape hatch left in the live controller.
//
// ── WHAT THIS DRIVER IS ALLOWED TO TOUCH (design §03, "Command surface") ─────────────────────────
//   POST /api/users/login                          — mint a session (cached; re-login once on 401)
//   POST /api/provision                            — the create
//   GET  /api/projects/:id                         — the poll
//   GET  /api/projects?where[name][equals]=<slug>  — the 409-reconcile read
// Nothing else. The ERP never calls provision's `users`/`prds` admin surface, and this driver has no
// method that could. That is a deliberate narrowing of a far side that (per the design's own findings
// P-1/P-2) authorizes any logged-in user to provision.
//
// ── CREDENTIAL HANDLING ─────────────────────────────────────────────────────────────────────────
// The service password is read once at construction and used ONLY as a `POST /api/users/login` body
// field. It is never placed in a URL, a header we log, an error message, or a returned object. Both
// it and the minted JWT are held in ECMAScript `#`-private fields — genuinely absent from the
// instance's enumerable surface, so `JSON.stringify(driver)` cannot emit them (this was a REAL
// defect caught by this module's own test; see the class body). Neither ever reaches the mirror row
// or an event payload. `redact()` below is applied to every error string that could
// conceivably have been built from a response body. The GitHub PAT and fleet SSH key are NOT here and
// must never be: they live in provision's own `.env` on gda-s01 (design D-P4).
//
// ── RETRY POLICY, AND THE ONE THING IT MUST NEVER DO ────────────────────────────────────────────
// Transport failures (DNS/TCP/TLS/timeout) are retried with exponential backoff, bounded by
// `config.provision.retryAttempts` — the §03 unavailability contract. An HTTP RESPONSE is never
// retried, no matter its status: a 5xx from provision means the request WAS received and acted on,
// and a blind re-POST of a create is precisely how one approved request becomes two GitHub repos and
// two nginx vhosts. The far side's own layer-2 (DB-unique `projects.name` + repo-exists-before-create,
// design §04) is the backstop for the ambiguous transport-failure case, and the ERP's answer to it is
// the 409 branch, not a retry.
import { config } from "../../config";
import {
  ProvisionEgressError, ProvisionNotConfiguredError, type CanonicalFramework, type CreateProjectInput,
  type CreateProjectResult, type ProvisionProject, type ProvisionProvider,
} from "./provision-provider";

/** WSK-D28 / §08: the ERP's canonical framework -> provision's own wire vocabulary. `vite`/`nextjs`
 *  map to themselves (no-op, the two values provision has always understood); `astro`/`node` are
 *  the §08 aliases for the exact same templates. `wp` is handled by an explicit check in
 *  `createProject` below, never by this map — it is the one canonical value with NO wire
 *  equivalent, by design, not an oversight. Anything else (a value outside the canonical contract
 *  entirely, reachable only by bypassing the type system) falls through unmapped and is forwarded
 *  to provision UNCHANGED, exactly as before this ticket: this driver does not second-guess a token
 *  it does not recognize as its own vocabulary, and lets the real far side's own validation answer. */
const PROVISION_WIRE_FRAMEWORK: Partial<Record<CanonicalFramework, "vite" | "nextjs">> = {
  vite: "vite",
  astro: "vite",
  nextjs: "nextjs",
  node: "nextjs",
};

type FetchImpl = typeof fetch;

/** Strip anything credential-shaped out of a string bound for a log, an error, or a notification.
 *  Belt-and-braces: no code path here intentionally puts a secret in a message, and this makes an
 *  UNintentional one (a far side that echoes the login body back in a 400, say) non-exploitable. */
function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  }
  return out;
}

/** Payload's REST error envelope is `{errors:[{message}]}`; a bare string or a `{message}` also show
 *  up in practice. Reduced to ONE short line, then redacted, then capped — an error message is a
 *  diagnostic, not a transcript of an untrusted far side's response body. */
function reasonFrom(body: unknown, fallback: string): string {
  const b = body as { errors?: Array<{ message?: string }>; message?: string } | string | undefined;
  if (typeof b === "string" && b.trim()) return b.trim().slice(0, 200);
  const first = typeof b === "object" && b ? b.errors?.[0]?.message ?? b.message : undefined;
  return (first ?? fallback).slice(0, 200);
}

/** The far side's project shape -> our narrow `ProvisionProject`.
 *
 *  `status` is mapped through an EXPLICIT allowlist rather than cast. An unknown status string from a
 *  future provision version must not flow into our state machine as if it were understood: it becomes
 *  `pending` (non-terminal, keeps reconciling) rather than being trusted as `live`. A missing field
 *  reads exactly like NULL, so `repoUrl`/`stagingUrl` are normalized to `null` and never to `""`. */
function toProject(raw: unknown): ProvisionProject | null {
  const r = raw as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== "object") return null;
  const id = typeof r.id === "string" ? r.id : typeof r.id === "number" ? String(r.id) : null;
  const name = typeof r.name === "string" ? r.name : null;
  if (!id || !name) return null;
  const rawStatus = typeof r.status === "string" ? r.status : "";
  const status: ProvisionProject["status"] =
    rawStatus === "provisioned" || rawStatus === "live" || rawStatus === "failed" ? rawStatus : "pending";
  return {
    id,
    name,
    status,
    repoUrl: typeof r.repoUrl === "string" && r.repoUrl ? r.repoUrl : null,
    stagingUrl: typeof r.stagingUrl === "string" && r.stagingUrl ? r.stagingUrl : null,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ProvisionHttpDriverOptions {
  baseUrl: string;
  serviceEmail: string;
  servicePassword: string;
  timeoutMs: number;
  retryAttempts: number;
  retryBaseDelayMs: number;
  /** Test seam (the `token-endpoint-client.ts` precedent). Production passes nothing. */
  fetchImpl?: FetchImpl;
}

/** Build the driver from `config.provision`, or throw `ProvisionNotConfiguredError`.
 *
 *  FAIL-CLOSED IS THE POINT: there is no default base URL, no "skip the call" mode, and no
 *  half-configured state. A deployment that forgot the env gets a 503 from the endpoint, which is
 *  strictly better than either provisioning against a host nobody chose or reporting success for
 *  infrastructure that was never created. */
export function createProvisionHttpDriver(fetchImpl?: FetchImpl): ProvisionProvider {
  const p = config.provision;
  if (!p.baseUrl || !p.serviceEmail || !p.servicePassword) throw new ProvisionNotConfiguredError();
  return new ProvisionHttpDriver({
    baseUrl: p.baseUrl,
    serviceEmail: p.serviceEmail,
    servicePassword: p.servicePassword,
    timeoutMs: p.timeoutMs,
    retryAttempts: p.retryAttempts,
    retryBaseDelayMs: p.retryBaseDelayMs,
    fetchImpl,
  });
}

export class ProvisionHttpDriver implements ProvisionProvider {
  readonly key = "provision" as const;

  // ── WHY THESE ARE `#`-PRIVATE AND NOT `private` ────────────────────────────────────────────────
  // TypeScript's `private` is COMPILE-TIME ONLY: the field is an ordinary enumerable own property at
  // runtime, so `JSON.stringify(driver)` emits it. This class was written with `private` first and
  // the "nothing serializes a secret" test in `provision-http.test.ts` caught the service password
  // and the live session JWT in the dump — a real leak into any log line, error report or telemetry
  // payload that ever stringifies a driver instance. ECMAScript `#` fields are genuinely private:
  // not enumerable, not reachable by `Object.keys`, and skipped by `JSON.stringify`. The test stays
  // as the regression pin, because "we remembered not to log it" is not a control.
  readonly #password: string;
  readonly #settings: Omit<ProvisionHttpDriverOptions, "servicePassword" | "fetchImpl">;
  readonly #doFetch: FetchImpl;
  /** The cached session JWT. `null` means "log in on the next call". */
  #token: string | null = null;
  /** In-flight login, so N concurrent calls mint ONE session instead of N. */
  #loginInFlight: Promise<string> | null = null;

  constructor(opts: ProvisionHttpDriverOptions) {
    if (!opts.baseUrl || !opts.serviceEmail || !opts.servicePassword) throw new ProvisionNotConfiguredError();
    this.#password = opts.servicePassword;
    this.#settings = {
      baseUrl: opts.baseUrl,
      serviceEmail: opts.serviceEmail,
      timeoutMs: opts.timeoutMs,
      retryAttempts: opts.retryAttempts,
      retryBaseDelayMs: opts.retryBaseDelayMs,
    };
    this.#doFetch = opts.fetchImpl ?? fetch;
  }

  /** Test-only: repoint the driver at a different origin (used to simulate a session the far side no
   *  longer recognizes). Never called in production — the base URL comes from config at construction. */
  setBaseUrlForTests(baseUrl: string): void {
    this.#settings.baseUrl = baseUrl;
  }

  #url(path: string): string {
    return `${this.#settings.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  #secrets(): string[] {
    return [this.#password, this.#token ?? ""];
  }

  /** ONE HTTP round trip with a timeout and TRANSPORT-ONLY retries. Returns the parsed body plus the
   *  status; never throws on a non-2xx (an HTTP answer is data, not an exception — see the header). */
  async #send(
    method: "GET" | "POST",
    path: string,
    init: { body?: unknown; token?: string | null },
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.token) headers.authorization = `Bearer ${init.token}`;

    let lastErr: unknown;
    const attempts = Math.max(1, this.#settings.retryAttempts);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#settings.timeoutMs);
      try {
        const res = await this.#doFetch(this.#url(path), {
          method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: controller.signal,
        });
        const text = await res.text();
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          // A non-JSON body from an HTTP answer is still an answer (an nginx 502 page, say). Keep it
          // as a capped string so `reasonFrom` can surface something useful instead of "undefined".
          body = text.slice(0, 200);
        }
        return { status: res.status, body };
      } catch (err) {
        // Transport-only. `fetch` rejects for DNS/TCP/TLS/abort; every HTTP status resolves above.
        lastErr = err;
        if (attempt < attempts - 1) await sleep(this.#settings.retryBaseDelayMs * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new ProvisionEgressError(
      redact(`provision ${method} ${path} failed after ${attempts} attempt(s): ${msg}`, this.#secrets()),
    );
  }

  /** Mint (or reuse) the session JWT. Concurrency-collapsed so a burst does not mint N sessions. */
  async #login(): Promise<string> {
    if (this.#token) return this.#token;
    if (this.#loginInFlight) return this.#loginInFlight;
    this.#loginInFlight = (async () => {
      const { status, body } = await this.#send("POST", "/api/users/login", {
        body: { email: this.#settings.serviceEmail, password: this.#password },
      });
      const token = (body as { token?: unknown } | undefined)?.token;
      if (status !== 200 || typeof token !== "string" || !token) {
        // Deliberately does NOT echo the response body: a login failure is the one response most
        // likely to contain the submitted credential in some far side's error text.
        throw new ProvisionEgressError(`provision login failed (status ${status})`);
      }
      this.#token = token;
      return token;
    })().finally(() => {
      this.#loginInFlight = null;
    });
    return this.#loginInFlight;
  }

  /** Authenticated call with EXACTLY ONE re-login on 401 (design §03: "caches the JWT,
   *  re-authenticating on 401").
   *
   *  One, not a loop: a far side that answers 401 to a freshly-minted token is misconfigured or has
   *  revoked us, and retrying that forever would hammer the login endpoint of an internet-facing box
   *  with a credential it is already rejecting. The second 401 is returned to the caller as an answer.
   *
   *  `retryOn401` is guarded so this can never recurse: the retry passes `false`. */
  async #authed(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    retryOn401 = true,
  ): Promise<{ status: number; body: unknown }> {
    const token = await this.#login();
    const res = await this.#send(method, path, { body, token });
    if (res.status === 401 && retryOn401) {
      // Drop the cached session and mint a new one exactly once.
      if (this.#token === token) this.#token = null;
      return this.#authed(method, path, body, false);
    }
    return res;
  }

  async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    // WSK-D28 / §08: `input.framework` is the ERP's CANONICAL vocabulary (vite/nextjs/astro/node/
    // wp — see provision-provider.ts). `provision` itself only ever understood two literal wire
    // tokens (its own `/api/provision` validates `framework IN ('vite','nextjs')`, unchanged by
    // this ticket — it is a real, external tool the ERP does not own). `astro`/`node` are pure
    // aliases for what provision already builds as `vite`/`nextjs` (§08's table: "works today as
    // vite/astro" / "works today as nextjs/node"), so they translate here, at the driver boundary,
    // never upstream in the service layer.
    if (input.framework === "wp") {
      // provision is a static-export-only tool (no per-project database, no runtime, no port —
      // docs/architecture.md in the provision repo) and has no wire token for this at all. This is
      // a REAL capability boundary, not a policy refusal the ERP invented — so it is answered
      // honestly, at this layer, without ever making the HTTP call (no point spending a
      // credentialed round trip on a request this driver already knows cannot succeed). §08's "the
      // stack hint stops being a refusal and becomes the selector" is satisfied one level up (the
      // service no longer pre-emptively blocks a `wp` request before it reaches a provider) — this
      // is the honest answer once it DOES reach the only provider that exists today.
      return {
        outcome: "rejected",
        status: 422,
        reason:
          "provision cannot deliver a WordPress site (static-export-only tool, no per-project "
          + "database or runtime) — this seam has no webdesk provider yet (design D-P2); provision "
          + "the repo/theme via the WebDesk WordPress path instead.",
      };
    }
    // Any OTHER canonical value translates to provision's own wire vocabulary (astro->vite,
    // node->nextjs, vite/nextjs unchanged); anything outside the canonical contract at all falls
    // through unmapped and is forwarded verbatim, unchanged from this driver's pre-WSK-D28
    // behavior — provision's own `/api/provision` validation is the backstop for a token this
    // driver does not recognize as its own vocabulary.
    const wireFramework = PROVISION_WIRE_FRAMEWORK[input.framework] ?? input.framework;
    const { status, body } = await this.#authed("POST", "/api/provision", {
      devName: input.devName,
      name: input.name,
      framework: wireFramework,
    });

    if (status === 409) {
      // THE TENANCY-CRITICAL BRANCH. We read the far side's record for that NAME so the caller has
      // something to test ownership against — but the ownership decision itself is made against the
      // ERP's own mirror table, never against anything in this response. Note what is deliberately
      // NOT used: any `isOurs`-flavoured field the far side might volunteer. `provision`'s project
      // namespace is global and untenanted; a far side cannot answer "is this ours" and must not be
      // asked to. A failure to read it back is not fatal — `existing: null` means "refuse", which is
      // the safe direction.
      let existing: ProvisionProject | null = null;
      try {
        existing = await this.findProjectByName(input.name);
      } catch {
        existing = null;
      }
      return { outcome: "conflict", existing };
    }

    if (status === 200 || status === 201 || status === 202) {
      const project = toProject(body);
      if (!project) {
        // A 2xx we cannot correlate is WORSE than an error: provision may well have created a repo
        // and a vhost, and we have no `provider_ref` to poll or adopt. Surfacing it as an egress
        // error (rather than swallowing it) is what puts a human on it.
        throw new ProvisionEgressError("provision accepted the request but returned an uncorrelatable body");
      }
      return { outcome: "accepted", project };
    }

    return { outcome: "rejected", status, reason: redact(reasonFrom(body, `provision returned ${status}`), this.#secrets()) };
  }

  async getProject(id: string): Promise<ProvisionProject | null> {
    const { status, body } = await this.#authed("GET", `/api/projects/${encodeURIComponent(id)}`);
    if (status === 404) return null;
    if (status !== 200) {
      throw new ProvisionEgressError(redact(reasonFrom(body, `provision project read returned ${status}`), this.#secrets()));
    }
    return toProject(body);
  }

  async findProjectByName(name: string): Promise<ProvisionProject | null> {
    const { status, body } = await this.#authed(
      "GET",
      `/api/projects?where[name][equals]=${encodeURIComponent(name)}`,
    );
    if (status !== 200) {
      throw new ProvisionEgressError(redact(reasonFrom(body, `provision project search returned ${status}`), this.#secrets()));
    }
    const docs = (body as { docs?: unknown[] } | undefined)?.docs;
    if (!Array.isArray(docs) || docs.length === 0) return null;
    // Exact-name match only. Payload's `where[name][equals]` is exact already, but re-checking here
    // means a far side that ever loosens that filter cannot hand us a DIFFERENT client's project as
    // the answer to "does this name exist".
    for (const doc of docs) {
      const project = toProject(doc);
      if (project && project.name === name) return project;
    }
    return null;
  }
}

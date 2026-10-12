// M6-P4c — the provisioning completion state machine (provision-completion.ts), with NO service: an
// in-memory world whose `withLockedSite` is a real mutex plus a real rollback (a transaction's writes are
// applied to a copy and kept only if the callback resolves), a fake WebDesk that holds the far side's two
// facts (its tenants, and its claim-first idempotency records), and a fake contract mirror that is
// idempotent per (slug, version) like `refreshContractSnapshot`.
//
// WHAT THIS IS TRYING TO FALSIFY:
//   1. the transition function, row by row;
//   2. idempotency: replaying a finished step does nothing (one registry row, one tenant request, one
//      contract pin, no approval of any kind);
//   3. crash-resume: the process dying INSIDE each step (after the far side acted, before our commit) and
//      BETWEEN each pair of steps, then a resume, never duplicates a registry row, a tenant or a snapshot;
//   4. the refusals: a foreign registry domain, a foreign WebDesk slug, a transient WebDesk failure, a
//      contract not yet published — recorded, state unchanged, resumable;
//   5. two concurrent advances serialize: still one registry row, one tenant request, one snapshot.
// The Postgres + WebDesk adapters are proven in provision-completion.db.test.ts (the Linux gate).
import { describe, it, expect, beforeEach } from "vitest";
import {
  advanceProvisionCompletion,
  nextCompletionStep,
  placeholderDomainFor,
  tenantIdempotencyKey,
  type CompletionPorts,
  type CompletionRow,
  type CompletionTx,
  type ContractPinResult,
  type RegistryUpsertInput,
  type TenantProvisionResult,
} from "./provision-completion";

const COMPANY = "0f1e2d3c-4b5a-4968-8776-655443322110";
const OTHER_COMPANY = "5d6e7f80-91a2-4b3c-8d4e-5f6a7b8c9d0e";
const SITE = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";

class Crash extends Error {
  constructor(at: string) {
    super(`simulated crash at ${at}`);
    this.name = "Crash";
  }
}

type CrashPoint =
  | "after_upsert" // register: the registry INSERT ran, the state change did not commit
  | "before_tenant_send" // between register and tenant: died before WebDesk saw anything
  | "after_tenant_send" // tenant: WebDesk committed the tenant, our record did not
  | "before_pin" // between tenant and contract
  | "after_pin" // contract: the snapshot was mirrored, the state change did not commit
  | "after_mark_complete";

interface RegistryRow {
  id: string;
  tenantId: string;
  domain: string;
  origin: string;
  kind: string;
  repoUrl: string;
  clientId: string | null;
  projectId: string | null;
  contractVersion: string | null;
}

interface LocalState {
  row: CompletionRow;
  registry: RegistryRow[];
  events: string[];
}

const clone = (s: LocalState): LocalState => JSON.parse(JSON.stringify(s)) as LocalState;

class World {
  local: LocalState;
  // ── the far side: WebDesk ──
  wdTenants = new Map<string, string>(); // slug -> companyRef
  wdIdempotency = new Map<string, string>(); // key -> slug it created
  tenantRequests = 0;
  tenantsCreated = 0;
  nextTenantAnswer: TenantProvisionResult | null = null;
  // ── the far side: the contract mirror ──
  published = new Map<string, string>(); // slug -> current contract version
  snapshots = new Map<string, string>(); // `${slug}@${version}` -> snapshot id
  pinCalls = 0;
  // ── control ──
  crashAt: CrashPoint | null = null;
  private lock: Promise<void> = Promise.resolve();
  private ids = 0;

  constructor(row: Partial<CompletionRow> = {}) {
    this.local = {
      row: {
        id: SITE,
        tenantId: COMPANY,
        provider: "erp_repo",
        slug: "acme-site",
        framework: "astro",
        status: "live",
        repoUrl: "https://github.com/acme-org/acme-site",
        clientId: "c1c1c1c1-0000-4000-8000-000000000001",
        projectId: "p1p1p1p1-0000-4000-8000-000000000001",
        completionState: null,
        webdevSiteId: null,
        webdeskTenantSlug: null,
        contractSnapshotId: null,
        completionError: null,
        ...row,
      },
      registry: [],
      events: [],
    };
  }

  private crash(at: CrashPoint): void {
    if (this.crashAt === at) {
      this.crashAt = null; // one crash, then the "restarted process" runs clean
      throw new Crash(at);
    }
  }

  private newId(prefix: string): string {
    this.ids += 1;
    return `${prefix}-${this.ids}`;
  }

  ports(): CompletionPorts {
    return {
      withLockedSite: async <T>(fn: (tx: CompletionTx) => Promise<T>): Promise<T> => {
        const prev = this.lock;
        let release: () => void = () => {};
        this.lock = new Promise<void>((r) => {
          release = r;
        });
        await prev;
        try {
          const draft = clone(this.local);
          const result = await fn(this.txFor(draft));
          this.local = draft; // COMMIT only when the callback resolved
          return result;
        } finally {
          release();
        }
      },
      provisionTenant: async (input) => {
        this.crash("before_tenant_send");
        this.tenantRequests += 1;
        if (this.nextTenantAnswer) {
          const a = this.nextTenantAnswer;
          this.nextTenantAnswer = null;
          return a;
        }
        let answer: TenantProvisionResult;
        if (this.wdIdempotency.has(input.idempotencyKey)) {
          answer = { outcome: "replayed" };
        } else if (this.wdTenants.has(input.slug)) {
          answer = this.wdTenants.get(input.slug) === input.companyRef ? { outcome: "adopted" } : { outcome: "foreign" };
        } else {
          this.wdTenants.set(input.slug, input.companyRef);
          this.wdIdempotency.set(input.idempotencyKey, input.slug);
          this.tenantsCreated += 1;
          answer = { outcome: "created" };
        }
        this.crash("after_tenant_send");
        return answer;
      },
      pinContract: async (slug): Promise<ContractPinResult> => {
        this.crash("before_pin");
        this.pinCalls += 1;
        const version = this.published.get(slug);
        if (!version) return { outcome: "not_yet", reason: "contract_not_published" };
        const key = `${slug}@${version}`;
        if (!this.snapshots.has(key)) this.snapshots.set(key, this.newId("snap"));
        return { outcome: "pinned", snapshotId: this.snapshots.get(key) as string, contractVersion: version };
      },
    };
  }

  private txFor(d: LocalState): CompletionTx {
    return {
      read: async () => ({ ...d.row }),
      upsertRegistry: async (input: RegistryUpsertInput) => {
        const existing = d.registry.find((r) => r.tenantId === input.tenantId && r.domain === input.domain);
        if (!existing) {
          const id = this.newId("wsite");
          d.registry.push({
            id, tenantId: input.tenantId, domain: input.domain, origin: "provisioned", kind: input.kind,
            repoUrl: input.repoUrl, clientId: input.clientId, projectId: input.projectId, contractVersion: null,
          });
          d.events.push("webdev.site.created");
          this.crash("after_upsert");
          return { outcome: "inserted", webdevSiteId: id };
        }
        if (existing.origin !== "provisioned") return { outcome: "conflict" };
        return { outcome: "adopted", webdevSiteId: existing.id };
      },
      markRegistered: async (webdevSiteId) => {
        if (d.row.completionState !== null) throw new Error("guard: registered from a non-null state");
        d.row.completionState = "registered";
        d.row.webdevSiteId = webdevSiteId;
        d.row.completionError = null;
        d.events.push("registered");
      },
      markTenantReady: async (slug) => {
        if (d.row.completionState !== "registered") throw new Error("guard: tenant_ready from a non-registered state");
        d.row.completionState = "tenant_ready";
        d.row.webdeskTenantSlug = slug;
        d.row.completionError = null;
        d.events.push("tenant_ready");
      },
      markComplete: async (snapshotId, contractVersion) => {
        if (d.row.completionState !== "tenant_ready") throw new Error("guard: complete from a non-tenant_ready state");
        d.row.completionState = "complete";
        d.row.contractSnapshotId = snapshotId;
        d.row.completionError = null;
        const reg = d.registry.find((r) => r.id === d.row.webdevSiteId);
        if (reg) reg.contractVersion = contractVersion;
        d.events.push("complete");
        this.crash("after_mark_complete");
      },
      recordError: async (token) => {
        d.row.completionError = token;
      },
    };
  }

  // Wrap the pin so a crash can land AFTER the mirror wrote its snapshot (the far side of our commit).
  portsWithPinCrash(): CompletionPorts {
    const p = this.ports();
    return {
      ...p,
      pinContract: async (slug) => {
        const r = await p.pinContract(slug);
        this.crash("after_pin");
        return r;
      },
    };
  }
}

/** Run, and if it crashes, "restart the process" (the crash is the exception, not a result). */
async function runThroughCrash(w: World): Promise<void> {
  await expect(advanceProvisionCompletion(w.portsWithPinCrash(), COMPANY)).rejects.toBeInstanceOf(Crash);
}

describe("nextCompletionStep — the transition function", () => {
  const base = { provider: "erp_repo", status: "live" as const, repoUrl: "https://github.com/o/r", completionState: null };
  it.each([
    [{ ...base, status: "requested" as const, repoUrl: null }, "not_ready"],
    [{ ...base, status: "pending" as const, repoUrl: null }, "not_ready"],
    [{ ...base, status: "provisioned" as const, repoUrl: null }, "not_ready"], // no repo yet: nothing to register
    [{ ...base, status: "failed" as const }, "not_ready"],
    [{ ...base, status: "provisioned" as const }, "register"],
    // A mirror row from the decommissioned `provision` host never BEGINS a completion...
    [{ ...base, provider: "provision" }, "not_ready"],
    // ...but one already begun (adopted deliberately) is finished like any other.
    [{ ...base, provider: "provision", completionState: "registered" as const }, "tenant"],
    [{ ...base }, "register"],
    [{ ...base, completionState: "registered" as const }, "tenant"],
    [{ ...base, completionState: "tenant_ready" as const }, "contract"],
    [{ ...base, completionState: "complete" as const }, "done"],
    [{ ...base, status: "failed" as const, completionState: "registered" as const }, "not_ready"], // a failed row stops
    [{ ...base, status: "failed" as const, completionState: "complete" as const }, "done"],
    // Once begun, completion does not depend on the repo row's later status wobble (pending after a GitHub 404).
    [{ ...base, status: "pending" as const, completionState: "registered" as const }, "tenant"],
  ])("%o -> %s", (row, step) => {
    expect(nextCompletionStep(row)).toBe(step);
  });

  it("the placeholder domain and the WebDesk key are deterministic per slug / per provisioned row", () => {
    expect(placeholderDomainFor("acme-site")).toBe("acme-site.provisioned.invalid");
    expect(tenantIdempotencyKey(SITE)).toBe(`wps-tenant:${SITE}`);
    expect(tenantIdempotencyKey(SITE)).toMatch(/^[\x21-\x7e]{8,200}$/); // WebDesk's Idempotency-Key grammar
  });
});

describe("advanceProvisionCompletion — the happy path and replays", () => {
  let w: World;
  beforeEach(() => {
    w = new World();
    w.published.set("acme-site", "1.0.0");
  });

  it("walks NULL -> registered -> tenant_ready -> complete in one call, with the right registry row", async () => {
    const r = await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(r).toEqual({ state: "complete", next: "done", advanced: ["register", "tenant", "contract"], error: null });
    expect(w.local.registry).toHaveLength(1);
    expect(w.local.registry[0]).toMatchObject({
      domain: "acme-site.provisioned.invalid",
      origin: "provisioned",
      kind: "static", // astro -> static (WSK-D28)
      repoUrl: "https://github.com/acme-org/acme-site",
      clientId: "c1c1c1c1-0000-4000-8000-000000000001",
      projectId: "p1p1p1p1-0000-4000-8000-000000000001",
      contractVersion: "1.0.0",
    });
    expect(w.local.row).toMatchObject({
      completionState: "complete",
      webdevSiteId: w.local.registry[0].id,
      webdeskTenantSlug: "acme-site",
      contractSnapshotId: w.snapshots.get("acme-site@1.0.0"),
    });
    expect(w.wdTenants.get("acme-site")).toBe(COMPANY); // companyRef = the ERP company
    expect(w.tenantRequests).toBe(1);
  });

  it("maps every canonical framework to its §08 kind", async () => {
    for (const [framework, kind] of [["vite", "static"], ["astro", "static"], ["nextjs", "fullstack"], ["node", "fullstack"], ["wp", "wp"]] as const) {
      const x = new World({ framework, slug: `k-${framework}` });
      await advanceProvisionCompletion(x.ports(), COMPANY);
      expect(x.local.registry[0].kind).toBe(kind);
    }
  });

  it("REPLAY: a second (and third) call on a complete row does nothing — one row, one tenant request, one pin", async () => {
    await advanceProvisionCompletion(w.ports(), COMPANY);
    const eventsAfterFirst = [...w.local.events];
    for (let i = 0; i < 2; i++) {
      const r = await advanceProvisionCompletion(w.ports(), COMPANY);
      expect(r).toEqual({ state: "complete", next: "done", advanced: [], error: null });
    }
    expect(w.local.registry).toHaveLength(1);
    expect(w.tenantRequests).toBe(1);
    expect(w.tenantsCreated).toBe(1);
    expect(w.pinCalls).toBe(1);
    expect(w.local.events).toEqual(eventsAfterFirst);
  });

  it("REPLAY of each step in isolation: re-entering at registered / tenant_ready never repeats the earlier step", async () => {
    w.published.delete("acme-site"); // stop at tenant_ready
    const first = await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(first).toMatchObject({ state: "tenant_ready", next: "contract", advanced: ["register", "tenant"], error: "contract_not_published" });
    const again = await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(again).toMatchObject({ state: "tenant_ready", advanced: [], error: "contract_not_published" });
    expect(w.local.registry).toHaveLength(1);
    expect(w.tenantRequests).toBe(1);
    w.published.set("acme-site", "1.0.0");
    const done = await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(done).toMatchObject({ state: "complete", advanced: ["contract"], error: null });
    expect(w.local.row.completionError).toBeNull(); // cleared by the step that succeeded
  });

  it("does nothing at all while the repo step is still running", async () => {
    const x = new World({ status: "pending", repoUrl: null });
    const r = await advanceProvisionCompletion(x.ports(), COMPANY);
    expect(r).toEqual({ state: null, next: "not_ready", advanced: [], error: null });
    expect(x.local.registry).toHaveLength(0);
    expect(x.tenantRequests).toBe(0);
  });

  it("a missing row is reported, not invented", async () => {
    const ports = w.ports();
    const r = await advanceProvisionCompletion({ ...ports, withLockedSite: (fn) => fn({ read: async () => null } as unknown as CompletionTx) }, COMPANY);
    expect(r).toMatchObject({ notFound: true, state: null, advanced: [] });
  });
});

describe("advanceProvisionCompletion — crash inside each step, and between each pair, then resume", () => {
  let w: World;
  beforeEach(() => {
    w = new World();
    w.published.set("acme-site", "1.0.0");
  });

  it("register: crash after the INSERT, before the commit -> rolled back together; resume -> ONE registry row", async () => {
    w.crashAt = "after_upsert";
    await runThroughCrash(w);
    expect(w.local.row.completionState).toBeNull();
    expect(w.local.registry).toHaveLength(0); // the INSERT and the state change are one transaction
    await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(w.local.registry).toHaveLength(1);
    expect(w.local.row.completionState).toBe("complete");
  });

  it("register -> tenant: died before WebDesk saw anything; resume sends once", async () => {
    w.crashAt = "before_tenant_send";
    await runThroughCrash(w);
    expect(w.local.row.completionState).toBe("registered");
    expect(w.tenantRequests).toBe(0);
    await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(w.tenantRequests).toBe(1);
    expect(w.tenantsCreated).toBe(1);
    expect(w.local.registry).toHaveLength(1);
    expect(w.local.row.completionState).toBe("complete");
  });

  it("tenant: WebDesk committed, our record did not -> resume resends the SAME key, WebDesk replays, ONE tenant", async () => {
    w.crashAt = "after_tenant_send";
    await runThroughCrash(w);
    expect(w.local.row.completionState).toBe("registered"); // our commit never happened
    expect(w.tenantsCreated).toBe(1); // ...but WebDesk's did
    const r = await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(r).toMatchObject({ state: "complete", advanced: ["tenant", "contract"] });
    expect(w.tenantRequests).toBe(2); // the resend
    expect(w.tenantsCreated).toBe(1); // ...was a replay
    expect(w.wdIdempotency.size).toBe(1);
    expect(w.local.registry).toHaveLength(1);
  });

  it("tenant: if WebDesk's replay record is gone, the 409 is adopted only because the tenant is listed under OUR company", async () => {
    w.crashAt = "after_tenant_send";
    await runThroughCrash(w);
    w.wdIdempotency.clear(); // the stored replay expired
    const r = await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(r).toMatchObject({ state: "complete" });
    expect(w.tenantsCreated).toBe(1);
  });

  it("tenant -> contract: died before the fetch; resume pins once", async () => {
    w.crashAt = "before_pin";
    await runThroughCrash(w);
    expect(w.local.row.completionState).toBe("tenant_ready");
    expect(w.pinCalls).toBe(0);
    await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(w.local.row.completionState).toBe("complete");
    expect(w.pinCalls).toBe(1);
    expect(w.tenantRequests).toBe(1);
  });

  it("contract: the mirror wrote its snapshot, our record did not -> resume re-pins the SAME snapshot, ONE snapshot", async () => {
    w.crashAt = "after_pin";
    await runThroughCrash(w);
    expect(w.local.row.completionState).toBe("tenant_ready");
    expect(w.snapshots.size).toBe(1);
    await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(w.local.row.completionState).toBe("complete");
    expect(w.snapshots.size).toBe(1);
    expect(w.local.row.contractSnapshotId).toBe(w.snapshots.get("acme-site@1.0.0"));
  });

  it("contract: crash while recording complete -> rolled back; resume completes once", async () => {
    w.crashAt = "after_mark_complete";
    await runThroughCrash(w);
    expect(w.local.row.completionState).toBe("tenant_ready");
    expect(w.local.registry[0].contractVersion).toBeNull(); // the registry update rolled back with it
    await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(w.local.row.completionState).toBe("complete");
    expect(w.local.registry[0].contractVersion).toBe("1.0.0");
    expect(w.local.events.filter((e) => e === "complete")).toHaveLength(1);
  });
});

describe("advanceProvisionCompletion — refusals are recorded, never retried around", () => {
  it("a registry domain held by a NON-provisioned row is registry_domain_taken; nothing advances", async () => {
    const w = new World();
    w.local.registry.push({
      id: "manual-1", tenantId: COMPANY, domain: "acme-site.provisioned.invalid", origin: "manual", kind: "static",
      repoUrl: "x", clientId: null, projectId: null, contractVersion: null,
    });
    const r = await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(r).toMatchObject({ state: null, next: "register", advanced: [], error: "registry_domain_taken" });
    expect(w.local.row.completionError).toBe("registry_domain_taken");
    expect(w.tenantRequests).toBe(0);
  });

  it("an unlinked registry row that provisioning made is ADOPTED, not duplicated", async () => {
    const w = new World();
    w.local.registry.push({
      id: "orphan-1", tenantId: COMPANY, domain: "acme-site.provisioned.invalid", origin: "provisioned", kind: "static",
      repoUrl: "x", clientId: null, projectId: null, contractVersion: null,
    });
    await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(w.local.registry).toHaveLength(1);
    expect(w.local.row.webdevSiteId).toBe("orphan-1");
  });

  it("a WebDesk slug owned by ANOTHER company is webdesk_tenant_slug_foreign: no tenant created, state stays registered", async () => {
    const w = new World();
    w.wdTenants.set("acme-site", OTHER_COMPANY);
    const r = await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(r).toMatchObject({ state: "registered", next: "tenant", advanced: ["register"], error: "webdesk_tenant_slug_foreign" });
    expect(w.tenantsCreated).toBe(0);
    expect(w.wdTenants.get("acme-site")).toBe(OTHER_COMPANY);
  });

  it("a transient WebDesk failure is recorded and the next call resends the same command", async () => {
    const w = new World();
    w.published.set("acme-site", "1.0.0");
    w.nextTenantAnswer = { outcome: "retry", reason: "webdesk_ambiguous" };
    const r1 = await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(r1).toMatchObject({ state: "registered", error: "webdesk_ambiguous" });
    expect(w.local.row.completionError).toBe("webdesk_ambiguous");
    const r2 = await advanceProvisionCompletion(w.ports(), COMPANY);
    expect(r2).toMatchObject({ state: "complete", error: null });
    expect(w.tenantsCreated).toBe(1);
  });

  it("files no approval of any kind: the ports have no approval operation, and the WebDesk command is the MEDIUM tenant.provision", () => {
    const keys = Object.keys(new World().ports()).sort();
    expect(keys).toEqual(["pinContract", "provisionTenant", "withLockedSite"]);
  });
});

describe("advanceProvisionCompletion — concurrent callers serialize on the site lock", () => {
  it("three racing advances: one registry row, one tenant request, one snapshot, one 'complete'", async () => {
    const w = new World();
    w.published.set("acme-site", "1.0.0");
    const results = await Promise.all([1, 2, 3].map(() => advanceProvisionCompletion(w.ports(), COMPANY)));
    expect(w.local.registry).toHaveLength(1);
    expect(w.tenantRequests).toBe(1); // sent INSIDE the lock
    expect(w.tenantsCreated).toBe(1);
    expect(w.snapshots.size).toBe(1); // a pin may run twice OUTSIDE the lock; the mirror is idempotent
    expect(w.local.events.filter((e) => e === "complete")).toHaveLength(1);
    expect(results.every((r) => r.state === "complete")).toBe(true);
    // Every step was finished by exactly one of the racers.
    expect(results.flatMap((r) => r.advanced).sort()).toEqual(["contract", "register", "tenant"]);
  });
});

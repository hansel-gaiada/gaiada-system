// WSK-21 — asserts COMMAND_REGISTRY (src/control/command-types.ts) matches design §07's
// impact-class table, restated for the actual C-05 command set this ticket builds. Pure — no
// database, no Nest bootstrap. See command-types.ts's own header for the two documented
// departures from §07's literal wording (schema.propose folded into `read`; job.get/job.list are
// this ticket's own addition).
import { describe, expect, it } from "vitest";
import { COMMAND_REGISTRY, EDITORIAL_COMMANDS, type CommandName, type CommandMeta } from "../src/control/command-types";

const EXPECTED: Record<CommandName, Omit<CommandMeta, "command">> = {
  "tenant.provision": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "tenant.archive": { impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "site.provision": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "site.archive": { impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "environment.provision": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "environment.archive": { impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "schema.propose": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  // WSK-33 — added because the P5 gate proved the ai-draft route ran NO Layer-3 scope check: it
  // carried no @Command metadata, so CommandAuthorizationGuard was disarmed and any authenticated
  // principal (even a scopeless one) could draft for any tenant. `read`/`webdesk:read` mirrors
  // schema.propose deliberately — a draft persists no domain row, but it does read a tenant's
  // schema and spend LLM budget, so it must still be scoped.
  "schema.aiDraft": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "schema.apply": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  // WSK-25 unification — promote/rollback are "high" specifically because that is what makes the
  // PolicyDecisionPoint demand a WS4 assertion, matching the old imperative `requireWs4: true`.
  "content.export": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "content.promote": { impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "content.rollback": { impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "key.mint": { impactClass: "high", scope: "webdesk:keys", jobTracked: false },
  "key.rotate": { impactClass: "high", scope: "webdesk:keys", jobTracked: false },
  "key.revoke": { impactClass: "high", scope: "webdesk:keys", jobTracked: false },
  "release.deploy": { impactClass: "medium", scope: "webdesk:operate", jobTracked: true },
  "release.promote": { impactClass: "high", scope: "webdesk:promote", jobTracked: true },
  "release.rollback": { impactClass: "high", scope: "webdesk:promote", jobTracked: true },
  "release.triggerRebuild": { impactClass: "medium", scope: "webdesk:operate", jobTracked: true },
  "job.get": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "job.list": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "contract.read": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  // M6-P4r-b -- queues contract-codegen runs (re-run + backfill); MEDIUM/operate like schema.apply.
  "contract.regenerate": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  // WSK-41 — write-plane design §3.1 and ruling WSK-D46: publish and schedule are HIGH for every
  // principal (always WS4); unpublish and delete are MEDIUM under promote (a takedown never waits
  // for a second person); draft writes are MEDIUM under operate.
  "content.create": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "content.update": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "content.restoreVersion": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "content.publish": { impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "content.schedule": { impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "content.unpublish": { impactClass: "medium", scope: "webdesk:promote", jobTracked: false },
  "content.delete": { impactClass: "medium", scope: "webdesk:promote", jobTracked: false },
  // WSK-46 — a preview token exposes unpublished content to whoever holds the link, so it is a MEDIUM
  // write (never a read), on the same scope as the other draft writes; the revoke shares it.
  "content.previewToken": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "content.previewTokenRevoke": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  // WSK-51 — design §4: every editor read is read/webdesk:read.
  "tenant.list": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "collection.list": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "collection.get": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "item.list": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "item.get": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "item.versions": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "item.versionGet": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "media.list": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  // WSK-43a — the media library: an upload token lets its holder put one file into the public library, so
  // minting is a MEDIUM write; update and delete are MEDIUM/operate (a delete is soft and refused while content
  // uses the asset); the usage list is a read.
  "media.uploadToken": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "media.update": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "media.delete": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "media.usage": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  // M5-L1/L2 — the ERP reads one submission back after a form.received fact: read / webdesk:read.
  "forms.submission.get": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
};

describe("control command registry — the impact-class map (design §07)", () => {
  it("has exactly the expected command set, no more, no fewer", () => {
    expect(Object.keys(COMMAND_REGISTRY).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [command, expected] of Object.entries(EXPECTED)) {
    it(`${command}: impactClass=${expected.impactClass} scope=${expected.scope} jobTracked=${expected.jobTracked}`, () => {
      const meta = COMMAND_REGISTRY[command as CommandName];
      expect(meta.command).toBe(command);
      expect(meta.impactClass).toBe(expected.impactClass);
      expect(meta.scope).toBe(expected.scope);
      expect(meta.jobTracked).toBe(expected.jobTracked);
    });
  }

  it("every HIGH-impact command uses webdesk:promote or webdesk:keys, never webdesk:read/operate (design §03 Layer 3/4)", () => {
    for (const meta of Object.values(COMMAND_REGISTRY)) {
      if (meta.impactClass === "high") {
        expect(["webdesk:promote", "webdesk:keys"]).toContain(meta.scope);
      }
    }
  });

  it("only release.* commands are job-tracked (deploy/promote/rollback/triggerRebuild — the C-05 'release' quarter)", () => {
    const jobTracked = Object.values(COMMAND_REGISTRY).filter((m) => m.jobTracked).map((m) => m.command);
    expect(jobTracked.sort()).toEqual(
      ["release.deploy", "release.promote", "release.rollback", "release.triggerRebuild"].sort(),
    );
  });

  it("EDITORIAL_COMMANDS is exactly the seven content.* writes (design §3.1), the two WSK-46 preview-token commands and the three WSK-43a media writes", () => {
    expect([...EDITORIAL_COMMANDS].sort()).toEqual(
      [
        "content.create",
        "content.update",
        "content.restoreVersion",
        "content.publish",
        "content.schedule",
        "content.unpublish",
        "content.delete",
        "content.previewToken",
        "content.previewTokenRevoke",
        "media.uploadToken",
        "media.update",
        "media.delete",
      ].sort(),
    );
  });

  it("publish and schedule are HIGH, unpublish and delete are MEDIUM (ruling WSK-D46)", () => {
    expect(COMMAND_REGISTRY["content.publish"].impactClass).toBe("high");
    expect(COMMAND_REGISTRY["content.schedule"].impactClass).toBe("high");
    expect(COMMAND_REGISTRY["content.unpublish"].impactClass).toBe("medium");
    expect(COMMAND_REGISTRY["content.delete"].impactClass).toBe("medium");
  });

  it("no editorial command is a read, and no read command is editorial", () => {
    for (const c of EDITORIAL_COMMANDS) expect(COMMAND_REGISTRY[c].impactClass).not.toBe("read");
    for (const meta of Object.values(COMMAND_REGISTRY)) {
      if (meta.impactClass === "read") expect(EDITORIAL_COMMANDS.has(meta.command)).toBe(false);
    }
  });
});

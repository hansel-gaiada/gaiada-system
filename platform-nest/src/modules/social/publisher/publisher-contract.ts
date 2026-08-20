// SMM-38/38a (design addendum §PD) — the `SocialPublisher` PORT's own contract suite.
//
// Before this ticket, the port's behavioural contract lived only inside `publisher.test.ts`,
// asserted against the Postiz driver and the mock. That made it a POSTIZ contract with a mock along
// for the ride, not a port contract — exactly the shape `registry.ts`'s `invokePublisher` header
// warns about for instrumentation ("the second driver forgot" is a silent hole nobody notices until
// an incident). Moving the behavioural assertions into a parameterized function that ANY driver can
// be run against is what makes them the port's property instead of one driver's: `direct`'s
// skeleton must pass the SAME suite `postiz` and the mock pass, and it does, because refusing
// honestly for everything it does not implement IS what this suite checks for.
//
// ── HOW A CAPABILITY GAP IS ASSERTED, NOT SKIPPED ───────────────────────────────────────────────
// Every case below reads the driver's OWN `capabilities` set before deciding what "correct" means
// for that driver, then asserts the honest-refusal branch when the capability is absent. That is
// the ticket's explicit instruction: "where the `direct` driver legitimately cannot satisfy a case
// yet, the suite must assert the typed refusal, not skip." A driver that lied about a capability
// (advertised it but did not implement it) would fail this suite by calling the "capable" branch
// and getting an untyped crash instead of the real result — which is exactly the failure mode this
// suite exists to catch, for every driver, forever.
import { describe, expect, it } from "vitest";
import { OrgHandle, SocialPublisherError, type SocialPublisher } from "./types";
import type { Network } from "../media-rules";

export interface PublisherContractSuiteOptions {
  /** Build a FRESH driver instance for each case. Invariant 2 of the port (types.ts's header):
   *  drivers are stateless per call, so a contract suite that reused one instance across cases
   *  would still be testing the real shape — but rebuilding is what lets each case start from a
   *  clean slate without the suite having to know any driver's internal state shape. */
  build: () => SocialPublisher;
  /** A plausible integration fixture. Drivers with no fixtures of their own (the `direct` skeleton,
   *  which refuses before ever looking at one) get a synthetic default. */
  integration?: { id: string; network: Network; handle: string };
}

const CONTRACT_ORG = new OrgHandle("row-contract", "org-contract", "contract-suite-key-never-logged");

async function expectTypedRefusal(promise: Promise<unknown>, label: string, code?: string): Promise<void> {
  try {
    await promise;
    throw new Error(`${label}: expected a refusal, but the call resolved`);
  } catch (err) {
    expect(err, label).toBeInstanceOf(SocialPublisherError);
    if (code) expect((err as SocialPublisherError).code, label).toBe(code);
  }
}

/** Run the port's contract against ONE driver. `label` names the driver in every case's title, so a
 *  failing case's output says which driver regressed without anyone opening this file. */
export function runPublisherContractSuite(label: string, opts: PublisherContractSuiteOptions): void {
  const integration = opts.integration ?? { id: "contract-integration", network: "instagram" as Network, handle: "@contract" };

  describe(`SMM-38 · SocialPublisher port contract — ${label}`, () => {
    it("advertises `key` and a real capabilities Set", () => {
      const d = opts.build();
      expect(typeof d.key).toBe("string");
      expect(d.capabilities).toBeInstanceOf(Set);
    });

    it("createOrg: capable ⇒ a real org id; incapable ⇒ typed capability_unsupported, never a crash", async () => {
      const d = opts.build();
      if (d.capabilities.has("org_create")) {
        const res = await d.createOrg({ name: "smm-38-contract-org" });
        expect(typeof res.orgId).toBe("string");
      } else {
        await expectTypedRefusal(d.createOrg({ name: "smm-38-contract-org" }), `${label}.createOrg`, "capability_unsupported");
      }
    });

    it("schedulePost: refuses honestly rather than half-publishing — approval_required if it can " +
       "schedule at all, capability_unsupported if it cannot schedule yet", async () => {
      const d = opts.build();
      const noApproval = {
        integrationId: integration.id, network: integration.network, body: "smm-38 contract case",
        approvalId: "", variantId: "v-contract",
      };
      const label2 = `${label}.schedulePost`;
      if (d.capabilities.has("schedule")) {
        await expectTypedRefusal(d.schedulePost(CONTRACT_ORG, noApproval), label2, "approval_required");
      } else {
        await expectTypedRefusal(d.schedulePost(CONTRACT_ORG, noApproval), label2, "capability_unsupported");
      }
    });

    it("listComments/sendReply: ABSENT exactly when the capability is absent — never present-but-throwing " +
       "(the exact P2 finding this ticket exists to generalise: an absence must be a fact, not a bug)", () => {
      const d = opts.build();
      expect(d.listComments !== undefined).toBe(d.capabilities.has("inbox_read"));
      expect(d.sendReply !== undefined).toBe(d.capabilities.has("inbox_reply"));
    });

    it("estimateCostUsd is pure, synchronous, and never throws", () => {
      const d = opts.build();
      expect(() => d.estimateCostUsd({ network: integration.network })).not.toThrow();
      expect(typeof d.estimateCostUsd({ network: integration.network })).toBe("number");
    });

    it("every other required member either does its job or refuses with a TYPED error — never an " +
       "untyped Error escaping the port (platform-nest's standing body-less-500 rule)", async () => {
      const d = opts.build();
      const calls: Array<[string, () => Promise<unknown>]> = [
        ["verifyOrg", () => d.verifyOrg(CONTRACT_ORG)],
        ["connectUrl", () => d.connectUrl(CONTRACT_ORG, integration.network, "https://example.invalid/callback")],
        ["listIntegrations", () => d.listIntegrations(CONTRACT_ORG)],
        ["getQuota", () => d.getQuota(CONTRACT_ORG, integration)],
        ["cancelPost", () => d.cancelPost(CONTRACT_ORG, "contract-post-id")],
        ["getPostStatus", () => d.getPostStatus(CONTRACT_ORG, ["contract-post-id"])],
        ["uploadMedia", () => d.uploadMedia(CONTRACT_ORG, { filename: "contract.png", contentType: "image/png", bytes: new Uint8Array() })],
        ["getAccountMetrics", () => d.getAccountMetrics(CONTRACT_ORG, integration.id, { from: "2026-01-01", to: "2026-01-02" })],
        ["getPostMetrics", () => d.getPostMetrics(CONTRACT_ORG, ["contract-post-id"])],
      ];
      if (d.getCreatorInfo) calls.push(["getCreatorInfo", () => d.getCreatorInfo!(CONTRACT_ORG, integration)]);

      for (const [op, call] of calls) {
        try {
          await call();
        } catch (err) {
          expect(err, `${label}.${op} threw an UNTYPED error`).toBeInstanceOf(SocialPublisherError);
        }
      }
    });
  });
}

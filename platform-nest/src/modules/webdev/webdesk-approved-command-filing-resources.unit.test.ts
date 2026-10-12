// M5-W1c — fileWebdeskCommandApproval's defence-in-depth authorization re-uses the attribute-carrying resources the caller built
// (`itemResources`). Service-free: `authorize` is a recorder, and every call is given `args: "bad"` so it stops right after the check.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import type { Principal } from "../../rbac/principal";
import type { Resource } from "../../rbac/cerbos";

const h = vi.hoisted(() => ({ asks: [] as Array<{ resource: Record<string, unknown>; action: string }>, denyOn: null as string | null }));
vi.mock("../../core/http", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../core/http")>();
  return {
    ...real,
    authorize: (async (_p: unknown, resource: Record<string, unknown>, action: string) => {
      h.asks.push({ resource: { ...resource }, action });
      if (h.denyOn !== null && resource.collectionKey === h.denyOn) throw new ForbiddenException("not authorized");
    }) as unknown as typeof real.authorize,
  };
});

import { fileWebdeskCommandApproval } from "./webdesk-approved-command";

const T = "aaaaaaaa-1111-0000-0000-000000000001";
const principal = { userId: "u1", assurance: "high", companies: [T], roles: [], sessionVersion: 1 } as unknown as Principal;
const res = (collectionKey: string): Resource => ({ kind: "webdesk_content_item", tenantId: T, module: "webdev", siteId: "s1", collectionKey, locale: "en", ownerId: "u1", reviewState: "draft", published: false });
const file = (command: "content.publish" | "key.mint", extra: Record<string, unknown> = {}) =>
  fileWebdeskCommandApproval(principal, T, { command, tenantSlug: "gaiada", siteId: "s1", args: "bad" as never, summary: { title: "t" }, ...extra } as never).catch((e) => e);

beforeEach(() => {
  h.asks.length = 0;
  h.denyOn = null;
});

describe("fileWebdeskCommandApproval · itemResources", () => {
  it("absent: the old attribute-free question, once", async () => {
    await file("content.publish");
    expect(h.asks).toEqual([{ resource: { kind: "webdesk_content_item", tenantId: T, module: "webdev" }, action: "request_publish" }]);
  });

  it("an EMPTY array is treated as absent, never as 'skip the check'", async () => {
    await file("content.publish", { itemResources: [] });
    expect(h.asks).toEqual([{ resource: { kind: "webdesk_content_item", tenantId: T, module: "webdev" }, action: "request_publish" }]);
  });

  it("present: the gate's action is asked on EACH given resource, and the attribute-free one is not asked", async () => {
    await file("content.publish", { itemResources: [res("post"), res("guide")] });
    expect(h.asks.map((a) => [a.action, a.resource.collectionKey])).toEqual([["request_publish", "post"], ["request_publish", "guide"]]);
    expect(h.asks.every((a) => a.resource.siteId === "s1" && a.resource.ownerId === "u1")).toBe(true);
  });

  it("a denial on any resource refuses the filing and stops there", async () => {
    h.denyOn = "post";
    const err = await file("content.publish", { itemResources: [res("post"), res("guide")] });
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(h.asks).toHaveLength(1);
  });

  it("a client filing keeps the clientId on every resource", async () => {
    await file("content.publish", { itemResources: [res("post"), res("guide")], client: { clientId: "c1" } });
    expect(h.asks.map((a) => a.resource.clientId)).toEqual(["c1", "c1"]);
  });

  it("key.mint ignores itemResources (its gate is another kind)", async () => {
    await file("key.mint", { itemResources: [res("post")] });
    expect(h.asks).toEqual([{ resource: { kind: "webdev_provisioned_site", tenantId: T, module: "webdev" }, action: "promote" }]);
  });
});

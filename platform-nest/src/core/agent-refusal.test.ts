// PV4-07 — the typed agent refusal (core/agent-refusal.ts), with `authorize()` stubbed so no database or Cerbos is needed.
// The end-to-end half (a real bot against real Cerbos, through the real routes) is conversation-agent-tools.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { Principal } from "../rbac/principal";

const authorizeMock = vi.fn();
vi.mock("./http", () => ({ authorize: (...a: unknown[]) => authorizeMock(...a) }));

import {
  AGENTS_CANNOT_MANAGE_CONVERSATION, AGENTS_DRAFT_STAFF_SEND, REFUSALS, authorizeOrRefuseAgent, isAgentPrincipal,
} from "./agent-refusal";

const principal = (kind: string) => ({ userId: "u1", kind } as unknown as Principal);
const resource = { kind: "conversation", tenantId: "t1" };
const CERBOS = "not authorized: cerbos denied post on conversation";

beforeEach(() => {
  authorizeMock.mockReset();
});

/** What the HTTP error filter reads off the exception: `{message, reason}` becomes `{error, reason}` on the wire. */
const bodyOf = (e: unknown) => (e as ForbiddenException).getResponse() as { message: string; reason?: string };

describe("PV4-07 · authorizeOrRefuseAgent", () => {
  it("the two agent kinds, and only they, are agents", () => {
    expect(isAgentPrincipal(principal("bot"))).toBe(true);
    expect(isAgentPrincipal(principal("automation"))).toBe(true);
    for (const k of ["employee", "client", "", "service"]) expect(isAgentPrincipal(principal(k)), k).toBe(false);
  });

  it("a denied bot gets a TYPED refusal naming the tool to use, with the Cerbos reason kept", async () => {
    authorizeMock.mockImplementation(async () => { throw new ForbiddenException(CERBOS); });
    const err = await authorizeOrRefuseAgent(principal("bot"), resource, "post", REFUSALS.post).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getStatus()).toBe(403);
    expect(bodyOf(err).reason).toBe(AGENTS_DRAFT_STAFF_SEND);
    expect(bodyOf(err).message).toContain("conversation.draftReply");
    expect(bodyOf(err).message).toContain("cerbos denied post on conversation");
  });

  it("an automation principal is refused the same way", async () => {
    authorizeMock.mockImplementation(async () => { throw new ForbiddenException(CERBOS); });
    const err = await authorizeOrRefuseAgent(principal("automation"), resource, "post", REFUSALS.sendDraft).catch((e) => e);
    expect(bodyOf(err).reason).toBe(AGENTS_DRAFT_STAFF_SEND);
  });

  it("each refusal names its alternative: post and send name draftReply, share names saveMinutes, manage has its own code", () => {
    expect(REFUSALS.post.message).toContain("conversation.draftReply");
    expect(REFUSALS.sendDraft.message).toContain("conversation.draftReply");
    expect(REFUSALS.shareMinutes.message).toContain("meetings.saveMinutes");
    expect(REFUSALS.manage.reason).toBe(AGENTS_CANNOT_MANAGE_CONVERSATION);
    expect(REFUSALS.manage.message).toContain("conversation.draftReply");
    for (const r of Object.values(REFUSALS)) expect(r.message.startsWith(`${r.reason}:`), r.reason).toBe(true);
  });

  it("a denied HUMAN keeps the ordinary refusal: the code is for agents, not a catch-all", async () => {
    const original = new ForbiddenException(CERBOS);
    authorizeMock.mockImplementation(async () => { throw original; });
    const err = await authorizeOrRefuseAgent(principal("employee"), resource, "post", REFUSALS.post).catch((e) => e);
    expect(err).toBe(original);
    expect(bodyOf(err).reason).toBeUndefined();
  });

  it("an allowed principal passes through untouched, agent or not (drafting is allowed to agents)", async () => {
    authorizeMock.mockResolvedValue(undefined);
    await expect(authorizeOrRefuseAgent(principal("bot"), resource, "draft", REFUSALS.post)).resolves.toBeUndefined();
    await expect(authorizeOrRefuseAgent(principal("employee"), resource, "post", REFUSALS.post)).resolves.toBeUndefined();
  });

  it("only a refusal is retyped: a revoked session (401) or any other error is rethrown as it was, even for an agent", async () => {
    const revoked = new UnauthorizedException("session revoked");
    authorizeMock.mockImplementation(async () => { throw revoked; });
    expect(await authorizeOrRefuseAgent(principal("bot"), resource, "post", REFUSALS.post).catch((e) => e)).toBe(revoked);
    const boom = new Error("cerbos unreachable");
    authorizeMock.mockImplementation(async () => { throw boom; });
    expect(await authorizeOrRefuseAgent(principal("bot"), resource, "post", REFUSALS.post).catch((e) => e)).toBe(boom);
  });
});

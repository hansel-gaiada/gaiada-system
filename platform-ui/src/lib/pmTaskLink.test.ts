import { describe, it, expect } from "vitest";
import { pickSocialDeptId, taskLinkTarget } from "./pmTaskLink";

// SCP-1n (BFF §63.13): where a PM task's link points in the Social Media department. Pure; the reads that feed it are in pmTaskLink-data.ts.
const POST = "11111111-1111-4111-8111-111111111111";
const CYCLE = "22222222-2222-4222-8222-222222222222";
const ENGAGEMENT = "33333333-3333-4333-8333-333333333333";

describe("pickSocialDeptId", () => {
  const depts = [{ id: "d-web", name: "Web Dev" }, { id: "d-soc", name: "Social Media" }, { id: "d-gm", name: "GM" }];

  it("finds the department whose workspace is Social Media, by the shell's own name match", () => {
    expect(pickSocialDeptId(depts, "agency")).toBe("d-soc");
  });

  it("is null when the company has none, and for an empty list", () => {
    expect(pickSocialDeptId([{ id: "d-web", name: "Web Dev" }], "agency")).toBeNull();
    expect(pickSocialDeptId([], "agency")).toBeNull();
  });
});

describe("taskLinkTarget", () => {
  it("a task linked to a social post links to the post page of the Social Media department", () => {
    expect(taskLinkTarget({ linkedType: "social_post", linkedId: POST }, { deptId: "d-soc" })).toEqual({
      href: `/departments/d-soc/posts/${POST}`, label: "Social post",
    });
  });

  it("the content-month task links to the client page (Profile) of the cycle's engagement", () => {
    expect(taskLinkTarget({ linkedType: "social_cycle", linkedId: CYCLE }, { deptId: "d-soc", engagementId: ENGAGEMENT })).toEqual({
      href: `/departments/d-soc/profile/${ENGAGEMENT}`, label: "Client's content month",
    });
  });

  it("a cycle step links to the Plan tab of the cycle's client, where the steps are drawn (SCP-5f)", () => {
    expect(taskLinkTarget({ linkedType: "social_cycle_step", linkedId: CYCLE }, { deptId: "d-soc", engagementId: ENGAGEMENT })).toEqual({
      href: `/departments/d-soc/profile/${ENGAGEMENT}?tab=plan`, label: "Client's monthly step",
    });
    expect(taskLinkTarget({ linkedType: "social_cycle_step", linkedId: CYCLE }, { deptId: "d-soc" })).toBeNull();
  });

  it("a content-month task whose client is not known has no link (the cycle id is not a page)", () => {
    expect(taskLinkTarget({ linkedType: "social_cycle", linkedId: CYCLE }, { deptId: "d-soc" })).toBeNull();
    expect(taskLinkTarget({ linkedType: "social_cycle", linkedId: CYCLE }, { deptId: "d-soc", engagementId: null })).toBeNull();
  });

  it("no link, half a link, or no Social Media department is no target", () => {
    expect(taskLinkTarget({}, { deptId: "d-soc" })).toBeNull();
    expect(taskLinkTarget({ linkedType: null, linkedId: null }, { deptId: "d-soc" })).toBeNull();
    expect(taskLinkTarget({ linkedType: "social_post", linkedId: null }, { deptId: "d-soc" })).toBeNull();
    expect(taskLinkTarget({ linkedType: "social_post", linkedId: POST }, { deptId: null })).toBeNull();
  });

  it("encodes the ids it puts in a path", () => {
    expect(taskLinkTarget({ linkedType: "social_post", linkedId: "a/b" }, { deptId: "d s" })?.href).toBe("/departments/d%20s/posts/a%2Fb");
  });
});

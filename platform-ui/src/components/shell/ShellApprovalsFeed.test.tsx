import { describe, it, expect } from "vitest";
import type { ApprovalsResult } from "@/lib/approvals";
import { ShellApprovalsFeed } from "./ShellApprovalsFeed";

// The streamed child of the (app) layout (DW-9d): it awaits the early-started read and hands the client provider `{ pending }`, or null when
// the read was unavailable. (The async server component is called directly: jsdom's client React cannot render it.)
const item = (decidable: boolean) => ({ decidable }) as ApprovalsResult["envelope"]["items"][number];
const result = (items: ReturnType<typeof item>[], unavailable = false): ApprovalsResult => ({ envelope: { items, companies: [] }, unavailable });
const readOf = async (p: Promise<ApprovalsResult>) => (await ShellApprovalsFeed({ read: p })).props.read;

describe("ShellApprovalsFeed", () => {
  it("counts only the items that wait on this person's own decision", async () => {
    expect(await readOf(Promise.resolve(result([item(true), item(false), item(true)])))).toEqual({ pending: 2 });
  });

  it("hands over 0 for an empty inbox, which is a real answer", async () => {
    expect(await readOf(Promise.resolve(result([])))).toEqual({ pending: 0 });
  });

  it("hands over null for an unavailable read, so the row stays shown", async () => {
    expect(await readOf(Promise.resolve(result([], true)))).toBeNull();
  });

  it("treats a read that rejects as unavailable, never as an error page", async () => {
    expect(await readOf(Promise.reject(new Error("boom")))).toBeNull();
  });
});

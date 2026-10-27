import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// SCP-1e (plan §6.3): the post drawer. A client-side navigation to `{D}/posts/[postId]` from any list is intercepted into a slide-over (the `@drawer` slot, the TaskDrawer
// pattern); closing is `router.back()`, so the list is exactly as it was. Next's interception itself needs a running app (sumopod's e2e); what is proved here is what is ours:
// the shell closes by going back (Escape, the scrim, the button), never by pushing; it traps focus; an action dialog inside it owns Escape while it is open; and the two route
// files (the full page and the intercepting one) exist where Next needs them, and mount the same `PostView`.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

const nav = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/collabActions", () => ({ postEntityComment: vi.fn() }));
vi.mock("@/lib/socialPipelineActions", () => ({
  runPostAction: vi.fn(), savePostFields: vi.fn(), saveSuggestion: vi.fn(), dropSuggestion: vi.fn(), addPostDesign: vi.fn(), removePostDesign: vi.fn(),
}));

import { PIPE_POSTS, demoPipelineRead } from "@/lib/demoSocialPipeline";
import { asPipelinePost } from "@/lib/socialPipeline";
import { PostDrawer } from "./PostDrawer";
import { PostPage } from "./PostPage";

const SRC = resolve(__dirname, "../..");
const read = (rel: string): string => readFileSync(resolve(SRC, rel), "utf8");

beforeEach(() => { vi.clearAllMocks(); document.body.style.overflow = ""; });

describe("the drawer shell", () => {
  const mount = () => render(<PostDrawer><button type="button">First</button><button type="button">Second</button></PostDrawer>);

  it("is a labelled modal dialog, and every way out is router.back(), never a push", () => {
    mount();
    expect(screen.getByRole("dialog", { name: "Post" })).toHaveAttribute("aria-modal", "true");
    fireEvent.click(screen.getByRole("button", { name: "Close the post panel" }));
    expect(nav.back).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close post" })); // the scrim
    expect(nav.back).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(nav.back).toHaveBeenCalledTimes(3);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("locks the page behind it and gives the scroll back on close", () => {
    const { unmount } = mount();
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("wraps Tab at the last focusable element back to the first (the panel's own Close button)", () => {
    mount();
    screen.getByRole("button", { name: "Second" }).focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(within(screen.getByRole("dialog")).getByRole("button", { name: "Close the post panel" }));
  });

  it("leaves Escape to an open dialog inside it: the dialog closes, the drawer stays", () => {
    render(<PostDrawer><div className="ov-modal-layer" /></PostDrawer>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(nav.back).not.toHaveBeenCalled();
  });
});

describe("the post page inside the drawer", () => {
  it("Escape closes an action dialog first and the drawer only on the second press", () => {
    const p = PIPE_POSTS.find((x) => x.title === "Staff pick of the week")!;
    const post = asPipelinePost(demoPipelineRead(p.id, "u-social").json);
    render(<PostDrawer><PostPage deptId="dept-4" post={post} comments={[]} assets={[]} demo chrome="drawer" /></PostDrawer>);
    fireEvent.click(within(screen.getByRole("region", { name: "Actions" })).getByRole("button", { name: "Block" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(2); // the drawer and the block dialog
    fireEvent.keyDown(document, { key: "Escape" });
    expect(nav.back).not.toHaveBeenCalled();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(nav.back).toHaveBeenCalledTimes(1);
  });
});

describe("the routes", () => {
  it("the post has a full page at {D}/posts/[postId] and an intercepting route in the @drawer slot, both mounting PostView", () => {
    const page = "app/(app)/departments/[deptId]/posts/[postId]/page.tsx";
    const drawer = "app/(app)/@drawer/(.)departments/[deptId]/posts/[postId]/page.tsx";
    expect(existsSync(resolve(SRC, page)), page).toBe(true);
    expect(existsSync(resolve(SRC, drawer)), drawer).toBe(true);
    expect(existsSync(resolve(SRC, "app/(app)/@drawer/default.tsx"))).toBe(true); // the slot's default, so a hard load of any page does not 404
    const full = read(page);
    const slide = read(drawer);
    expect(full).toContain('<PostView deptId={deptId} postId={postId} chrome="page" />');
    expect(slide).toContain('chrome="drawer"');
    expect(slide).toContain("<PostDrawer>");
    expect(slide).toContain("<PostView ");
    // the body, not the route, is suspended, so the drawer's chrome flushes at once (the note in the task drawer's route)
    expect(slide).toContain("<Suspense");
  });

  it("the page is not a menu row: it has no registry row and is in the department's own area", async () => {
    const { areaFor } = await import("@/lib/areas");
    expect(areaFor("/departments/dept-4/posts/post-1")).toMatchObject({ kind: "workspace" });
    expect(areaFor("/departments/dept-4/composer/post-1")).toMatchObject({ kind: "workspace" });
    const { WORKSPACES } = await import("@/lib/workspaces");
    const social = WORKSPACES.find((w) => w.key === "social-media")!;
    for (const row of social.work) expect(row.key).not.toBe("posts");
  });
});

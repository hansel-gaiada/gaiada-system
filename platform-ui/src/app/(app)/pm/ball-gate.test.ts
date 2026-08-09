import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { BALL_GATE_CAPABILITY } from "./page-helpers";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

// P4-B6 / owner decision 2026-08-06 ("anyone can pass the ball"): the write path
// (`reassignBall` in lib/pmActions.ts) submits its PATCH gated on `pm.contribute`, mirroring
// Cerbos's `pm_task:update` grant — rbac.test.ts's "pm.contribute mirrors Cerbos pm_task:update"
// suite already pins THAT half of the chain (`pm.contribute` <-> Cerbos). This file pins the
// OTHER half: the `/pm` page's own Ball-tab rendering gate (`BALL_GATE_CAPABILITY`, wired into
// `canPassBall` in page.tsx) must ask for the SAME capability the write path actually enforces.
//
// A previous version of this page passed the Board/Gantt tabs' `pm.manage`-derived `canEdit` into
// BallSection too — the drag itself was never blocked (Board has no such prop) but the empty-state
// note told a plain `member` (who genuinely holds `pm.contribute`, not `pm.manage`) that passing
// the ball needed access they didn't have. That silently undid "anyone can pass the ball" at the
// messaging layer even though the mechanism underneath already worked — this suite fails if that
// drift, or its mirror image (the write path drifting away from the rendering gate), recurs.
describe("Ball tab's gate matches the server's actual write-path capability", () => {
  it("BALL_GATE_CAPABILITY is pm.contribute, not pm.manage", () => {
    expect(BALL_GATE_CAPABILITY).toBe("pm.contribute");
  });

  it("reassignBall (lib/pmActions.ts) sends its PATCH gated on exactly BALL_GATE_CAPABILITY", () => {
    const src = read("../../../lib/pmActions.ts");
    const start = src.indexOf("export async function reassignBall");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("export async function reassignResponsible", start);
    expect(end).toBeGreaterThan(start);
    const fnBody = src.slice(start, end);

    // Extract the capability literal actually passed to `send(...)` for this write — not just
    // "some truthy call happened", the real fourth argument.
    const sendCall = fnBody.match(/send\(\s*`\/pm\/tasks\/\$\{taskId\}`,\s*"PATCH",\s*\{\s*assignee\s*\},\s*"([^"]+)"\s*\)/);
    expect(sendCall, "reassignBall's send(...) call shape changed — update this test's regex, then re-check the capability by hand").not.toBeNull();
    expect(sendCall![1]).toBe(BALL_GATE_CAPABILITY);
  });

  it("page.tsx wires BALL_GATE_CAPABILITY — not a hardcoded pm.manage — into the Ball tab's canPassBall", () => {
    const src = read("./page.tsx");
    expect(src).toMatch(/const canPassBall = can\(me, BALL_GATE_CAPABILITY, tenant\);/);

    // BallSection must receive canPassBall; it must NOT receive Board/Gantt's canEdit (that was
    // exactly the bug — the manage-tier flag leaking into the contribute-tier tab).
    const ballCallStart = src.indexOf("<BallSection");
    expect(ballCallStart).toBeGreaterThan(-1);
    const ballCall = src.slice(ballCallStart, src.indexOf("/>", ballCallStart));
    expect(ballCall).toContain("canPassBall={canPassBall}");
    expect(ballCall).not.toContain("canEdit={canEdit}");

    // BoardSection/GanttSection are untouched — their writes ARE manage-gated, so they must keep
    // using `canEdit`, not accidentally get downgraded to the ball's capability.
    const boardCallStart = src.indexOf("<BoardSection");
    const boardCall = src.slice(boardCallStart, src.indexOf("/>", boardCallStart));
    expect(boardCall).toContain("canEdit={canEdit}");
    const ganttCallStart = src.indexOf("<GanttSection");
    const ganttCall = src.slice(ganttCallStart, src.indexOf("/>", ganttCallStart));
    expect(ganttCall).toContain("canEdit={canEdit}");
  });
});

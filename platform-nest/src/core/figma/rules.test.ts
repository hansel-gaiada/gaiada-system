// DW-6k (docs/FRONTEND-BFF-CONTRACT.md §36.7) — the pure rules: the open-comment count, the ten-minute cache age, the title,
// the export body and the file name. No database, no Cerbos, no network, no clock (every `now` is passed in).
import { describe, it, expect } from "vitest";
import type { FigmaComment } from "./client";
import {
  CACHE_TTL_MS, FORMAT_CONTENT_TYPE, FigmaRuleError, countOpenComments, exportFileName, figmaTitle, isCacheDue,
  parseExportBody, parseTargetKind,
} from "./rules";

// Trimmed from the shapes Figma documents for GET /v1/files/{key}/comments (the Comment schema): a pin on bare canvas is a
// Vector, a pin on a frame is a FrameOffset (node_id + node_offset), and `resolved_at` is a time or null.
const canvas = (id: string, over: Partial<FigmaComment> = {}): FigmaComment => ({
  id, created_at: "2026-10-01T09:00:00Z", resolved_at: null, client_meta: { x: 10, y: 20 }, ...over,
});
const onFrame = (id: string, nodeId: string, over: Partial<FigmaComment> = {}): FigmaComment => ({
  id, created_at: "2026-10-01T09:00:00Z", resolved_at: null, client_meta: { node_id: nodeId, node_offset: { x: 1, y: 2 } }, ...over,
});

describe("countOpenComments", () => {
  it("a whole-file link counts every open thread, on a frame or on bare canvas", () => {
    const cs = [onFrame("1", "1:2"), onFrame("2", "9:9"), canvas("3")];
    expect(countOpenComments(cs, null)).toBe(3);
  });

  it("a resolved thread is not open, whether resolved_at is set or merely absent", () => {
    const cs = [
      onFrame("1", "1:2", { resolved_at: "2026-10-02T10:00:00Z" }),
      onFrame("2", "1:2"),
      onFrame("3", "1:2", { resolved_at: undefined }),
    ];
    expect(countOpenComments(cs, "1:2")).toBe(2); // 2 (null) and 3 (absent) are open; 1 is resolved
    expect(countOpenComments(cs.slice(0, 1), "1:2")).toBe(0);
  });

  it("a link naming a frame counts only comments pinned to exactly that frame (on-node vs off-node)", () => {
    const cs = [onFrame("1", "1:2"), onFrame("2", "1:3"), onFrame("3", "11:2"), canvas("4")];
    expect(countOpenComments(cs, "1:2")).toBe(1);
    expect(countOpenComments(cs, "1:3")).toBe(1);
    expect(countOpenComments(cs, "7:7")).toBe(0);
  });

  it("a region comment pinned to a frame is on that frame; a region on bare canvas is off every frame", () => {
    const region: FigmaComment = canvas("r", { client_meta: { x: 0, y: 0, region_height: 5, region_width: 5 } });
    const frameRegion: FigmaComment = canvas("fr", {
      client_meta: { node_id: "1:2", node_offset: { x: 0, y: 0 }, region_height: 5, region_width: 5 },
    });
    expect(countOpenComments([region, frameRegion], "1:2")).toBe(1);
    expect(countOpenComments([region, frameRegion], null)).toBe(2);
  });

  it("a reply (parent_id set) is not a thread: it never counts, even when it carries no resolved_at", () => {
    const cs = [onFrame("1", "1:2", { resolved_at: "2026-10-02T10:00:00Z" }), onFrame("2", "1:2", { parent_id: "1" })];
    expect(countOpenComments(cs, "1:2")).toBe(0);
    expect(countOpenComments(cs, null)).toBe(0);
  });

  it("no comments is zero, and that zero is a real count (the caller never reaches here on a failure)", () => {
    expect(countOpenComments([], "1:2")).toBe(0);
    expect(countOpenComments([], null)).toBe(0);
  });
});

describe("isCacheDue (§36.3: refresh when older than ten minutes)", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("never cached is due", () => {
    expect(isCacheDue(null, now)).toBe(true);
    expect(isCacheDue(undefined, now)).toBe(true);
  });

  it("fresh is not due; exactly ten minutes is still fresh; one millisecond more is due", () => {
    expect(isCacheDue(ago(0), now)).toBe(false);
    expect(isCacheDue(ago(9 * 60 * 1000 + 59_000), now)).toBe(false);
    expect(isCacheDue(ago(CACHE_TTL_MS), now)).toBe(false);
    expect(isCacheDue(ago(CACHE_TTL_MS + 1), now)).toBe(true);
    expect(isCacheDue(ago(11 * 60 * 1000), now)).toBe(true);
  });

  it("a cache time in the future is fresh, never a reason to call Figma on every read", () => {
    expect(isCacheDue(new Date(now.getTime() + 60_000), now)).toBe(false);
  });

  it("an ISO string works, and an unparseable value is due", () => {
    expect(isCacheDue(ago(60_000).toISOString(), now)).toBe(false);
    expect(isCacheDue(ago(CACHE_TTL_MS + 5000).toISOString(), now)).toBe(true);
    expect(isCacheDue("not a date", now)).toBe(true);
  });

  it("the ttl is ten minutes", () => {
    expect(CACHE_TTL_MS).toBe(600_000);
  });
});

describe("figmaTitle", () => {
  it("the file name alone, or the file name and the frame name", () => {
    expect(figmaTitle("Brand Kit", null)).toBe("Brand Kit");
    expect(figmaTitle("Brand Kit", "Hero banner")).toBe("Brand Kit / Hero banner");
    expect(figmaTitle("  Brand Kit ", "  ")).toBe("Brand Kit");
  });
  it("nothing known is null, never an empty string", () => {
    expect(figmaTitle(null, null)).toBeNull();
    expect(figmaTitle("", " ")).toBeNull();
    expect(figmaTitle(null, "Hero")).toBe("Hero");
  });
});

describe("parseExportBody (§36.4)", () => {
  it("png, svg and pdf, scale defaulting to 1", () => {
    expect(parseExportBody({ format: "png" })).toEqual({ format: "png", scale: 1 });
    expect(parseExportBody({ format: "svg", scale: 2 })).toEqual({ format: "svg", scale: 2 });
    expect(parseExportBody({ format: "pdf", scale: 3 })).toEqual({ format: "pdf", scale: 3 });
    expect(parseExportBody({ format: "png", scale: null })).toEqual({ format: "png", scale: 1 });
  });

  it.each<[string, unknown, string]>([
    ["no body", undefined, "format"],
    ["an array", [], "format"],
    ["a missing format", {}, "format"],
    ["jpg (Figma has it, §36.4 does not)", { format: "jpg" }, "format"],
    ["an upper-case format", { format: "PNG" }, "format"],
    ["a numeric format", { format: 1 }, "format"],
    ["scale 4 (Figma allows it, §36.4 does not)", { format: "png", scale: 4 }, "scale"],
    ["scale 1.5", { format: "png", scale: 1.5 }, "scale"],
    ["scale as a string", { format: "png", scale: "2" }, "scale"],
  ])("refuses %s with bad_export", (_label, body, field) => {
    let err: unknown;
    try {
      parseExportBody(body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FigmaRuleError);
    const e = err as FigmaRuleError;
    expect(e.httpStatus).toBe(400);
    expect(e.token).toBe("bad_export");
    expect(e.field).toBe(field);
    expect(e.message.startsWith("bad_export:")).toBe(true);
  });

  it("each format has its own content type", () => {
    expect(FORMAT_CONTENT_TYPE).toEqual({ png: "image/png", svg: "image/svg+xml", pdf: "application/pdf" });
  });
});

describe("exportFileName", () => {
  it("the title plus the format's extension", () => {
    expect(exportFileName("Brand Kit / Hero banner", "png")).toBe("Brand Kit Hero banner.png");
    expect(exportFileName(null, "pdf")).toBe("Figma design.pdf");
  });
  it("no path or control characters, bounded in length", () => {
    expect(exportFileName("../../etc/passwd", "svg")).toBe(".. .. etc passwd.svg");
    expect(exportFileName("a\u0000b\u001fc", "png")).toBe("a b c.png");
    expect(exportFileName("x".repeat(500), "png").length).toBe(120 + 4);
    expect(exportFileName("///", "png")).toBe("Figma design.png");
  });
});

describe("parseTargetKind", () => {
  it("accepts the three kinds and refuses the rest with field targetKind", () => {
    for (const k of ["pm_task", "work_request", "campaign_part"]) expect(parseTargetKind(k)).toBe(k);
    for (const bad of ["task", "agency_campaign_part", "", null, undefined, 3]) {
      expect(() => parseTargetKind(bad)).toThrow(FigmaRuleError);
    }
  });
});

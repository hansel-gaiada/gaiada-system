import { describe, it, expect } from "vitest";
import { addRefusalText, formatFileSize, readFailureText } from "./fileUpload";

describe("fileUpload (DW-8h)", () => {
  it("words a refused add by target and status", () => {
    expect(addRefusalText(403, "work_request", "forbidden")).toBe("Only the people on this request can add files.");
    expect(addRefusalText(403, "agency_campaign_part", "forbidden")).toBe("You can't add files here.");
    expect(addRefusalText(404, "work_request", "target_not_found")).toBe("This item no longer exists.");
    expect(addRefusalText(409, "work_request", "target_closed")).toBe("This item is closed, so it takes no new files.");
    expect(addRefusalText(409, "invoice", "a file with a role cannot be deleted")).toBeNull();
    expect(addRefusalText(500, "work_request", "boom")).toBeNull();
  });
  it("words a failed read", () => {
    expect(readFailureText("forbidden")).toBe("You can't see this item's files.");
    expect(readFailureText("unavailable", "target_not_found")).toBe("This item no longer exists.");
    expect(readFailureText("unavailable", "timeout")).toBe("Files can't be read right now.");
  });
  it("formats sizes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(900)).toBe("900 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("formatFileSize takes the bigint the platform sends as a string", () => {
  it("formats numeric strings like numbers, and anything else as 0 B", () => {
    expect(formatFileSize("47")).toBe("47 B");
    expect(formatFileSize("5242880")).toBe("5.0 MB");
    expect(formatFileSize("")).toBe("0 B");
    expect(formatFileSize("x")).toBe("0 B");
  });
});

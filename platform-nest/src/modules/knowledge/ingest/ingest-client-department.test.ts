// AIP-11: the writer-side client sends the document's department to the knowledge service in the /ingest body, and always
// sends the key (null when there is none), because the store rewrites the column on every ingest: that is what clears a record
// that left its department and what lets the first sweep after the column appeared stamp the rows it keeps. Pure: fetch is stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { config } from "../../../config";
import { ingestDocument } from "./ingest-client";
import type { IngestDocument } from "./types";

const base: IngestDocument = {
  tenantId: "aaaaaaaa-0000-4000-8000-000000000001",
  sourceRef: "erp:project:p1",
  audience: "internal",
  chunks: ["Project: Rankings\n\nStatus: active"],
  label: "Project Rankings",
};

describe("ingestDocument sends departmentId", () => {
  const bodies: Array<Record<string, unknown>> = [];
  let prev: typeof config.services.knowledge;

  beforeEach(() => {
    bodies.length = 0;
    prev = config.services.knowledge;
    config.services.knowledge = { url: "http://knowledge.test", token: "k-token" };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ written: 1 }), { status: 200 });
    }));
  });
  afterEach(() => {
    config.services.knowledge = prev;
    vi.unstubAllGlobals();
  });

  it("puts the department in the body, beside (not inside) the chunks", async () => {
    await ingestDocument({ ...base, departmentId: "d-seo" });
    expect(bodies[0].departmentId).toBe("d-seo");
    expect(bodies[0].chunks).toEqual(base.chunks); // the text is exactly what the builder rendered
  });

  it("sends an explicit null when the record has no department", async () => {
    await ingestDocument(base);
    expect(Object.prototype.hasOwnProperty.call(bodies[0], "departmentId")).toBe(true);
    expect(bodies[0].departmentId).toBeNull();
    await ingestDocument({ ...base, departmentId: null });
    expect(bodies[1].departmentId).toBeNull();
  });
});

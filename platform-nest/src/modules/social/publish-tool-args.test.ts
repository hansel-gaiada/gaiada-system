// The publish tools accept the args the publish path FILES (found live 2026-10-28 on the SCP-S walk).
//
// A D14 publish approval stores `variantPublishArgs(...)` (canonical-args.ts) as its tool args, and the executor re-drives
// exactly those args through the MCP hub, whose validator (mcp-hub/src/validate-args.ts) checks each value against the
// tool's declared `type`. canonical-args keeps a missing first comment and an unscheduled variant as EXPLICIT nulls (so the
// hash never depends on the path that built it), while both publish tools declared those two fields as plain "string":
// every pipeline post without a first comment was refused at re-drive with `firstComment: expected string, got null`.
// The route tests never saw it because their executor stub calls the dispatch directly, skipping the hub's validator.
// This pins the two sides together: every key the canonical args can carry, with every shape it can take, is a type the
// tool declares.
import { describe, expect, it } from "vitest";
import { socialModule } from "./index";
import { variantPublishArgs } from "./canonical-args";
import { SOCIAL_PUBLISH_METERED_TOOL, SOCIAL_PUBLISH_TOOL } from "./publish-precondition";

type Schema = { type?: string | string[]; properties?: Record<string, Schema> };

/** The hub's notion of a JSON value's type (validate-args.ts `typeOf`): null and arrays are their own types. */
function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;
}

function declared(schema: Schema | undefined): string[] {
  if (!schema?.type) return [];
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function toolSchema(name: string): Schema {
  const tool = (socialModule.mcpTools ?? []).find((t: { name: string }) => t.name === name) as { inputSchema: Schema } | undefined;
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return tool.inputSchema;
}

// The shapes the publish path files: a pipeline variant built from the master caption has no first comment, and a
// variant can be filed before it carries a date. Each must pass the tool's declared types.
const SHAPES = {
  "no first comment, scheduled": variantPublishArgs({
    tenantId: "t", id: "v", accountId: "a", body: "A caption #mock", firstComment: null,
    media: [{ fileId: "f", kind: "image", alt: "" }], settings: {}, scheduledAt: new Date("2026-11-03T02:00:00Z"),
  }),
  "first comment, unscheduled": variantPublishArgs({
    tenantId: "t", id: "v", accountId: "a", body: "A caption", firstComment: "#mock #tags", media: [], settings: {}, scheduledAt: null,
  }),
  "everything omitted": variantPublishArgs({ tenantId: "t", id: "v", accountId: "a", body: "" }),
};

describe("the publish tools accept the canonical args the publish path files", () => {
  for (const name of [SOCIAL_PUBLISH_TOOL, SOCIAL_PUBLISH_METERED_TOOL]) {
    for (const [label, args] of Object.entries(SHAPES)) {
      it(`${name}: ${label}`, () => {
        const props = toolSchema(name).properties ?? {};
        const refused = Object.entries(args)
          .filter(([key, value]) => {
            const types = declared(props[key]);
            // An undeclared key is not this test's concern (the hub has its own rule for those); a declared one must match.
            return types.length > 0 && !types.includes(typeOf(value)) && !(typeOf(value) === "integer" && types.includes("number"));
          })
          .map(([key, value]) => `${key}: declared ${declared(props[key]).join("|")}, filed ${typeOf(value)}`);
        expect(refused).toEqual([]);
      });
    }
  }

  it("every key the canonical args carry is declared by both tools, so none is silently unchecked", () => {
    for (const name of [SOCIAL_PUBLISH_TOOL, SOCIAL_PUBLISH_METERED_TOOL]) {
      const props = toolSchema(name).properties ?? {};
      expect(Object.keys(SHAPES["everything omitted"]).filter((k) => !(k in props))).toEqual([]);
    }
  });
});

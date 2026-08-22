import { describe, it, expect } from "vitest";
import {
  currentAxisValue, isAxisDefault, activeAxisCount, scopeHref, resetScopeHref, axisHref, wholeGroupOption,
  type ScopeAxisConfig,
} from "./scope";

const entity: ScopeAxisConfig = {
  key: "entity",
  param: "entity",
  label: "Entity",
  defaultValue: "all",
  options: [wholeGroupOption(), { value: "co-1", label: "Company One" }, { value: "co-2", label: "Company Two" }],
};

const period: ScopeAxisConfig = {
  key: "period",
  param: "period",
  label: "Period",
  defaultValue: "this-month",
  options: [{ value: "this-month", label: "This month" }, { value: "last-month", label: "Last month" }],
};

describe("scope axis state", () => {
  it("currentAxisValue falls back to the declared default when the param is absent", () => {
    expect(currentAxisValue({}, entity)).toBe("all");
    expect(currentAxisValue({ entity: "co-1" }, entity)).toBe("co-1");
  });

  it("entity axis always has an explicit Whole group option", () => {
    expect(entity.options[0]).toEqual({ value: "all", label: "Whole group" });
  });

  it("isAxisDefault / activeAxisCount", () => {
    expect(isAxisDefault({}, entity)).toBe(true);
    expect(isAxisDefault({ entity: "co-1" }, entity)).toBe(false);
    expect(activeAxisCount({ entity: "co-1", period: "this-month" }, [entity, period])).toBe(1);
    expect(activeAxisCount({ entity: "co-1", period: "last-month" }, [entity, period])).toBe(2);
    expect(activeAxisCount({}, [entity, period])).toBe(0);
  });

  it("scopeHref preserves unrelated query params and applies the patch", () => {
    const href = scopeHref("/rollups", { q: "keep-me", entity: "all" }, { entity: "co-1" });
    expect(href).toContain("/rollups?");
    expect(href).toContain("q=keep-me");
    expect(href).toContain("entity=co-1");
  });

  it("scopeHref with a null patch value removes the param instead of writing the literal default", () => {
    const href = scopeHref("/rollups", { entity: "co-1" }, { entity: null });
    expect(href).toBe("/rollups");
  });

  it("axisHref collapses setting a value equal to the default into a clean URL", () => {
    expect(axisHref("/rollups", { entity: "co-1" }, entity, "all")).toBe("/rollups");
    expect(axisHref("/rollups", {}, entity, "co-2")).toBe("/rollups?entity=co-2");
  });

  it("resetScopeHref clears every given axis and nothing else", () => {
    const href = resetScopeHref("/rollups", { entity: "co-1", period: "last-month", q: "keep-me" }, [entity, period]);
    expect(href).toBe("/rollups?q=keep-me");
  });

  it("scopeHref with no params left produces a bare basePath", () => {
    expect(scopeHref("/rollups", {}, {})).toBe("/rollups");
  });

  it("handles a repeated-key searchParams array by taking the first value", () => {
    expect(currentAxisValue({ entity: ["co-1", "co-2"] }, entity)).toBe("co-1");
  });
});

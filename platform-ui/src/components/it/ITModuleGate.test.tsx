import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// DW-7h: IT accounts and IT > Network (Connected, Sign-ins, Alerts, Blocks) work with the `it` module off, because their routes are
// not module-gated (BFF §52). Everything else under /it is still ModuleDisabled.
const nav = vi.hoisted(() => ({ pathname: "/it" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));
vi.mock("@/components/ModuleDisabled", () => ({ ModuleDisabled: () => <p>IT module disabled</p> }));

import { ITModuleGate } from "./ITModuleGate";

const show = (pathname: string, moduleOn: boolean) => {
  nav.pathname = pathname;
  return render(<ITModuleGate moduleOn={moduleOn}><p>the page</p></ITModuleGate>);
};

describe("ITModuleGate", () => {
  it("shows every page when the module is on", () => {
    show("/it/devices", true);
    expect(screen.getByText("the page")).toBeInTheDocument();
  });

  it.each(["/it/accounts", "/it/network", "/it/network/presence", "/it/network/threats", "/it/network/rules"])(
    "keeps %s open with the module off",
    (path) => {
      show(path, false);
      expect(screen.getByText("the page")).toBeInTheDocument();
    },
  );

  it.each(["/it", "/it/devices", "/it/topology", "/it/workflows", "/it/networking"])("gates %s with the module off", (path) => {
    show(path, false);
    expect(screen.getByText("IT module disabled")).toBeInTheDocument();
    expect(screen.queryByText("the page")).toBeNull();
  });
});

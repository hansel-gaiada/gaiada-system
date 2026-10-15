import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CustomiseOverview } from "./CustomiseOverview";
import { selectCustomisable, subjectOfRef, type OverviewSubject } from "@/lib/overview";
import { resolveMyWorkspaces } from "@/lib/workspaceAccess";
import { agencyTree, me, member } from "@/lib/workspaceFixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {} }),
  usePathname: () => "/departments/d-web",
  useSearchParams: () => new URLSearchParams(),
}));

// DW-10d (DW-D34): the Customise control. A closed disclosure at the end of the header row: each band's blocks the person could see, the
// state each is in and one form button to change it. A fixed block is not a choice, so it is not listed (the intro says Needs you stays).

const made = { ...me([member()]), name: "Made Putra" };
const placed = resolveMyWorkspaces({ me: made, tenantId: "co-a", root: agencyTree({ frontend: ["u-1"] }) });
const webDev = subjectOfRef(placed.mine[0]);
const ctx = { me: made, tenantId: "co-a", unitPath: webDev.unitPath };

const SUBJECT: OverviewSubject = {
  ...webDev,
  widgets: [
    { key: "needs-you", band: "now", label: "Needs you", placement: "fixed" },
    { key: "today", band: "now", label: "Today" },
    { key: "my-activity", band: "you", label: "My activity" },
    { key: "client-health", band: "work", label: "Client health", placement: "optional" },
  ],
};
const bands = selectCustomisable(SUBJECT.widgets, ctx);
const label = (b: string) => `band ${b}`;
const action = vi.fn().mockResolvedValue(undefined);
const draw = (prefs = { hide: [] as string[], show: [] as string[] }, list = bands) =>
  render(<CustomiseOverview bands={list} prefs={prefs} workspaceKey="web-dev" bandLabel={label} action={action} />);
const item = (key: string) => document.querySelector(`li[data-widget="${key}"]`) as HTMLElement;

beforeEach(() => action.mockClear());
afterEach(cleanup);

describe("CustomiseOverview: the control", () => {
  it("is a disclosure, closed by default, with a labelled panel", () => {
    const { container } = draw();
    const details = container.querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(details.querySelector("summary")).toHaveTextContent("Customise");
    expect(screen.getByRole("group", { name: "Customise this Overview", hidden: true })).toBeInTheDocument();
  });

  it("lists each band's blocks in the Overview's own order, under the band's label", () => {
    draw();
    expect([...document.querySelectorAll(".ov-custom__band-label")].map((e) => e.textContent)).toEqual(["band now", "band you", "band work"]);
    expect([...document.querySelectorAll("li[data-widget]")].map((e) => e.getAttribute("data-widget"))).toEqual(["today", "my-activity", "client-health"]);
  });

  it("drops a band whose blocks are all fixed", () => {
    const fixedOnlyBand = selectCustomisable([SUBJECT.widgets[0], SUBJECT.widgets[2]], ctx);
    draw(undefined, fixedOnlyBand);
    expect([...document.querySelectorAll(".ov-custom__band-label")].map((e) => e.textContent)).toEqual(["band you"]);
  });

  it("draws nothing at all when every block is fixed (nothing to choose)", () => {
    const onlyFixed = selectCustomisable([SUBJECT.widgets[0]], ctx);
    const { container } = draw(undefined, onlyFixed);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("CustomiseOverview: a fixed block", () => {
  it("is not listed, even when a forged cookie names it in hide, and the intro says Needs you stays", () => {
    draw({ hide: ["needs-you"], show: [] });
    expect(item("needs-you")).toBeNull();
    expect(screen.queryByText("Always shown")).toBeNull();
    expect(screen.getByText(/Needs you always stays/)).toBeInTheDocument();
  });
});

describe("CustomiseOverview: a default block", () => {
  it("says Shown with a Hide button, and Hidden with a Show button", () => {
    const first = draw();
    expect(within(item("my-activity")).getByText("Shown")).toBeInTheDocument();
    expect(within(item("my-activity")).getByRole("button", { name: "Hide My activity", hidden: true })).toHaveTextContent("Hide");
    first.unmount();
    draw({ hide: ["my-activity"], show: [] });
    expect(within(item("my-activity")).getByText("Hidden")).toBeInTheDocument();
    expect(within(item("my-activity")).getByRole("button", { name: "Show My activity", hidden: true })).toHaveTextContent("Show");
  });

  it("posts the workspace, the widget and the NEW state: Hide sends on=false", async () => {
    draw();
    fireEvent.click(within(item("my-activity")).getByRole("button", { name: "Hide My activity", hidden: true }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledWith("web-dev", "my-activity", false, expect.anything());
  });

  it("posts on=true to bring a hidden block back", async () => {
    draw({ hide: ["today"], show: [] });
    fireEvent.click(within(item("today")).getByRole("button", { name: "Show Today", hidden: true }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledWith("web-dev", "today", true, expect.anything());
  });
});

describe("CustomiseOverview: an optional block", () => {
  it("is Switched off with a Switch on button until it is on", async () => {
    draw();
    expect(within(item("client-health")).getByText("Switched off")).toBeInTheDocument();
    fireEvent.click(within(item("client-health")).getByRole("button", { name: "Switch on Client health", hidden: true }));
    await waitFor(() => expect(action).toHaveBeenCalledWith("web-dev", "client-health", true, expect.anything()));
  });

  it("is Switched on with a Switch off button once it is in show", async () => {
    draw({ hide: [], show: ["client-health"] });
    expect(within(item("client-health")).getByText("Switched on")).toBeInTheDocument();
    fireEvent.click(within(item("client-health")).getByRole("button", { name: "Switch off Client health", hidden: true }));
    await waitFor(() => expect(action).toHaveBeenCalledWith("web-dev", "client-health", false, expect.anything()));
  });

  it("every button is a submit of its own form, so it works without JavaScript", () => {
    draw();
    for (const key of ["today", "my-activity", "client-health"]) {
      const btn = item(key).querySelector("button")!;
      expect(btn).toHaveAttribute("type", "submit");
      expect(btn.closest("form")).not.toBeNull();
    }
  });
});

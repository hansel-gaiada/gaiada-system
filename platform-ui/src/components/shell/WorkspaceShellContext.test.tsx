import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useWorkspaceShell } from "./WorkspaceShellContext";
import { inShell } from "./workspaceShellTestKit";

const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

function Probe() {
  const shell = useWorkspaceShell();
  if (!shell) return <p>classic</p>;
  const view = shell.view.kind === "workspace" ? `workspace:${shell.view.ws.key}` : shell.view.kind;
  return (
    <dl>
      <dt>view</dt><dd data-testid="view">{view}</dd>
      <dt>row</dt><dd data-testid="row">{shell.activeRow?.key ?? "none"}</dd>
      <dt>tab</dt><dd data-testid="tab">{shell.active?.tabKey ?? "none"}</dd>
      <dt>rows</dt><dd data-testid="rows">{shell.rows.length}</dd>
      <dt>tool</dt><dd data-testid="tool">{String(shell.onToolPage)}</dd>
    </dl>
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("useWorkspaceShell", () => {
  it("is null in the classic shell", () => {
    nav.pathname = "/departments/d-web/prd";
    render(<Probe />);
    expect(screen.getByText("classic")).toBeInTheDocument();
  });

  it("gives the Web Dev view, its rows and the active row and tab on a Web Dev page", () => {
    nav.pathname = "/departments/d-web/prd";
    render(inShell(<Probe />));
    expect(screen.getByTestId("view")).toHaveTextContent("workspace:web-dev");
    expect(screen.getByTestId("row")).toHaveTextContent("build");
    expect(screen.getByTestId("tab")).toHaveTextContent("prd");
    expect(Number(screen.getByTestId("rows").textContent)).toBeGreaterThan(5);
    expect(screen.getByTestId("tool")).toHaveTextContent("true");
  });

  it("treats a record below a tool as a deeper page, still held by the tool's row", () => {
    nav.pathname = "/departments/d-web/prd/some-run";
    render(inShell(<Probe />));
    expect(screen.getByTestId("tab")).toHaveTextContent("prd");
    expect(screen.getByTestId("tool")).toHaveTextContent("false");
  });

  it("gives the Company view on a Company page, with no row on a page no row holds", () => {
    nav.pathname = "/organization";
    const { unmount } = render(inShell(<Probe />));
    expect(screen.getByTestId("view")).toHaveTextContent("company");
    expect(screen.getByTestId("row")).toHaveTextContent("organization");
    unmount();
    nav.pathname = "/notifications";
    render(inShell(<Probe />));
    expect(screen.getByTestId("view")).toHaveTextContent("workspace:web-dev");
    expect(screen.getByTestId("row")).toHaveTextContent("none");
  });

  it("keeps the department last visited on a personal page", () => {
    window.sessionStorage.setItem("gaiada.shell.lastArea", JSON.stringify({ kind: "workspace", deptId: "d-seo" }));
    nav.pathname = "/me/inbox";
    render(inShell(<Probe />));
    expect(screen.getByTestId("view")).toHaveTextContent("workspace:seo");
    expect(screen.getByTestId("row")).toHaveTextContent("inbox");
  });
});

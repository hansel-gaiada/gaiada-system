import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { isValidElement, Children, type ReactElement, type ReactNode } from "react";

// DW-8h (BFF §45.4): the staff client page's Files card sits on the Internal "notes and files" tab (PV's call), on the
// client target, with the staff-only line. The panel's own behaviour is in FilesPanel.test.tsx.
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/driveActions", () => ({ loadPickerCredentialsAction: vi.fn(), attachDriveFileAction: vi.fn() }));
vi.mock("@/lib/drivePicker", () => ({ openDrivePicker: vi.fn() }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-staff") }));
vi.mock("@/lib/platform", () => ({
  getMe: vi.fn(async () => ({ userId: "u-staff", roles: [{ role: "member", scopeType: "company", scopeId: "co-agency" }], companies: [] })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-agency") }));
vi.mock("@/lib/entities", () => ({
  listClientNotes: vi.fn(async () => ({ kind: "ok", data: [] })),
  listClientHistory: vi.fn(async () => ({ kind: "ok", data: [] })),
  listMembers: vi.fn(async () => []),
  readFiles: vi.fn(async () => ({ kind: "ok", data: [] })),
  CLIENT_CONTACT_LABELS: {},
}));
vi.mock("@/lib/clientWorkActions", () => ({ addClientNoteAction: vi.fn(), deleteClientNoteForm: vi.fn() }));
vi.mock("@/lib/collabActions", () => ({ attachFileAction: vi.fn(), deleteFileAction: vi.fn(), uploadFileAction: vi.fn() }));
vi.mock("@/components/forms/ClientWorkForms", () => ({ ClientNoteForm: () => null }));

import ClientNotesPage from "./page";
import { FilesPanel } from "@/components/FilesPanel";

describe("staff client Notes tab: Files (DW-8h)", () => {
  it("shows the client's files on the client target, with the staff-only line", async () => {
    const tree = (await ClientNotesPage({ params: Promise.resolve({ clientId: "cl-1" }) })) as ReactElement<{ children: ReactNode }>;
    type P = React.ComponentProps<typeof FilesPanel>;
    const found: ReactElement<P>[] = [];
    const walk = (n: ReactNode) => Children.forEach(n, (c) => {
      if (!isValidElement(c)) return;
      const el = c as ReactElement<{ children?: ReactNode }>;
      if (el.type === FilesPanel) found.push(el as unknown as ReactElement<P>);
      else walk(el.props.children);
    });
    walk(tree.props.children);
    expect(found).toHaveLength(1);
    expect(found[0].props).toMatchObject({ entityType: "client", entityId: "cl-1", revalidate: "/clients/cl-1/notes" });
    render(<FilesPanel {...found[0].props} />);
    expect(screen.getByText("Only staff see these files.")).toBeInTheDocument();
  });
});

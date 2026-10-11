import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Me } from "@/lib/platform";

// WSK-49f — the staff client Contacts page: the "Website access" card, as each kind of staff member sees
// it. The page reads the list as a typed result and hands it, with the viewer's mirrored rights, to the
// panel; what is pinned here is that wiring (the panel's own behaviour is in its component test).
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-staff") }));
const meMock = vi.fn();
vi.mock("@/lib/platform", () => ({ getMe: (...a: unknown[]) => meMock(...a) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-agency") }));
vi.mock("@/lib/entities", () => ({
  getClient: vi.fn(async () => ({ id: "cl-1", name: "Northwind Traders", owner_name: null, contact: {} })),
  listProjects: vi.fn(async () => []),
  CLIENT_CONTACT_KEYS: [],
  CLIENT_CONTACT_LABELS: {},
}));
vi.mock("@/lib/meetings", () => ({
  listRecordings: vi.fn(async () => ({ kind: "ok", data: [] })),
  STATUS_LABEL: {}, formatDuration: () => "",
}));
vi.mock("@/lib/clientContacts", () => ({ listClientContacts: vi.fn(async () => []) }));
const accessMock = vi.fn();
vi.mock("@/lib/clientWebsiteAccess", () => ({ getStaffWebsiteAccess: (...a: unknown[]) => accessMock(...a) }));
vi.mock("@/lib/clientContactsActions", () => ({ inviteClientContactAction: vi.fn(), revokeClientContactAction: vi.fn() }));
vi.mock("@/lib/clientWebsiteAccessActions", () => ({
  setStaffWebsiteEditorAction: vi.fn(), setStaffClientAdminAction: vi.fn(), refreshStaffWebsiteAccessAction: vi.fn(),
}));
vi.mock("@/components/meetings/RecordControls", () => ({ RecordControls: () => null }));
vi.mock("@/components/meetings/ScheduleMeetingPanel", () => ({ ScheduleMeetingPanel: () => null }));

import { isValidElement, Children, type ReactElement, type ReactNode } from "react";
import ClientContactsPage from "./page";
import { ClientWebsiteAccessSection } from "@/components/clients/ClientWebsiteAccessSection";

const staff = (role: string): Me =>
  ({
    userId: "u-staff", name: "S", email: "s@gaiada.test", title: null, assurance: "high", companies: [],
    roles: [{ role, scopeType: "company", scopeId: "co-agency" }],
  }) as Me;

const ROWS = [
  { contactId: "c-dana", userId: "u-dana", name: "Dana Whitfield", email: "dana@n.test", capability: "signer", status: "active", isAdmin: false, websiteEditor: false },
  { contactId: "c-aria", userId: "u-aria", name: "Aria Hartono", email: "aria@n.test", capability: "admin", status: "active", isAdmin: true, websiteEditor: true },
  { contactId: "c-vera", userId: "u-vera", name: "Vera Santoso", email: "vera@n.test", capability: "viewer", status: "active", isAdmin: false, websiteEditor: false },
];

// The Website access card is an ASYNC server component (it does its own read), which a client-side render
// cannot await. So: the page is asked for its tree, the one <ClientWebsiteAccessSection> element is found in
// it (that is what pins the page wiring), and that element is awaited and rendered the way the server would.
function findSection(node: ReactNode): ReactElement | null {
  let found: ReactElement | null = null;
  const walk = (n: ReactNode) => {
    Children.forEach(n, (c) => {
      if (!isValidElement(c)) return;
      const el = c as ReactElement<{ children?: ReactNode }>;
      if (el.type === ClientWebsiteAccessSection) found = el;
      else walk(el.props.children);
    });
  };
  walk(node);
  return found;
}

const mount = async () => {
  const tree = await ClientContactsPage({ params: Promise.resolve({ clientId: "cl-1" }) });
  const el = findSection(tree);
  if (!el) throw new Error("the page does not render <ClientWebsiteAccessSection>");
  expect(el.props).toMatchObject({ userId: "u-staff", tenant: "co-agency", clientId: "cl-1", clientName: "Northwind Traders" });
  render(await ClientWebsiteAccessSection(el.props as React.ComponentProps<typeof ClientWebsiteAccessSection>));
};

beforeEach(() => {
  meMock.mockReset().mockResolvedValue(staff("company_admin"));
  accessMock.mockReset().mockResolvedValue({ kind: "ok", contacts: ROWS });
});

describe("staff Contacts page: Website access", () => {
  it("a company admin gets the capability labels, the Website editor switches and the Make/Remove admin buttons", async () => {
    await mount();
    expect(accessMock).toHaveBeenCalledWith("u-staff", "co-agency", "cl-1");
    expect(screen.getByRole("switch", { name: "Website editor: Dana Whitfield" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Website editor: Aria Hartono" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Make admin: Dana Whitfield" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove admin: Aria Hartono" })).toBeInTheDocument();
    expect(screen.getByText("Signer")).toBeInTheDocument();
    expect(screen.getByText("Viewer")).toBeInTheDocument();
  });

  it("a manager gets the switches but not the admin buttons", async () => {
    meMock.mockResolvedValue(staff("manager"));
    await mount();
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /admin:/i })).toBeNull();
  });

  it("an owner gets the read-only list: the server refuses owner on these actions (docs §16i)", async () => {
    meMock.mockResolvedValue(staff("owner"));
    await mount();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /admin:/i })).toBeNull();
    expect(screen.getByText("Website editor: Yes")).toBeInTheDocument();
  });

  it("a member (who may read) gets a plain read-only list, no controls", async () => {
    meMock.mockResolvedValue(staff("member"));
    await mount();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /admin:/i })).toBeNull();
    expect(screen.getByText("Website editor: Yes")).toBeInTheDocument();
    expect(screen.getByText(/takes a company admin or manager/i)).toBeInTheDocument();
  });

  it("a 403 on the read is a stated refusal, not an empty list and not a broken toggle", async () => {
    accessMock.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/you don.t have access to who has website access/i)).toBeInTheDocument();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByText(/no contact covers the whole client/i)).toBeNull();
  });

  it("a failed read says it cannot tell", async () => {
    accessMock.mockResolvedValue({ kind: "unavailable", reason: "502" });
    await mount();
    expect(screen.getByText(/this is not a statement that there is nothing here/i)).toBeInTheDocument();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("sits right after the Client access card and before Scheduled", async () => {
    const tree = (await ClientContactsPage({ params: Promise.resolve({ clientId: "cl-1" }) })) as ReactElement<{ children: ReactNode[] }>;
    const kids = tree.props.children;
    expect(kids).toHaveLength(5);
    expect((kids[2] as ReactElement).type).toBe(ClientWebsiteAccessSection);
  });
});

import "server-only";
// DEMO_MODE fixtures for WSK-49f — client website access (docs/FRONTEND-BFF-CONTRACT.md §16i).
//
// ONE stateful store of Northwind Traders' (`cl-1`) contacts, read by:
//   * the staff routes   GET  /api/:t/clients/:clientId/website-access
//                        GET  /api/:t/clients/:clientId/contacts                 (the staff Contacts list)
//                        PUT|DELETE …/contacts/:contactId/website-editor | admin
//   * the portal routes  GET  /api/:t/portal/clients/:clientId/website-access
//                        PUT|DELETE …/portal/clients/:clientId/contacts/:contactId/website-editor
//   * the portal profile (`demoPortal.ts` asks `portalProfileFor`), so the People page, the staff list and
//     the grant state always agree on who is an admin, a signer, a viewer.
//
// It models the REAL controller's refusals, not a friendly subset (the point of a fixture that drives a
// browser test): authorize FIRST (a caller who may not act learns nothing about the contact), then the
// target is loaded and pinned to the client in the URL, `changed:false` and NO write on a no-op,
// `self_grant_forbidden` for a grant to yourself (a self-revoke is allowed), project-scoped rows are not
// listed and cannot be granted, the admin removal takes `{to}` (default viewer), and a portal caller must
// be an ACTIVE, client-wide ADMIN of the client in the URL.
//
// Who is who (see lib/demoIdentity.ts):
//   staff    demo-hansel (platform_admin) · demo-owner (owner) · dept-manager (manager: website editor
//            yes, admin NO) · gede-ic (member: may read, may not manage)
//   clients  demo-client = Dana, a signer · demo-client-admin = Aria, an ADMIN · demo-client-viewer =
//            Vera, a viewer. Everyone else is refused on the portal routes.
import type { DemoResult } from "./demoFixtures";

const CLIENT_ID = "cl-1";

type Capability = "admin" | "signer" | "viewer";
interface DemoContact {
  contactId: string;
  userId: string;
  name: string;
  email: string;
  capability: Capability;
  status: "invited" | "active";
  projectId: string | null;
  side: "client" | "provider";
  websiteEditor: boolean;
}

const seed = (): DemoContact[] => [
  { contactId: "cc-dana", userId: "demo-client", name: "Dana Whitfield", email: "dana@northwind.example", capability: "signer", status: "active", projectId: null, side: "client", websiteEditor: false },
  { contactId: "cc-aria", userId: "demo-client-admin", name: "Aria Hartono", email: "admin@northwind.example", capability: "admin", status: "active", projectId: null, side: "client", websiteEditor: false },
  { contactId: "cc-vera", userId: "demo-client-viewer", name: "Vera Santoso", email: "viewer@northwind.example", capability: "viewer", status: "active", projectId: null, side: "client", websiteEditor: false },
  { contactId: "cc-marco", userId: "nw-3", name: "Marco Halim", email: "marco@northwind.example", capability: "viewer", status: "invited", projectId: null, side: "client", websiteEditor: false },
  // Project-scoped: not eligible, not listed by the website-access routes, cannot be granted.
  { contactId: "cc-erica", userId: "nw-2", name: "Erica Boonstra", email: "erica@northwind.example", capability: "viewer", status: "active", projectId: "proj-nw-site", side: "client", websiteEditor: false },
  // Our own staff holding a contact row (a placeholder signer): a client-wide contact like any other.
  { contactId: "cc-made", userId: "nw-4", name: "Made Prabowo", email: "made@gaiada.example", capability: "signer", status: "active", projectId: null, side: "provider", websiteEditor: false },
];

// Pinned on globalThis: the staff page, the portal page and the server actions can land in different
// module instances under `next dev`, and they must all see ONE store.
const G = globalThis as unknown as { __demoWebsiteAccess?: DemoContact[] };
const store = (): DemoContact[] => (G.__demoWebsiteAccess ??= seed());

/** Test hook: put the store back to its seed. */
export function resetDemoWebsiteAccess(): void {
  G.__demoWebsiteAccess = seed();
}

const ok = (json: unknown): DemoResult => ({ status: 200, json });
const err = (status: number, error: string): DemoResult => ({ status, json: { error } });

const STAFF_READ = new Set(["demo-hansel", "demo-owner", "dept-manager", "gede-ic", "seo-staff"]);
const STAFF_EDITOR = new Set(["demo-hansel", "demo-owner", "dept-manager"]);
const STAFF_ADMIN = new Set(["demo-hansel", "demo-owner"]);

const listBody = () => ({
  clientId: CLIENT_ID,
  role: "client_website_editor",
  contacts: store()
    .filter((c) => c.projectId === null)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({
      contactId: c.contactId, userId: c.userId, name: c.name, email: c.email, capability: c.capability,
      status: c.status, isAdmin: c.capability === "admin", websiteEditor: c.websiteEditor,
    })),
});

/** The People-page profile rows (ids are USER ids, as in the real `/portal/profile`). */
export function portalProfileContacts(): Array<{
  id: string; name: string; email: string; capability: string; status: string; clientId: string;
  projectId: string | null; side: "client" | "provider";
}> {
  return store().map((c) => ({
    id: c.userId, name: c.name, email: c.email, capability: c.capability, status: c.status,
    clientId: CLIENT_ID, projectId: c.projectId, side: c.side,
  }));
}

/** The caller's own contact row, for `access` on the profile. */
export function portalCallerContact(userId: string): { capability: Capability; projectId: string | null } | null {
  const c = store().find((x) => x.userId === userId && x.status === "active");
  return c ? { capability: c.capability, projectId: c.projectId } : null;
}

const SELF_GRANT =
  "self_grant_forbidden: a principal may not grant a role to themselves (D-9, design §6.3.5) — ask someone else with the authority to do it";

export function websiteAccessDemo(method: string, p: string, userId: string, body?: string): DemoResult | null {
  const m = method.toUpperCase();
  const staffList = p.match(/^\/api\/[^/]+\/clients\/([^/]+)\/(website-access|contacts)$/);
  const staffWrite = p.match(/^\/api\/[^/]+\/clients\/([^/]+)\/contacts\/([^/]+)\/(website-editor|admin)$/);
  const portalList = p.match(/^\/api\/[^/]+\/portal\/clients\/([^/]+)\/website-access$/);
  const portalWrite = p.match(/^\/api\/[^/]+\/portal\/clients\/([^/]+)\/contacts\/([^/]+)\/website-editor$/);

  // ── STAFF ──
  if (staffList && m === "GET") {
    if (!STAFF_READ.has(userId)) return err(403, "forbidden");
    if (staffList[1] !== CLIENT_ID) {
      // Another client: this fixture models only Northwind. An honest empty client, not a 404.
      return staffList[2] === "contacts"
        ? ok([])
        : ok({ clientId: staffList[1], role: "client_website_editor", contacts: [] });
    }
    if (staffList[2] === "website-access") return ok(listBody());
    return ok(
      store().map((c) => ({
        id: c.contactId, clientId: CLIENT_ID, userId: c.userId, projectId: c.projectId,
        capability: c.capability, status: c.status, email: c.email, name: c.name,
        invitedAt: "2026-09-01T09:00:00Z", activatedAt: c.status === "active" ? "2026-09-02T09:00:00Z" : null,
        hasAccount: c.status === "active",
      })),
    );
  }

  if (staffWrite && (m === "PUT" || m === "DELETE")) {
    const [, clientId, contactId, what] = staffWrite;
    // AUTHORIZE FIRST: a caller who may not act learns nothing about whether the contact exists.
    const allowed = what === "admin" ? STAFF_ADMIN : STAFF_EDITOR;
    if (!allowed.has(userId)) return err(403, "forbidden");
    const c = clientId === CLIENT_ID ? store().find((x) => x.contactId === contactId) : undefined;
    if (!c) return err(404, "contact not found for this client");
    if (what === "website-editor") {
      if (c.projectId !== null && m === "PUT") {
        return err(400, "website_editor_is_client_wide: this contact row is scoped to one project");
      }
      if (c.userId === userId) return err(400, SELF_GRANT);
      const grant = m === "PUT";
      const changed = c.websiteEditor !== grant;
      c.websiteEditor = grant;
      return ok({ clientId, contactId, userId: c.userId, role: "client_website_editor", websiteEditor: grant, changed });
    }
    if (c.projectId !== null) return err(400, "admin_is_client_wide: this contact row is scoped to one project");
    if (m === "PUT") {
      if (c.capability === "admin") return ok({ clientId, contactId, userId: c.userId, capability: "admin", changed: false });
      c.capability = "admin";
      return ok({ clientId, contactId, userId: c.userId, capability: "admin", changed: true });
    }
    let to = "viewer";
    if (body) {
      try { to = String((JSON.parse(body) as { to?: unknown }).to ?? "viewer"); } catch { to = "viewer"; }
    }
    if (to !== "signer" && to !== "viewer") return err(400, "to must be 'signer' or 'viewer'");
    if (c.capability !== "admin") return ok({ clientId, contactId, userId: c.userId, capability: c.capability, changed: false });
    c.capability = to;
    return ok({ clientId, contactId, userId: c.userId, capability: to, changed: true });
  }

  // ── PORTAL ──
  if (portalList && m === "GET") {
    if (!isActiveAdminOf(userId, portalList[1])) return err(403, "forbidden");
    return ok(listBody());
  }
  if (portalWrite && (m === "PUT" || m === "DELETE")) {
    const [, clientId, contactId] = portalWrite;
    if (!isActiveAdminOf(userId, clientId)) return err(403, "forbidden");
    const c = store().find((x) => x.contactId === contactId);
    if (!c) return err(404, "contact not found for this client");
    const grant = m === "PUT";
    if (grant && c.projectId !== null) {
      return err(400, "website_editor_is_client_wide: this contact row is scoped to one project");
    }
    // A grant to yourself is refused; a self-REVOKE is allowed (the real choke point's rule).
    if (grant && c.userId === userId) return err(400, SELF_GRANT);
    const changed = c.websiteEditor !== grant;
    c.websiteEditor = grant;
    return ok({ clientId, contactId, userId: c.userId, role: "client_website_editor", websiteEditor: grant, changed });
  }
  return null;
}

/** A portal caller who is an ACTIVE, client-wide ADMIN contact of this client. */
function isActiveAdminOf(userId: string, clientId: string): boolean {
  return (
    clientId === CLIENT_ID &&
    store().some((c) => c.userId === userId && c.capability === "admin" && c.status === "active" && c.projectId === null)
  );
}

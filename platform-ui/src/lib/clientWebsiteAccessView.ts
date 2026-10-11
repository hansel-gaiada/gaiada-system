// WSK-49f — the CLIENT-SAFE half of the website-access module: types, labels, the staff-side
// "may this viewer manage it" mirror, and the pure mapping from a refused write to plain words.
//
// Split from `clientWebsiteAccess.ts` (readers, server-only) for the same reason `clientContactsView.ts`
// is split from `clientContacts.ts`: any VALUE import from a module that reaches `lib/platform.ts`
// pulls `server-only` into the browser bundle. `tsc` and vitest pass in that state; only `next build`
// fails, so the split is load-bearing.
//
// Contract: docs/FRONTEND-BFF-CONTRACT.md §16i. UI gating here is COSMETIC. Every route re-authorizes
// (Cerbos) and a refusal comes back as a 403 that the components turn into a read-only state.
import type { Me } from "./platform";

/** `admin` implies signer (owner ruling 2026-10-11); it REPLACES signer/viewer in the one column. */
export type WebsiteAccessCapability = "admin" | "signer" | "viewer";
export type WebsiteAccessContactStatus = "invited" | "active";

/** One client-wide, non-revoked contact, as both list routes (staff and portal) return it. */
export interface WebsiteAccessRow {
  contactId: string;
  userId: string;
  name: string | null;
  email: string;
  capability: WebsiteAccessCapability;
  status: WebsiteAccessContactStatus;
  isAdmin: boolean;
  websiteEditor: boolean;
}

export interface WebsiteAccessList {
  clientId: string;
  role: "client_website_editor";
  contacts: WebsiteAccessRow[];
}

export const WEBSITE_ACCESS_CAPABILITY_LABEL: Record<WebsiteAccessCapability, string> = {
  admin: "Admin",
  signer: "Signer",
  viewer: "Viewer",
};

/** The sentence staff see when making someone an admin (brief WSK-49f, owner ruling). */
export const ADMIN_EXPLANATION = "Can sign, and can give colleagues website access";

/** The portal's own wording, shown once above the list. */
export const PORTAL_WEBSITE_ACCESS_HINT =
  "Website access: lets this person edit and publish your website in this portal.";

/** What the person is called in a sentence or an accessible name: the name, else the email. */
export function displayName(row: Pick<WebsiteAccessRow, "name" | "email">): string {
  return row.name && row.name.trim() ? row.name.trim() : row.email;
}

/** Read one list route's body defensively. Anything that is not the documented shape yields `null`, so
 *  a drifted backend renders as "unavailable", never as an empty list. */
export function parseWebsiteAccessList(body: unknown): WebsiteAccessList | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { clientId?: unknown; contacts?: unknown };
  if (typeof b.clientId !== "string" || !Array.isArray(b.contacts)) return null;
  const contacts: WebsiteAccessRow[] = [];
  for (const raw of b.contacts) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.contactId !== "string" || typeof r.userId !== "string" || typeof r.email !== "string") return null;
    const capability: WebsiteAccessCapability | null =
      r.capability === "admin" || r.capability === "signer" || r.capability === "viewer" ? r.capability : null;
    if (!capability) return null;
    contacts.push({
      contactId: r.contactId,
      userId: r.userId,
      name: typeof r.name === "string" ? r.name : null,
      email: r.email,
      capability,
      status: r.status === "invited" ? "invited" : "active",
      isAdmin: capability === "admin",
      websiteEditor: r.websiteEditor === true,
    });
  }
  return { clientId: b.clientId, role: "client_website_editor", contacts };
}

// ── The staff-side mirror ─────────────────────────────────────────────────────────────────────────
// `resource_client_contact.yaml`: `manage_website_editor` is company_admin | manager (and the
// `owner` / `platform_admin` tiers that sit above them); `manage_admin` is company_admin only,
// likewise with owner / platform_admin above. This is a UI MIRROR, never a second opinion: the page
// shows the controls to whoever this says may, and a 403 still wins.
//
// Deliberately NOT a new `Capability` in `rbac.ts`: both actions are role-arm only in Cerbos (no
// `perm_*` mirror, no permission-catalog key), so the capability-parity guard has nothing to compare
// a new capability against. Roles are read straight from `me`, scoped the way `can()` scopes them.
const EDITOR_ROLES: ReadonlySet<string> = new Set(["platform_admin", "owner", "company_admin", "manager"]);
const ADMIN_ROLES: ReadonlySet<string> = new Set(["platform_admin", "owner", "company_admin"]);

function holdsRoleFor(me: Me, roles: ReadonlySet<string>, tenant: string | null | undefined): boolean {
  return me.roles.some((g) => {
    if (!roles.has(g.role)) return false;
    if (g.scopeType === "global") return true;
    return g.scopeType === "company" && !!tenant && g.scopeId === tenant;
  });
}

export function canManageWebsiteEditor(me: Me, tenant: string | null | undefined): boolean {
  return holdsRoleFor(me, EDITOR_ROLES, tenant);
}

export function canManageClientAdmin(me: Me, tenant: string | null | undefined): boolean {
  return holdsRoleFor(me, ADMIN_ROLES, tenant);
}

// ── Write and read results ────────────────────────────────────────────────────────────────────────

/** What a write action hands the browser. `changed: false` is a real answer (the target was already in
 *  that state) and must never be shown as "updated". */
export type WebsiteAccessWriteResult =
  | { ok: true; changed: boolean; websiteEditor?: boolean; capability?: WebsiteAccessCapability }
  /** `forbidden` 403 · `not_found` 404 (the contact is gone) · `refused` 400/409/422 with the server's
   *  own reason · `error` anything else (outage, bad session). */
  | { ok: false; kind: "forbidden" | "not_found" | "refused" | "error"; message: string };

export type WebsiteAccessReadResult =
  | { kind: "ok"; contacts: WebsiteAccessRow[] }
  | { kind: "forbidden" }
  | { kind: "unavailable"; reason: string };

const REFUSAL_COPY: Record<string, string> = {
  self_grant_forbidden: "You can't give website access to yourself. Ask a colleague who is an admin.",
  website_editor_is_client_wide:
    "Website access is for people who cover the whole account. This contact is limited to one project.",
  admin_is_client_wide: "Only people who cover the whole account can be an admin. This contact is limited to one project.",
  target_not_a_contact_of_client: "That person's access has been removed, so they can't be given website access.",
  contact_revoked: "That person's access has been removed.",
};

/** The BFF's 400s start with a machine code (`self_grant_forbidden: a principal may not ...`). Known
 *  codes get plain copy; anything else shows the server's own words, never a guess. */
export function describeRefusal(serverMessage: string): string {
  const code =
    /^([a-z][a-z0-9_]*)\s*:/.exec(serverMessage)?.[1] ?? (/^[a-z][a-z0-9_]*$/.test(serverMessage) ? serverMessage : null);
  if (code && REFUSAL_COPY[code]) return REFUSAL_COPY[code];
  return serverMessage || "That change was refused.";
}

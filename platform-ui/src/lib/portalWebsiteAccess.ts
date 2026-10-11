// WSK-49d — who sees the portal's Website area, and for which client.
//
// Pure and client-safe (no server imports), so the portal layout (server), PortalTabs (client) and the
// tests share one rule. UI gating is cosmetic: the BFF's Cerbos check (`client_website_editor` for the
// URL's client) is the authority on every route, and the pages guard themselves with the same helpers
// so a typed URL never shows a confident empty list.
//
// THE RULE (WSK-D60 amended): a viewer may use the Website area for a client when `me.roles` holds
// `client_website_editor` with `scopeType: "client"` and `scopeId` = that client's id, AND that client is
// one of the clients of the portal company currently shown (a grant for a client of another company is
// not usable here: the route is `/api/:t/portal/clients/:clientId/website`, with `:t` the active company).

export const WEBSITE_EDITOR_ROLE = "client_website_editor";

/** The plain page for anyone who may not use the area. Exact words, shared by the page and its tests. */
export const NO_WEBSITE_ACCESS_COPY = "You don't have website editing access. Ask your company's admin.";

export interface RoleGrant { role: string; scopeType: string; scopeId: string | null }

/** Client ids (in `scopeClientIds` order) the viewer may edit the website of. Duplicates removed. */
export function websiteEditorClients(roles: readonly RoleGrant[] | null | undefined, scopeClientIds: readonly string[] | null | undefined): string[] {
  const held = new Set<string>();
  for (const g of roles ?? []) {
    if (g.role === WEBSITE_EDITOR_ROLE && g.scopeType === "client" && typeof g.scopeId === "string" && g.scopeId) held.add(g.scopeId);
  }
  const out: string[] = [];
  for (const id of scopeClientIds ?? []) if (held.has(id) && !out.includes(id)) out.push(id);
  return out;
}

/** The client the Website area shows: the portal's remembered client when the viewer may edit its website,
 *  otherwise the first client they may. `null` = no access. */
export function pickWebsiteClient(granted: readonly string[], remembered: string | null | undefined): string | null {
  if (granted.length === 0) return null;
  if (remembered && granted.includes(remembered)) return remembered;
  return granted[0];
}

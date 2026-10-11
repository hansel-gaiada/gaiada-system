"use client";
import { useMemo, type ComponentProps } from "react";
import { ItemEditor } from "@/components/webdesk/content/ItemEditor";
import { portalEditorDriver, portalMediaDriver } from "@/lib/portalWebsiteDriver";
import type { PortalPublishRequest } from "@/lib/portalWebsiteModel";
import type { ClientEditable, ClientModeCfg } from "@/lib/webdeskEditorDriver";
import { PortalPublishPanel } from "./PortalPublishPanel";

// The portal's item editor: the staff `ItemEditor` in CLIENT MODE. Nothing here is a second editor. What this file does:
//   • builds the client-mode configuration: the portal's server calls (`portalEditorDriver`, `portalMediaDriver`), the BFF's
//     `clientEditable` verdict (what renders read-only), and the publishing panel (self-publish one item, WSK-D58);
//   • keeps those stable across renders (the editor re-arms its refresh timer when its driver changes).
// Everything else (the form tree, the 422/409/stale/unconfirmed states, the preview, the media picker) is the shared component.
type EditorProps = ComponentProps<typeof ItemEditor>;

export function PortalItemEditor({
  clientId, viewerId, editable, requests, listHref, requestsHref, ...rest
}: Omit<EditorProps, "clientMode"> & {
  clientId: string;
  viewerId: string;
  editable: ClientEditable;
  /** This client's pending publish requests that name the item (`null` = the lookup failed). */
  requests: PortalPublishRequest[] | null;
  listHref: string;
  requestsHref: string;
}) {
  const driver = useMemo(() => portalEditorDriver(clientId), [clientId]);
  const mediaDriver = useMemo(() => portalMediaDriver(clientId), [clientId]);
  const clientMode = useMemo<ClientModeCfg>(() => ({
    clientId, viewerId, editable, driver, mediaDriver,
    renderPublish: (slot) => (
      <PortalPublishPanel
        clientId={clientId} scope={rest.scope} item={slot.item} version={slot.version} dirty={slot.dirty} blocked={slot.blocked}
        headIsMine={slot.headIsMine} headAuthor={slot.headAuthor} requests={requests} listHref={listHref} requestsHref={requestsHref}
        onItemChanged={slot.onItemChanged} onUnavailable={slot.onUnavailable} onUnconfirmed={slot.onUnconfirmed}
      />
    ),
  }), [clientId, viewerId, editable, driver, mediaDriver, rest.scope, requests, listHref, requestsHref]);

  return <ItemEditor {...rest} clientMode={clientMode} />;
}

// WSK-49d — the portal's `EditorDriver` / `MediaDriver`: the shared Website components' server calls, bound to ONE client.
//
// Client-safe (no server imports): it only references the server ACTIONS in `portalWebsiteActions.ts`, which Next turns into
// callable references in the browser. A driver is made per client and kept stable by the caller (`useMemo`), because the item
// editor re-arms its refresh timer when the driver changes.
import {
  portalCreateItemAndOpenAction, portalGetItemHeadAction, portalListMediaAction, portalMintUploadTokenAction, portalPreviewItemAction,
  portalRefreshEditorAction, portalSaveItemAction, portalUpdateMediaAction,
} from "./portalWebsiteActions";
import type { EditorDriver, MediaDriver } from "./webdeskEditorDriver";

export function portalEditorDriver(clientId: string): EditorDriver {
  return {
    refreshEditor: (scope, collectionKey, slug, locale) => portalRefreshEditorAction(clientId, scope, collectionKey, slug, locale),
    getItemHead: (scope, itemId) => portalGetItemHeadAction(clientId, scope, itemId),
    saveItem: (scope, itemId, input) => portalSaveItemAction(clientId, scope, itemId, input),
    createAndOpen: (scope, input, routeBase) => portalCreateItemAndOpenAction(clientId, scope, input, routeBase),
    previewItem: (scope, itemId, version) => portalPreviewItemAction(clientId, scope, itemId, version),
  };
}

/** No `usage` and no `remove`: the client BFF has neither route, so the library shows neither "Where it's used" nor Delete. */
export function portalMediaDriver(clientId: string): MediaDriver {
  return {
    list: (scope, query) => portalListMediaAction(clientId, scope, query),
    mintToken: (scope, bucket) => portalMintUploadTokenAction(clientId, scope, bucket),
    update: (scope, assetId, patch, key) => portalUpdateMediaAction(clientId, scope, assetId, patch, key),
  };
}

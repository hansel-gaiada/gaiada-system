"use client";
import { useMemo, type ComponentProps } from "react";
import { MediaLibrary } from "@/components/webdesk/content/MediaLibrary";
import { portalMediaDriver } from "@/lib/portalWebsiteDriver";

// The media library in CLIENT MODE: the shared `MediaLibrary` with the portal's media calls and NO delete (the client BFF has
// none), no "Where it's used". Uploads go browser -> WebDesk exactly as in the staff UI (the token comes from the portal route).
export function PortalMediaLibrary({ clientId, ...rest }: Omit<ComponentProps<typeof MediaLibrary>, "driver"> & { clientId: string }) {
  const driver = useMemo(() => portalMediaDriver(clientId), [clientId]);
  return <MediaLibrary {...rest} driver={driver} />;
}

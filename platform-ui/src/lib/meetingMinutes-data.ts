import "server-only";
import { platformFetch } from "./platform";
import type { MinutesView } from "./meetingMinutes";

/** `GET /api/:t/meetings/:id/minutes` (BFF §29c). Throws on a refusal; the page wraps it in `readResult()`. */
export const getMeetingMinutes = (userId: string, tenant: string, meetingId: string) =>
  platformFetch<MinutesView>(`/api/${tenant}/meetings/${encodeURIComponent(meetingId)}/minutes`, userId);

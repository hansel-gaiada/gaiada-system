// Test fixtures for the post approval page (SCP-2): invented posts in the shape of BFF §63.9. Only the tests import this file.
import type { PortalSocialPost } from "@/lib/portalSocial";

export const TENANT = "co-agency";

export function post(over: Partial<PortalSocialPost> = {}): PortalSocialPost {
  const id = over.id ?? "p-1";
  return {
    id, clientId: "cl-1", clientName: "Northwind Traders", month: "2026-10", title: "Five ways to style a scarf", format: "feed",
    plannedAt: "2026-10-25T09:30:00.000Z", placement: ["instagram", "facebook"], state: "to_review",
    caption: "Five ways to wear one scarf.", onAssetText: "Five ways", cta: "Learn more", hashtags: ["northwind", "madewithcare"],
    images: [{ fileId: `${id}-f1`, thumbFileId: `${id}-f1`, position: 1, alt: "A scarf, worn five ways" }],
    variants: [
      { id: `${id}-v-instagram`, network: "instagram", handle: "@northwindtraders", surface: "feed", body: "Five ways to wear one scarf.\n\n#northwind #madewithcare", firstComment: null, scheduledAt: "2026-10-25T09:30:00.000Z" },
      { id: `${id}-v-facebook`, network: "facebook", handle: "@northwindtraders", surface: "feed", body: "Five ways to wear one scarf.\n\n#northwind #madewithcare", firstComment: null, scheduledAt: "2026-10-25T09:30:00.000Z" },
    ],
    reviewHash: "hash-1", decision: null, liveUrl: null, simulated: false, ...over,
  };
}

export const carousel = (over: Partial<PortalSocialPost> = {}): PortalSocialPost => post({
  id: "p-car", title: "Carousel post", format: "carousel",
  images: [1, 2, 3].map((n) => ({ fileId: `p-car-f${n}`, thumbFileId: `p-car-f${n}`, position: n, alt: `Slide ${n}` })),
  ...over,
});

export const story = (over: Partial<PortalSocialPost> = {}): PortalSocialPost => post({
  id: "p-story", title: "Last call", format: "story", placement: ["instagram"],
  images: [{ fileId: "p-story-f1", thumbFileId: "p-story-f1", position: 1, alt: "Last call story" }],
  variants: [{ id: "p-story-v-instagram", network: "instagram", handle: "@northwindtraders", surface: "story", body: "", firstComment: null, scheduledAt: null }],
  ...over,
});

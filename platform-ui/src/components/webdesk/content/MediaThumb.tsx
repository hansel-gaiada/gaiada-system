"use client";
import { useState } from "react";
import { mimeLabel } from "@/lib/webdeskMediaModel";
import "./media.css";

/** A thumbnail, or, when there is none to show, a plain tile that SAYS which it is: no preview address (the ERP wasn't told
 *  where WebDesk serves media), a type with no preview (PDF, video), or an image that failed to load. Never a broken-image
 *  icon. The image is decorative (`alt=""`): the tile it sits in carries the asset's accessible name. */
export function MediaThumb({ src, mime, large = false }: { src: string | null; mime: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={`wm-thumb${large ? " wm-thumb--large" : ""}`} src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
  }
  const why = !src ? (mime.startsWith("image/") ? "No preview" : mimeLabel(mime)) : "Preview unavailable";
  return <span className={`wm-thumb wm-thumb--tile${large ? " wm-thumb--large" : ""}`} data-testid="media-tile-fallback">{why}</span>;
}

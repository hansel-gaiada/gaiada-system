"use client";
import { useEffect } from "react";

// PV5-07 — the proof that the print page rendered ITS document. platform-nest put a random `renderNonce` in the payload
// it minted; once this page has rendered that payload, the title becomes the nonce, and Chromium copies the title into
// the PDF's /Title. platform-nest refuses any PDF whose /Title is not that nonce, so a refusal page, an error page or a
// page that never finished cannot be stored (or sealed) as a document of record. It is set from the client on purpose:
// it can only run inside a page that rendered completely, which is the thing being proved. platform-nest replaces the
// title with the document's real name before storing.
//
// The title is KEPT, not just set once (PV5-13, measured on live 2026-10-13 with Next 16.3): Next streams the page's
// metadata and commits `<title>` from `metadata.title` AFTER this effect has run, so a one-shot assignment was
// overwritten and every invoice PDF and sealed copy failed with `render_unverified`. Any later change to the head puts
// the nonce back. The observer only runs on the print routes, which only the renderer sidecar opens.
export function DocumentTitle({ nonce }: { nonce: string }) {
  useEffect(() => {
    const keep = () => {
      if (document.title !== nonce) document.title = nonce;
    };
    keep();
    const observer = new MutationObserver(keep);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [nonce]);
  return null;
}

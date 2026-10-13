"use client";
import { useEffect } from "react";

// PV5-07 — the proof that the print page rendered ITS document. platform-nest put a random `renderNonce` in the payload
// it minted; once this page has rendered that payload, the title becomes the nonce, and Chromium copies the title into
// the PDF's /Title. platform-nest refuses any PDF whose /Title is not the nonce, so a refusal page, an error page or a
// page that never finished cannot be stored (or sealed) as a document of record. It is set from the client on purpose:
// it can only run inside a page that rendered completely, which is the thing being proved. platform-nest replaces the
// title with the document's real name before storing.
export function DocumentTitle({ nonce }: { nonce: string }) {
  useEffect(() => {
    document.title = nonce;
  }, [nonce]);
  return null;
}

"use client";
import { useEffect, useState, useTransition } from "react";
import type { DocVersion, DocVersionFull } from "@/lib/pm";
import { fetchDocVersions, fetchDocVersion, restoreDocVersion } from "@/lib/pmActions";
import { Eyebrow, HairlineTable } from "@/components/ui";

interface Props {
  docId: string;
  onBack: () => void; // return to the doc body (DocEditor's collapsed state)
  onRestored: () => void; // parent should router.refresh() so the doc's own `version`/body sync
}

// P3-11 — append-only version history for a single doc: a HairlineTable of
// `v · author · date · [View] [Restore]` rows (newest first). "View" swaps in
// a read-only body block; "Restore" reveals a one-line inline confirm (never
// a browser confirm()) before calling the restore action. Fully keyboard-
// operable — every control is a native <button>/<select>.
export function DocHistory({ docId, onBack, onRestored }: Props) {
  const [versions, setVersions] = useState<DocVersion[] | null>(null);
  const [viewing, setViewing] = useState<DocVersionFull | null>(null);
  const [confirmV, setConfirmV] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function refetch() {
    fetchDocVersions(docId).then((r) => {
      if (r.ok) setVersions([...r.versions].sort((a, b) => b.version - a.version));
      else setMsg(r.error ?? "Couldn't load history.");
    });
  }
  useEffect(refetch, [docId]);

  function view(v: number) {
    startTransition(async () => {
      const r = await fetchDocVersion(docId, v);
      if (r.ok && r.version) setViewing(r.version);
      else setMsg(r.error ?? "Couldn't load that version.");
    });
  }

  function restore(v: number) {
    startTransition(async () => {
      const r = await restoreDocVersion(docId, v);
      if (r.ok) { setConfirmV(null); refetch(); onRestored(); }
      else setMsg(r.error ?? "Couldn't restore that version.");
    });
  }

  if (viewing) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>
          v{viewing.version} · {viewing.authorName} · {new Date(viewing.createdAt).toLocaleString("en-GB")}
        </Eyebrow>
        <pre
          style={{ margin: 0, whiteSpace: "pre-wrap", font: "400 13px/1.6 var(--font-body)", color: "var(--text-primary)", border: "0.5px solid var(--erp-hairline)", padding: 12 }}
        >
          {viewing.body}
        </pre>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setViewing(null)}>
          Back
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {msg && <p role="alert" style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</p>}
      {versions === null && (
        <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>Loading…</p>
      )}
      {versions && versions.length === 0 && (
        <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>No history yet.</p>
      )}
      {versions && versions.length > 0 && (
        <HairlineTable
          columns={[{ label: "Version" }, { label: "Author" }, { label: "Date" }, { label: "", align: "right" }]}
          tcols="0.8fr 1.4fr 1.2fr 2.6fr"
          rows={versions.map((v) => [
            `v${v.version}`,
            v.authorName,
            new Date(v.createdAt).toLocaleString("en-GB"),
            confirmV === v.version ? (
              <span key="confirm" style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
                  Restores as a new version — nothing is lost.
                </span>
                <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending} onClick={() => restore(v.version)}>
                  Confirm
                </button>
                <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => setConfirmV(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <span key="actions" style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => view(v.version)}>
                  View
                </button>
                <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending} onClick={() => setConfirmV(v.version)}>
                  Restore
                </button>
              </span>
            ),
          ])}
        />
      )}
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onBack}>
        Back
      </button>
    </div>
  );
}

import Link from "next/link";

// Small shared pieces of the recruitment write screens (DW-7f-2): the result line under a control, and the
// styles the panels share. A result line is what the SERVER said: a refusal is shown as sent, and a success
// repeats the server's own account, never a state the client inferred.

export type Msg = { ok: boolean; text: string; href?: string; linkLabel?: string };

export function ResultMessage({ msg }: { msg: Msg }) {
  return (
    <p role={msg.ok ? "status" : "alert"}
      style={{ margin: 0, font: "400 13px/1.5 var(--font-body)", color: msg.ok ? "var(--erp-ink-80, inherit)" : "var(--erp-accent)" }}>
      {msg.text}
      {msg.href ? <>{" "}<Link href={msg.href} style={{ color: "var(--erp-accent)" }}>{msg.linkLabel ?? "Open"}</Link></> : null}
    </p>
  );
}

export const panelStyle = { display: "grid", gap: 8, padding: 10, border: "1px solid var(--erp-line)", borderRadius: 8 } as const;
export const textStyle = { margin: 0, font: "400 12px/1.5 var(--font-body)" } as const;
export const dimStyle = { font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" } as const;
export const fullRow = { gridColumn: "1 / -1" } as const;

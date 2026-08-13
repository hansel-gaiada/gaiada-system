"use client";
// MON-20 — the monitor editor.
//
// ── THE KIND PICKER IS DATA, NOT A HARDCODED LIST ──────────────────────────────────────────────
// `kinds` comes from GET /monitoring/kinds, which the backend derives from its driver registry
// (monitoring-program.md §3.2). Adding the MQTT or Steam driver server-side makes those options
// appear here with NO change to this file. That is the whole point of the registry, and hardcoding
// a <select> of kinds here would quietly throw it away.
//
// A kind whose driver is not registered arrives with `available:false` and is rendered DISABLED
// rather than hidden. Hiding it makes "not built yet" indistinguishable from "never designed";
// worse, a hidden-but-accepted kind would let someone create a monitor that can never run and would
// sit in the board reporting `unknown` forever.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { createMonitor } from "@/lib/monitoringActions";
import type { MonitorKindSpec } from "@/lib/monitoring";

const SEVERITIES = [
  { value: "page", label: "Page — wake someone" },
  { value: "ticket", label: "Ticket — handle next working day" },
  { value: "info", label: "Info — record only" },
];

const labelStyle = {
  font: "600 11px var(--font-body)",
  letterSpacing: "0.04em",
  color: "var(--erp-ink-60)",
  textTransform: "uppercase" as const,
  display: "block",
  marginBottom: 4,
};

/** What to ask for, per kind. Kinds we don't know are handled by the generic fallback. */
function targetHint(kind: string): { label: string; placeholder: string } | null {
  switch (kind) {
    case "http":
    case "keyword":
      return { label: "URL", placeholder: "https://example.com/page" };
    case "tcp":
      return { label: "Host and port", placeholder: "example.com:443" };
    case "dns":
      return { label: "Hostname", placeholder: "example.com" };
    case "tls":
      return { label: "Host and port", placeholder: "example.com:443" };
    case "heartbeat":
      // No outbound target by definition — the job pushes to us. Asking for one would invite
      // someone to type a URL that is never contacted.
      return null;
    default:
      return { label: "Target", placeholder: "host, URL or endpoint" };
  }
}

export function NewMonitorForm({
  tenantId,
  kinds,
  clients,
}: {
  tenantId: string;
  kinds: MonitorKindSpec[];
  clients: { id: string; name: string }[];
}) {
  const router = useRouter();
  const available = kinds.filter((k) => k.available);
  const [kind, setKind] = useState(available[0]?.kind ?? "http");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [intervalSec, setIntervalSec] = useState("60");
  const [severity, setSeverity] = useState("ticket");
  const [expectText, setExpectText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const spec = kinds.find((k) => k.kind === kind);
  const hint = targetHint(kind);
  const supportsBody = spec?.capabilities.some((c) => c.startsWith("body_")) ?? false;

  function submit() {
    setError(null);
    const fd = new FormData();
    fd.set("tenantId", tenantId);
    fd.set("name", name.trim());
    fd.set("kind", kind);
    fd.set("clientId", clientId);
    fd.set("target", target.trim());
    fd.set("intervalSec", intervalSec);
    fd.set("severity", severity);
    if (supportsBody) fd.set("expectText", expectText.trim());
    startTransition(async () => {
      const res = await createMonitor(fd);
      if (!res.ok) {
        setError(res.error ?? "Couldn't create the monitor.");
        return;
      }
      router.push("/monitoring");
      router.refresh();
    });
  }

  if (kinds.length === 0) {
    return (
      <p style={{ fontSize: 14, opacity: 0.75 }}>
        The monitoring backend has not reported any check types, so nothing can be created yet. This
        is not a configuration problem you can fix from here — see{" "}
        <code>docs/blueprints/monitoring-program.md</code> (MON-11).
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 560 }}>
      <div>
        <label htmlFor="mon-kind" style={labelStyle}>
          What to check
        </label>
        <select
          id="mon-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          style={{ width: "100%", padding: "8px 10px" }}
        >
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind} disabled={!k.available}>
              {k.label}
              {k.available ? "" : " — not available on this deployment"}
            </option>
          ))}
        </select>
        {spec && !spec.available && (
          <p style={{ fontSize: 12, marginTop: 6, color: "var(--status-critical-fg)" }}>
            No driver is registered for this check type, so it cannot run. Pick another.
          </p>
        )}
      </div>

      <div>
        <label htmlFor="mon-name" style={labelStyle}>
          Name
        </label>
        <input
          id="mon-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="viceroybali.com — homepage"
          style={{ width: "100%", padding: "8px 10px" }}
        />
      </div>

      <div>
        <label htmlFor="mon-client" style={labelStyle}>
          Client
        </label>
        <select
          id="mon-client"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          style={{ width: "100%", padding: "8px 10px" }}
        >
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <p style={{ fontSize: 12, marginTop: 6, opacity: 0.7 }}>
          Every monitor belongs to a client, including your own properties — that is what scopes it
          for billing, reporting and the client&apos;s own status page.
        </p>
      </div>

      {hint ? (
        <div>
          <label htmlFor="mon-target" style={labelStyle}>
            {hint.label}
          </label>
          <input
            id="mon-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={hint.placeholder}
            style={{ width: "100%", padding: "8px 10px" }}
          />
        </div>
      ) : (
        <p style={{ fontSize: 13, opacity: 0.75 }}>
          A heartbeat monitor has no target — the job calls us. You&apos;ll get a push URL to add to
          the job once it&apos;s saved, and an alert fires when that call stops arriving.
        </p>
      )}

      {supportsBody && (
        <div>
          <label htmlFor="mon-expect" style={labelStyle}>
            Text the page must contain
          </label>
          <input
            id="mon-expect"
            value={expectText}
            onChange={(e) => setExpectText(e.target.value)}
            placeholder="Book a table"
            style={{ width: "100%", padding: "8px 10px" }}
          />
          <p style={{ fontSize: 12, marginTop: 6, opacity: 0.7 }}>
            A hacked or half-broken site still returns 200. Checking for a string that only appears
            when the page really works is what catches that.
          </p>
        </div>
      )}

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 160px" }}>
          <label htmlFor="mon-interval" style={labelStyle}>
            Check every (seconds)
          </label>
          <input
            id="mon-interval"
            type="number"
            min={20}
            value={intervalSec}
            onChange={(e) => setIntervalSec(e.target.value)}
            style={{ width: "100%", padding: "8px 10px" }}
          />
        </div>
        <div style={{ flex: "2 1 240px" }}>
          <label htmlFor="mon-sev" style={labelStyle}>
            When it fails
          </label>
          <select
            id="mon-sev"
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            style={{ width: "100%", padding: "8px 10px" }}
          >
            {SEVERITIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p role="alert" style={{ fontSize: 13, color: "var(--status-critical-fg)" }}>
          {error}
        </p>
      )}

      <div>
        <Button onClick={submit} disabled={pending || (spec ? !spec.available : false)}>
          {pending ? "Creating…" : "Create monitor"}
        </Button>
      </div>
    </div>
  );
}

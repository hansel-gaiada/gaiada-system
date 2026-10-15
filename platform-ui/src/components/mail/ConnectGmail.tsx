"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { connectGmailAction } from "@/lib/gmailActions";
import "./mail.css";

/** Connect (or reconnect) the person's own Gmail. Simulated links at once; live navigates to Google's consent screen. */
export function ConnectGmail({ label = "Connect your Gmail" }: { label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const go = () =>
    start(async () => {
      const r = await connectGmailAction();
      if (!r.ok) return setError(r.error);
      setError(null);
      if (r.authUrl) window.location.assign(r.authUrl);
      else router.refresh();
    });
  return (
    <div className="gm-actions">
      <Button onClick={go} disabled={pending}>{pending ? "Connecting…" : label}</Button>
      {error && <p className="gm-error" role="alert">{error}</p>}
    </div>
  );
}

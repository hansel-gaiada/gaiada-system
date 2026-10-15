"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { disconnectGmailAction } from "@/lib/gmailActions";
import "./mail.css";

export function DisconnectGmail() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const go = () => {
    if (!window.confirm("Disconnect your Gmail from the ERP? You can connect it again at any time.")) return;
    start(async () => {
      const r = await disconnectGmailAction();
      if (!r.ok) return setError(r.error);
      setError(null);
      router.refresh();
    });
  };
  return (
    <div className="gm-actions">
      <Button variant="ghost" onClick={go} disabled={pending}>Disconnect Gmail</Button>
      {error && <p className="gm-error" role="alert">{error}</p>}
    </div>
  );
}

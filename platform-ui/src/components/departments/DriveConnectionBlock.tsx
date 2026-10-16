"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, StatusBadge } from "@/components/ui";
import type { ReadResult } from "@/lib/readResult";
import { startDriveConnectAction, disconnectDriveAction } from "@/lib/driveActions";
import { driveOutcomeText, type DriveStatus } from "@/lib/drive";

// DW-6i: the Google Drive block of the Tools & connections page (BFF §42.6). It replaces the manual email row. One of:
//   * "Google Drive isn't set up for this ERP yet" (`configured: false`, the normal state until the OAuth client exists);
//   * "Connect Google Drive", which starts OAuth and navigates to Google;
//   * the connected account's email, with Disconnect;
//   * "Reconnect" (`needsReconnect`): Google refused the saved connection.
// A read the person may not see, or that failed, is said in words and is never "not connected". The `driveOAuth` flag the OAuth
// landing page adds to the URL is shown as one calm line. No token is ever in this component's props.
export function DriveConnectionBlock({
  result, returnPath, outcome, outcomeReason, navigate = (url) => window.location.assign(url),
}: {
  result: ReadResult<DriveStatus>;
  /** The page this block sits on (a path on this site); the OAuth landing sends the person back to it. */
  returnPath: string;
  outcome?: string;
  outcomeReason?: string;
  /** Where the browser goes for Google's consent screen. A prop so a test can observe it; the default is a plain navigation. */
  navigate?: (url: string) => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const notice = driveOutcomeText(outcome, outcomeReason);

  function start() {
    setError(null);
    setDone(null);
    startTransition(async () => {
      const res = await startDriveConnectAction(returnPath);
      if (!res.ok) return setError(res.error);
      navigate(res.authUrl);
    });
  }

  function disconnect() {
    setError(null);
    setDone(null);
    startTransition(async () => {
      const res = await disconnectDriveAction();
      if (!res.ok) return setError(res.error);
      setDone("Google Drive is disconnected. Files already attached stay as links.");
      router.refresh();
    });
  }

  return (
    <>
      {notice && <p className="dept-conn-note" role="status" data-drive-outcome={outcome}>{notice}</p>}
      {result.kind === "forbidden" && <p className="dept-conn-note">You can&apos;t see whether Google Drive is connected.</p>}
      {result.kind === "unavailable" && (
        <p className="dept-conn-note">Whether Google Drive is connected can&apos;t be read right now ({result.reason}). That doesn&apos;t mean it isn&apos;t.</p>
      )}
      {result.kind === "ok" && !result.data.configured && (
        <>
          <div className="dept-conn-row__main">
            <span className="dept-conn-row__label">Google Drive</span>
            <StatusBadge label="not set up" />
          </div>
          <p className="dept-conn-note" style={{ marginTop: 8 }}>Google Drive isn&apos;t set up for this ERP yet. An administrator needs to add the Google Drive credentials first.</p>
        </>
      )}
      {result.kind === "ok" && result.data.configured && result.data.needsReconnect && (
        <>
          <div className="dept-conn-row__main">
            <span className="dept-conn-row__label">Google Drive</span>
            <StatusBadge label="needs reconnect" />
            {result.data.accountEmail && <span className="dept-conn-row__account">{result.data.accountEmail}</span>}
          </div>
          <p className="dept-conn-note" style={{ marginTop: 8 }}>Google no longer accepts the saved connection. Reconnect to attach files from Drive again. Files already attached keep working.</p>
          <div className="dept-conn-row__form">
            <Button size="sm" onClick={start} disabled={pending}>{pending ? "Working…" : "Reconnect"}</Button>
            <Button variant="ghost" size="sm" onClick={disconnect} disabled={pending}>Disconnect</Button>
          </div>
        </>
      )}
      {result.kind === "ok" && result.data.configured && !result.data.needsReconnect && result.data.connected && (
        <>
          <div className="dept-conn-row__main">
            <span className="dept-conn-row__label">Google Drive</span>
            <StatusBadge label="connected" />
            {result.data.accountEmail && <span className="dept-conn-row__account">{result.data.accountEmail}</span>}
          </div>
          <p className="dept-conn-note" style={{ marginTop: 8 }}>
            Connected to your own Drive. You can attach files to a task from its Attachments section. The ERP only sees the files you pick.
          </p>
          <div className="dept-conn-row__form">
            <Button variant="ghost" size="sm" onClick={disconnect} disabled={pending}>Disconnect</Button>
          </div>
        </>
      )}
      {result.kind === "ok" && result.data.configured && !result.data.needsReconnect && !result.data.connected && (
        <>
          <div className="dept-conn-row__main">
            <span className="dept-conn-row__label">Google Drive</span>
            <StatusBadge label="not connected" />
          </div>
          <p className="dept-conn-note" style={{ marginTop: 8 }}>Connect your own Google Drive to attach files to tasks. The ERP only sees the files you pick.</p>
          <div className="dept-conn-row__form">
            <Button size="sm" onClick={start} disabled={pending}>{pending ? "Working…" : "Connect Google Drive"}</Button>
          </div>
        </>
      )}
      {done && <p className="dept-conn-note" role="status" style={{ marginTop: 8 }}>{done}</p>}
      {error && <p className="dept-conn-row__error" role="alert" style={{ marginTop: 8 }}>{error}</p>}
    </>
  );
}

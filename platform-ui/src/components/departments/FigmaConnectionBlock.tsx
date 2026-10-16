"use client";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, StatusBadge } from "@/components/ui";
import type { ReadResult } from "@/lib/readResult";
import { connectFigmaAction, disconnectFigmaAction } from "@/lib/figmaActions";
import { NOT_CONNECTED_LINE, tokenTypeLabel, type FigmaConnection, type FigmaTokenType } from "@/lib/figma";

// DW-6k: the Figma block of the Tools & connections page (BFF §36.1, §36.8). Everyone sees whether the company has a Figma
// token linked, and of which kind. Only a `company.manage` holder is OFFERED the form (the server decides: a 403 is a sentence).
// The token is typed into a password input, sent once, and never shown again: the platform answers with the masked status only,
// and this block keeps no copy of it (the field is cleared the moment the call returns, success or refusal).
//
// Every state is said in words: connected (and which kind), not connected (and what that means for the links), a read the person
// may not see, and a read that failed (which says "unavailable", never "not connected").
export function FigmaConnectionBlock({ result, canManage }: { result: ReadResult<FigmaConnection>; canManage: boolean }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [tokenType, setTokenType] = useState<FigmaTokenType>("pat");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const connected = result.kind === "ok" && result.data.connected;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const token = String(new FormData(e.currentTarget).get("token") ?? "");
    setError(null);
    setDone(null);
    startTransition(async () => {
      const res = await connectFigmaAction(token, tokenType);
      formRef.current?.reset(); // the token leaves the field whatever the answer was
      if (!res.ok) return setError(res.error);
      setDone(`Figma is connected. Token type: ${tokenTypeLabel(res.connection.tokenType)}.`);
      router.refresh();
    });
  }

  function disconnect() {
    setError(null);
    setDone(null);
    startTransition(async () => {
      const res = await disconnectFigmaAction();
      if (!res.ok) return setError(res.error);
      setDone("Figma is disconnected. Linked designs keep their last values, but can't refresh, show previews or export until it is connected again.");
      router.refresh();
    });
  }

  return (
    <>
      {result.kind === "forbidden" && <p className="dept-conn-note">You can&apos;t see whether Figma is connected.</p>}
      {result.kind === "unavailable" && (
        <p className="dept-conn-note">Whether Figma is connected can&apos;t be read right now ({result.reason}). That doesn&apos;t mean it isn&apos;t.</p>
      )}
      {result.kind === "ok" && (
        <>
          <div className="dept-conn-row__main">
            <span className="dept-conn-row__label">Figma</span>
            <StatusBadge label={connected ? "connected" : "not connected"} />
            {connected && <span className="dept-conn-row__account">{tokenTypeLabel(result.data.tokenType)}</span>}
          </div>
          <p className="dept-conn-note" style={{ marginTop: 8 }}>
            {connected
              ? "Figma is connected for this company. Linked designs show previews, change times and open comments, and can be exported into the Asset Library. The token is kept sealed and is never shown."
              : `${NOT_CONNECTED_LINE}. Linked designs still show the values read earlier, but can't refresh, show previews or export until a token is connected.`}
          </p>
        </>
      )}

      {canManage ? (
        <form ref={formRef} className="dept-conn-row__form" onSubmit={submit} aria-label="Connect Figma">
          <label className="dept-conn-note" style={{ margin: 0 }}>
            <span style={{ display: "block" }}>Figma token</span>
            <input
              name="token" type="password" autoComplete="off" spellCheck={false} className="dept-conn-row__input"
              placeholder={connected ? "Paste a new token to replace it" : "Paste a Figma token"} disabled={pending}
            />
          </label>
          <label className="dept-conn-note" style={{ margin: 0 }}>
            <span style={{ display: "block" }}>Token type</span>
            <select
              name="tokenType" value={tokenType} onChange={(e) => setTokenType(e.target.value as FigmaTokenType)}
              className="dept-conn-row__input" disabled={pending}
            >
              <option value="pat">Personal access token</option>
              <option value="oauth">OAuth</option>
            </select>
          </label>
          <Button type="submit" size="sm" disabled={pending}>{pending ? "Working…" : connected ? "Replace token" : "Connect"}</Button>
          {connected && <Button variant="ghost" size="sm" onClick={disconnect} disabled={pending}>Disconnect</Button>}
        </form>
      ) : (
        <p className="dept-conn-note" style={{ marginTop: 8 }}>A manager connects or disconnects Figma for the company.</p>
      )}
      {done && <p className="dept-conn-note" role="status" style={{ marginTop: 8 }}>{done}</p>}
      {error && <p className="dept-conn-row__error" role="alert" style={{ marginTop: 8 }}>{error}</p>}
    </>
  );
}

"use client";
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { blockAddress, liftBlock, revokeSession } from "@/lib/itSecurityActions";
import { BLOCK_DURATIONS, hoursPhrase } from "@/lib/itSecurityView";

// DW-7h (BFF §52.7): the three controls of IT > Network. Each asks before it acts, because each one stops somebody working
// the moment it is confirmed, and says in words what the server answered.
//
// The server decides every refusal (your own session, your own address, a private address, an address many people share), and
// its sentence is shown as it came. The one refusal a form can ANSWER is `shared_address`: it names how many people used the
// address in the last 24 hours, and "block anyway" sends the same request again with `confirmShared`.

/** Sign one session out. Asks first; says whether the sign-in service ended its own session too. */
export function SignOutControl({ userId, sessionId, who }: { userId: string; sessionId: string; who: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    start(async () => {
      const res = await revokeSession(userId, sessionId);
      setAsking(false);
      if (!res.ok) { setError(res.error); return; }
      // `revoked: true` holds even when the sign-in service failed: the ERP itself is cut within seconds either way.
      setNote(
        res.result.keycloak === "ended"
          ? `${who} was signed out.`
          : `${who} was signed out of the ERP. The sign-in service did not confirm ending its own session, so they could sign in again from there.`,
      );
      router.refresh();
    });
  };

  if (note) return <span className="nw-action__note" role="status">{note}</span>;
  return (
    <span className="nw-action">
      {asking ? (
        <span className="nw-action__ask" role="group" aria-label={`Sign ${who} out`}>
          <span className="nw-action__q">Sign {who} out of this session? They can sign in again straight away.</span>
          <Button size="sm" disabled={pending} onClick={run}>{pending ? "Signing out…" : "Sign out"}</Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setAsking(false)}>Keep them signed in</Button>
        </span>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => { setError(null); setAsking(true); }}>Sign out</Button>
      )}
      {error ? <span className="nw-action__error" role="alert">{error}</span> : null}
    </span>
  );
}

/** Lift a block. Asks first. */
export function LiftBlockControl({ blockId, ip }: { blockId: string; ip: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    start(async () => {
      const res = await liftBlock(blockId);
      setAsking(false);
      if (!res.ok) { setError(res.error); router.refresh(); return; }
      router.refresh();
    });
  };

  return (
    <span className="nw-action">
      {asking ? (
        <span className="nw-action__ask" role="group" aria-label={`Lift the block on ${ip}`}>
          <span className="nw-action__q">Let {ip} reach this company again?</span>
          <Button size="sm" disabled={pending} onClick={run}>{pending ? "Lifting…" : "Lift block"}</Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setAsking(false)}>Keep it blocked</Button>
        </span>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => { setError(null); setAsking(true); }}>Lift</Button>
      )}
      {error ? <span className="nw-action__error" role="alert">{error}</span> : null}
    </span>
  );
}

/**
 * Block an address. With `ip` it is the per-row control on Connected (a button that opens a short form for that address); without
 * it, the form on Blocks, where IT types the address.
 */
export function BlockAddressControl({ ip, inline = false }: { ip?: string; inline?: boolean }) {
  const router = useRouter();
  const uid = useId();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(!ip);
  const [address, setAddress] = useState(ip ?? "");
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState(24);
  const [shared, setShared] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; field?: string } | null>(null);

  const submit = (confirmShared: boolean) => {
    setError(null);
    start(async () => {
      const res = await blockAddress({ ip: address, reason, hours, ...(confirmShared ? { confirmShared: true } : {}) });
      if (res.ok) {
        setShared(null);
        setNote(`${res.result.ip} is blocked for ${hoursPhrase(hours)}.`);
        setReason("");
        if (ip) setOpen(false); else setAddress("");
        router.refresh();
        return;
      }
      if (res.reason === "shared_address") {
        // Ask, never block silently: three or more people use this address, so a block would lock them out too.
        setShared(res.users ?? 3);
        return;
      }
      setShared(null);
      setError({ text: res.error, field: res.field });
    });
  };

  const cancel = () => { setShared(null); setError(null); setReason(""); if (ip) setOpen(false); };

  if (!open) {
    return (
      <span className="nw-action">
        {note ? <span className="nw-action__note" role="status">{note}</span> : null}
        <Button size="sm" variant="ghost" onClick={() => { setNote(null); setOpen(true); }}>Block address</Button>
      </span>
    );
  }

  return (
    <form
      className={`nw-form${inline ? " nw-form--inline" : ""}`}
      onSubmit={(e) => { e.preventDefault(); submit(false); }}
      aria-label={ip ? `Block ${ip}` : "Block an address"}
    >
      <label className="nw-form__field" htmlFor={`${uid}-ip`}>
        <span className="nw-form__label">Address</span>
        <input
          id={`${uid}-ip`} className="lux-field__control" type="text" inputMode="text" autoComplete="off" spellCheck={false}
          value={address} readOnly={!!ip} placeholder="203.0.113.25"
          aria-invalid={error?.field === "ip" || undefined}
          onChange={(e) => setAddress(e.target.value)}
        />
      </label>
      <label className="nw-form__field nw-form__field--wide" htmlFor={`${uid}-reason`}>
        <span className="nw-form__label">Reason</span>
        <input
          id={`${uid}-reason`} className="lux-field__control" type="text" autoComplete="off" maxLength={500}
          value={reason} placeholder="Why this address is blocked (kept with the block)"
          aria-invalid={error?.field === "reason" || undefined}
          onChange={(e) => { setReason(e.target.value); setShared(null); }}
        />
      </label>
      <label className="nw-form__field" htmlFor={`${uid}-hours`}>
        <span className="nw-form__label">For</span>
        <select id={`${uid}-hours`} className="lux-field__control" value={hours} onChange={(e) => { setHours(Number(e.target.value)); setShared(null); }}>
          {BLOCK_DURATIONS.map((d) => <option key={d.hours} value={d.hours}>{d.label}</option>)}
        </select>
      </label>

      {shared !== null ? (
        <div className="nw-form__confirm" role="alert">
          <span>
            {shared} {shared === 1 ? "person uses" : "people use"} this address (they connected from it in the last 24 hours).
            Blocking it locks them out of this company too. Block anyway?
          </span>
          <span className="nw-form__buttons">
            <Button size="sm" disabled={pending} onClick={() => submit(true)}>{pending ? "Blocking…" : "Block anyway"}</Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={cancel}>Don&apos;t block</Button>
          </span>
        </div>
      ) : (
        <span className="nw-form__buttons">
          <Button size="sm" type="submit" disabled={pending || !address.trim() || reason.trim().length < 3}>{pending ? "Blocking…" : "Block address"}</Button>
          {ip ? <Button size="sm" variant="ghost" disabled={pending} onClick={cancel}>Cancel</Button> : null}
        </span>
      )}

      {note ? <span className="nw-action__note" role="status">{note}</span> : null}
      {error ? <span className="nw-action__error" role="alert">{error.text}</span> : null}
    </form>
  );
}

"use client";
import { useActionState } from "react";
import { login } from "./actions";
import { Eyebrow, Button } from "@/components/ui";

export default function LoginPage() {
  const [state, action, pending] = useActionState(login, null);
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--surface-page)" }}>
      <form action={action} style={{ width: 380, background: "var(--surface-card)", border: "0.5px solid var(--erp-hairline)", padding: 40, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 28, letterSpacing: "0.14em" }}>GAIADA</div>
          <Eyebrow style={{ opacity: 0.55, marginTop: 7, display: "block" }}>ERP Suite</Eyebrow>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Email</Eyebrow>
          <input name="email" type="email" autoComplete="email" required
            style={{ border: "none", borderBottom: "0.5px solid rgba(26,25,22,.22)", background: "transparent", outline: "none", padding: "8px 2px", font: "400 14px var(--font-body)", color: "var(--text-primary)" }} />
        </label>
        {state?.error && <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-accent)", opacity: 0.8 }}>{state.error}</p>}
        <Button type="submit" size="md" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</Button>
      </form>
    </main>
  );
}

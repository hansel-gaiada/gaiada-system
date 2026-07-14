"use client";
// Catches errors thrown in the root layout itself. Must render its own
// <html>/<body> because it replaces the root layout when it fires.
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "var(--font-body, system-ui)", background: "#F4F1EA", color: "#1A1916" }}>
        <div style={{ textAlign: "center", padding: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>Something went wrong</h1>
          <p style={{ color: "rgba(26,25,22,.6)" }}>The application hit an unexpected error.</p>
          <button
            type="button"
            onClick={() => reset()}
            style={{ marginTop: 12, border: "0.5px solid #6E5A43", background: "#6E5A43", color: "#F4F1EA", padding: "8px 14px", cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.14em", fontSize: 11, fontWeight: 700 }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}

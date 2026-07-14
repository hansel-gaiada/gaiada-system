"use client";
import { useEffect } from "react";
import { StateScreen } from "@/components/Feedback";

// Route-segment error boundary for the app shell. Client component (required
// by Next). `reset` re-renders the segment; a link home is the escape hatch.
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Surface for local debugging; real telemetry hooks in later.
    console.error(error);
  }, [error]);

  return (
    <StateScreen
      code="Error"
      title="Something went wrong"
      body="This page hit an unexpected error. You can try again, or head back to your workspace."
      actions={
        <>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => reset()}>
            Try again
          </button>
          <a href="/" className="lux-btn lux-btn--ghost lux-btn--sm">Back to My Work</a>
        </>
      }
    />
  );
}

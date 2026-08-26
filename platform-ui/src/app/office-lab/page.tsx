import { notFound } from "next/navigation";
import { fixtureScene } from "@/lib/office-fixture";
import { loadSnapshotScene } from "@/lib/office-snapshot";
import { OfficeCanvas } from "@/components/office/OfficeCanvas";

// `/office-lab` — a DEV-ONLY harness for the office RENDERER.
//
// It exists because `/office` cannot be opened without a live platform-nest, which makes the
// animation impossible to work on locally (the local stack is off by standing decision). This route
// mounts the same `OfficeCanvas` against `lib/office-fixture.ts` instead, so movement, the working
// pulse and the automation states can be watched with no backend and no session.
//
// It is NOT a product surface and must never become one: it 404s outside development, it is absent
// from the nav, and it sits outside the `(app)` route group so it never inherits the app shell.
// Every avatar it renders says DEV FIXTURE in its own note.
export const metadata = { title: "Office lab (dev)" };
export const dynamic = "force-dynamic";

export default async function OfficeLabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  // A captured snapshot wins when one is supplied; otherwise invented fixtures. The banner below
  // always says WHICH, because a lab that looks the same either way would let real-data findings
  // be mistaken for fixture artefacts (and vice versa).
  const snapshot = await loadSnapshotScene();
  const scene = snapshot ?? fixtureScene();
  return (
    <main style={{ padding: "1rem", background: "var(--surface-page)", minHeight: "100vh" }}>
      <p
        style={{
          margin: "0 0 0.75rem", padding: "0.5rem 0.75rem",
          border: `1px solid var(--status-${snapshot ? "ok" : "warning"})`, borderRadius: 6,
          font: "600 0.8125rem/1.4 var(--font-body)", color: "var(--ink-strong)",
        }}
      >
        {snapshot ? (
          <>
            DEV HARNESS — REAL SNAPSHOT captured from the live server. Rooms, people, agent goals and
            automations below are real records. Movement is empty on purpose: the O0 event spine is
            not built, so there is no real movement to show.
          </>
        ) : (
          <>
            DEV HARNESS — every person, agent and automation below is invented fixture data. Nothing
            here is real and nothing here is stored. The product surface is <code>/office</code>.
          </>
        )}
      </p>
      <OfficeCanvas scene={scene} initialZoom="fit" />
    </main>
  );
}

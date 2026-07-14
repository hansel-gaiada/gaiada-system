import Link from "next/link";
import { StateScreen } from "@/components/Feedback";

// Root 404 (renders without the app shell — e.g. unknown top-level paths).
export default function RootNotFound() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 20 }}>
      <StateScreen
        code="404"
        title="Page not found"
        body="We couldn't find that page."
        actions={<Link href="/" className="lux-btn lux-btn--solid lux-btn--sm">Go to Gaiada</Link>}
      />
    </main>
  );
}

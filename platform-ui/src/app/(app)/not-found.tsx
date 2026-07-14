import Link from "next/link";
import { StateScreen } from "@/components/Feedback";

export default function AppNotFound() {
  return (
    <StateScreen
      code="404"
      title="Page not found"
      body="We couldn't find that page. It may have moved, or the link is out of date."
      actions={<Link href="/" className="lux-btn lux-btn--solid lux-btn--sm">Back to My Work</Link>}
    />
  );
}

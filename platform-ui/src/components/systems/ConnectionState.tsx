import { Card, Eyebrow } from "@/components/ui";
import "./systems.css";

export function ConnectionState({ system }: { system: string }) {
  return (
    <Card>
      <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Not connected yet</Eyebrow>
      <p className="sys-connection-state__copy">
        {system} admin console isn&apos;t connected yet. It will populate once the backend admin API is available.
      </p>
    </Card>
  );
}

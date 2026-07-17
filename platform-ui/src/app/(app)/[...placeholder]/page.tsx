import { Eyebrow } from "@/components/ui";

export default function Placeholder() {
  return (
    <div style={{ padding: "60px 0", textAlign: "center" }}>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 22 }}>Not yet furnished</div>
      <p style={{ font: "400 14px var(--font-body)", color: "var(--erp-ink-60)", marginTop: 10 }}>
        This module arrives with a later plan. Your navigation is already real.
      </p>
      <Eyebrow style={{ opacity: 0.4, marginTop: 20, display: "block" }}>SYROWATKA · Operating Platform</Eyebrow>
    </div>
  );
}

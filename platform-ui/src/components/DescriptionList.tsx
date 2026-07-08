import type { ReactNode } from "react";
import { Eyebrow } from "@/components/ui";
import "./detail.css";

export function DescriptionList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <div className="lux-dlist">
      {items.map((item) => (
        <div className="lux-dlist__row" key={item.label}>
          <Eyebrow style={{ fontSize: 10, opacity: 0.5 }}>{item.label}</Eyebrow>
          <span className="lux-dlist__value">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

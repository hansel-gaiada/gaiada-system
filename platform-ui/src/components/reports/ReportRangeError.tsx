import { Card } from "@/components/ui";
import { REPORT_MAX_CUSTOM_DAYS } from "@/lib/reports";

// §15 ruling ③ / §6.2: a custom range past REPORT_MAX_CUSTOM_DAYS (400) days 422s as the flat
// `{error:"range_too_large", field:"end"}` body — never a structured `maxDays`, because the
// platform-wide http-error.filter.ts reshapes every HttpException to `{error, field}` and widening
// that shared filter for one endpoint is out of scope here. This renders the FRONTEND-side mirror
// of that 400-day ceiling as a usable message instead of surfacing the raw error code or crashing.
export function ReportRangeError({ days }: { days?: number }) {
  return (
    <Card>
      <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)" }}>
        {days ? `That range is ${days} days` : "That range is too wide"} — narrow it to {REPORT_MAX_CUSTOM_DAYS} days or fewer
        and try again. A custom range this wide is blocked to keep the underlying data scan bounded.
      </p>
    </Card>
  );
}

"use client";
import { useOptimistic, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OVERVIEW_PERIOD_OPTIONS, periodHref, type OverviewPeriod } from "@/lib/overview";

// DW-3a: the one control that sets the period for every number on the Overview (plan §3.2). The choice
// lives in the URL (`?period=`), so a reload, a shared link and the server-rendered blocks all agree.
//
// Quarter, semester and year are drawn and cannot be chosen until the backend reports them (DW-4a): they
// are `aria-disabled`, not `disabled`, so a keyboard user can reach one and hear why, and the reason is
// text the button points at. A click on one does nothing.
export function PeriodSelector({ value }: { value: OverviewPeriod }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [, startTransition] = useTransition();
  // Pressed at once, then settled by the server's answer: the page re-renders from the URL, which can
  // take a moment on a slow read.
  const [shown, setShown] = useOptimistic(value);

  const choose = (key: OverviewPeriod) => {
    if (key === shown) return;
    startTransition(() => {
      setShown(key);
      router.replace(periodHref(pathname, search.toString(), key), { scroll: false });
    });
  };

  return (
    <div className="ov-period" role="group" aria-label="Period">
      {OVERVIEW_PERIOD_OPTIONS.map((o) => {
        const reasonId = `ov-period-why-${o.key}`;
        return (
          <span key={o.key} className="ov-period__item">
            <button
              type="button"
              className="ov-period__btn"
              aria-pressed={shown === o.key}
              aria-disabled={o.disabledReason ? true : undefined}
              aria-describedby={o.disabledReason ? reasonId : undefined}
              title={o.disabledReason}
              onClick={() => (o.disabledReason ? undefined : choose(o.key))}
            >
              {o.label}
            </button>
            {o.disabledReason && <span id={reasonId} className="ov-sr-only">{o.disabledReason}</span>}
          </span>
        );
      })}
    </div>
  );
}

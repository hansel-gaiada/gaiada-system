"use client";
import type { ReactNode } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { ReportDocument } from "@/lib/reports";
import { ReportViewer } from "./ReportViewer";
import type { PeriodSelectorValue } from "./PeriodSelector";
import { RevisionNote } from "./RevisionNote";

// Shared client shell for all four grain pages: wires `PeriodSelector` to the URL
// (`?periodKind=custom&start=&end=`, shareable/bookmarkable per TR-17's acceptance bar) and layers
// `RevisionNote` above `ReportViewer`. The server page (grain-specific) resolves the document (or
// renders an error branch itself, before this ever mounts) and passes the grain-specific chart
// composition as `children` — a plain server component tree, perfectly fine to pass through a
// client boundary as opaque children (it never needs the client-side period/router state itself).
export function ReportPageClient({ document, todayIso, children }: {
  document: ReportDocument;
  todayIso: string;
  children?: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const { header } = document;

  const value: PeriodSelectorValue = { kind: header.periodKind, start: header.periodStart, end: header.periodEnd };

  function onChange(next: PeriodSelectorValue) {
    const params = new URLSearchParams(sp.toString());
    params.set("periodKind", next.kind);
    params.set("start", next.start);
    params.set("end", next.end);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <>
      <RevisionNote header={header} />
      <ReportViewer document={document} periodControl={{ value, onChange, todayIso }} scopeHeading={false}>
        {children}
      </ReportViewer>
    </>
  );
}

"use client";
import { useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { setPmScope } from "@/lib/pmScopeActions";
import { encodePmScope, type PmScope } from "@/lib/pmScope";
import { PM_TERMS } from "@/lib/pmVocabulary";
import "./scope-switcher.css";

// Repsona's project dropdown (plan §1.1) — whose TOP entry is always "Cross project" (`@all`),
// then every department, then every project. Selecting an entry persists it (P4-A4, same
// cookie-write-then-redirect shape as `TenantSwitcher`) and returns to the SAME view the user was
// on — `usePathname`/`useSearchParams` read the current `?view=`, so switching scope on the Gantt
// tab keeps you on the Gantt tab, just re-scoped, exactly like Repsona's own switcher never changes
// what you're looking at.
//
// A `<select>` inside a server-component `<form action={setPmScope}>` only submits on an explicit
// submit event — there's no click on a `<select>` — so this client wrapper submits as soon as the
// selection changes, keeping the actual cookie write a server action (same trick as
// `TenantSwitcher`).
export function ScopeSwitcher({
  current, departments, projects,
}: {
  current: PmScope;
  departments: { id: string; name: string }[];
  projects: { id: string; name: string }[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const pathname = usePathname();
  const search = useSearchParams();
  const qs = search.toString();
  const next = qs ? `${pathname}?${qs}` : pathname;

  return (
    <form ref={formRef} action={setPmScope} className="pm-scope">
      <input type="hidden" name="next" value={next} />
      <select
        name="scope"
        className="pm-scope__select"
        defaultValue={encodePmScope(current)}
        aria-label="PM scope"
        onChange={() => formRef.current?.requestSubmit()}
      >
        <option value="all">{PM_TERMS.crossProject}</option>
        {departments.length > 0 && (
          <optgroup label="Departments">
            {departments.map((d) => <option key={d.id} value={`department:${d.id}`}>{d.name}</option>)}
          </optgroup>
        )}
        {projects.length > 0 && (
          <optgroup label="Projects">
            {projects.map((p) => <option key={p.id} value={`project:${p.id}`}>{p.name}</option>)}
          </optgroup>
        )}
      </select>
      <noscript><button type="submit">Switch</button></noscript>
    </form>
  );
}

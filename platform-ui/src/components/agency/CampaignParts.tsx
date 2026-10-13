"use client";
// DW-5b — the Parts section of the campaign page (contract §31). Each part: department, owner, status, due date,
// allocation, linked work and request counts. The controls shown here are COSMETIC: the page decides who is offered
// what (`canEdit` per part, `canManage` for money and membership) and the server refuses anything it must, so a 403
// from an action renders as a sentence below the control, never as a silent no-op.
//
// Money: every figure is the server's minor-unit integer, formatted. The only number this file produces is what a
// person typed, converted exactly by `parseMoneyInput`; it never adds or subtracts money.
import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, StatusBadge } from "@/components/ui";
import { Field } from "@/components/forms/Field";
import {
  PART_STATUSES, allocationText, linkAccessNote, moneyText, parseMoneyInput, majorText, partUnitText, requestsText,
  type CampaignPart, type LinkAccess, type PartStatus,
} from "@/lib/campaigns";
import { addPartAction, removePartAction, updatePartAction, type PartPatch } from "@/lib/campaignActions";
import { formatDate } from "@/lib/format";
import "@/components/forms/forms.css";
import "./campaigns.css";

export interface PartCard {
  part: CampaignPart;
  /** May this person be offered status, owner, brief and due date? Manager, the part's owner, or the department head. */
  canEdit: boolean;
}

export interface CampaignPartsProps {
  campaignId: string;
  /** The campaign's currency, or null while it has no budget. */
  currency: string | null;
  /** The campaign has a budget AND a currency: an allocation can be set. */
  hasBudget: boolean;
  parts: PartCard[];
  /** Add or remove a department, set an allocation. */
  canManage: boolean;
  departments: { id: string; name: string }[];
  /** The company's people for the owner pickers; null when the directory could not be read. */
  people: { id: string; name: string }[] | null;
  linkAccess: { searchCampaigns: LinkAccess; socialCampaigns: LinkAccess };
}

type Mode = "view" | "edit" | "allocation" | "remove";

const val = (fd: FormData, k: string) => String(fd.get(k) ?? "");

/** Owner picker options: the people list, plus the current owner when they are not in it (or the list is unread). */
function ownerOptions(people: CampaignPartsProps["people"], current: { id: string | null; name: string | null }) {
  const opts = (people ?? []).map((p) => ({ value: p.id, label: p.name }));
  if (current.id && !opts.some((o) => o.value === current.id)) opts.unshift({ value: current.id, label: current.name ?? current.id });
  return opts;
}

export function CampaignParts(props: CampaignPartsProps) {
  const { campaignId, currency, hasBudget, parts, canManage, departments, people, linkAccess } = props;
  const taken = new Set(parts.map((p) => p.part.unitId));
  const addable = departments.filter((d) => !taken.has(d.id));
  return (
    <div className="cmp-parts">
      {parts.length === 0 ? (
        <p className="cmp-empty">No department has a part in this campaign yet.</p>
      ) : (
        parts.map((c) => (
          <PartCardView
            key={c.part.id} card={c} campaignId={campaignId} currency={currency} hasBudget={hasBudget}
            canManage={canManage} people={people} linkAccess={linkAccess}
          />
        ))
      )}
      {canManage && (
        <AddPart campaignId={campaignId} currency={currency} hasBudget={hasBudget} departments={addable} people={people} />
      )}
    </div>
  );
}

// ── one part ─────────────────────────────────────────────────────────────────────────────────────

function PartCardView({
  card, campaignId, currency, hasBudget, canManage, people, linkAccess,
}: {
  card: PartCard; campaignId: string; currency: string | null; hasBudget: boolean; canManage: boolean;
  people: CampaignPartsProps["people"]; linkAccess: CampaignPartsProps["linkAccess"];
}) {
  const { part, canEdit } = card;
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("view");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function done() {
    setMode("view");
    router.refresh();
  }

  function patch(body: PartPatch) {
    setError(null);
    startTransition(async () => {
      const res = await updatePartAction(campaignId, part.id, body, currency);
      if (!res.ok) return setError(res.error);
      done();
    });
  }

  function saveWork(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body: PartPatch = {};
    const status = val(fd, "status");
    if (status && status !== part.status) body.status = status as PartStatus;
    const owner = val(fd, "ownerId");
    if (people !== null && (owner || null) !== part.ownerId) body.ownerId = owner || null;
    const brief = val(fd, "brief");
    if (brief !== part.brief) body.brief = brief;
    const due = val(fd, "dueOn");
    if ((due || null) !== part.dueOn) body.dueOn = due || null;
    if (Object.keys(body).length === 0) return done();
    patch(body);
  }

  function saveAllocation(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = parseMoneyInput(val(new FormData(e.currentTarget), "allocation"), currency);
    if (!parsed.ok) return setError(parsed.error);
    if (parsed.minor === part.budgetMinor) return done();
    patch({ budgetMinor: parsed.minor });
  }

  function remove() {
    setError(null);
    startTransition(async () => {
      const res = await removePartAction(campaignId, part.id);
      if (!res.ok) return setError(res.error);
      done();
    });
  }

  const cancel = () => { setMode("view"); setError(null); };
  const unitText = partUnitText(part);

  return (
    <article className={`cmp-part${part.status === "cancelled" ? " cmp-part--cancelled" : ""}`} aria-label={`Part: ${unitText}`}>
      <div className="cmp-part__head">
        <h4 className={`cmp-part__unit${part.unitMissing ? " cmp-part__unit--missing" : ""}`}>{unitText}</h4>
        <StatusBadge label={part.status} />
      </div>

      <dl className="cmp-part__facts">
        <div className="cmp-fact"><dt>Owner</dt><dd>{part.ownerName ?? (part.ownerId ? "Unknown person" : "No owner yet")}</dd></div>
        <div className="cmp-fact"><dt>Due</dt><dd>{part.dueOn ? formatDate(part.dueOn) : "No due date"}</dd></div>
        <div className="cmp-fact"><dt>Allocation</dt><dd>{allocationText(part, currency)}</dd></div>
        <div className="cmp-fact"><dt>Requests</dt><dd>{requestsText(part.requests)}</dd></div>
      </dl>

      {part.brief ? <p className="cmp-part__brief">{part.brief}</p> : null}

      <PartLinks part={part} linkAccess={linkAccess} />

      {mode === "edit" && (
        <form className="cmp-form" onSubmit={saveWork} aria-label={`Edit the ${unitText} part`}>
          <div className="cmp-form__row">
            <Field name="status" label="Status" type="select" defaultValue={part.status} optionItems={PART_STATUSES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))} />
            <Field
              name="ownerId" label="Owner" type="select" defaultValue={part.ownerId ?? ""} placeholder="No owner"
              optionItems={ownerOptions(people, { id: part.ownerId, name: part.ownerName })}
              disabled={people === null}
              hint={people === null ? "The list of people could not be read, so the owner cannot be changed now." : undefined}
            />
            <Field name="dueOn" label="Due date" type="date" defaultValue={part.dueOn ?? ""} />
          </div>
          <Field name="brief" label="Brief" type="textarea" defaultValue={part.brief} hint="Plain text, up to 4,000 characters." />
          {error && <p className="cmp-error" role="alert">{error}</p>}
          <div className="cmp-actions">
            <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save part"}</Button>
            <Button variant="ghost" size="sm" onClick={cancel} disabled={pending}>Cancel</Button>
          </div>
        </form>
      )}

      {mode === "allocation" && (
        <form className="cmp-form" onSubmit={saveAllocation} aria-label={`Set the ${unitText} allocation`}>
          {hasBudget ? (
            <Field
              name="allocation" label={`Allocation${currency ? ` (${currency})` : ""}`} type="text"
              defaultValue={majorText(part.budgetMinor, currency)} placeholder="Leave blank for no allocation"
              hint="Taken from the campaign budget. The server refuses an allocation that takes the parts above it."
            />
          ) : (
            <p className="cmp-note">Set the campaign&apos;s budget and currency first. A part&apos;s allocation is taken from that budget.</p>
          )}
          {error && <p className="cmp-error" role="alert">{error}</p>}
          <div className="cmp-actions">
            {hasBudget && <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save allocation"}</Button>}
            <Button variant="ghost" size="sm" onClick={cancel} disabled={pending}>{hasBudget ? "Cancel" : "Close"}</Button>
          </div>
        </form>
      )}

      {mode === "remove" && (
        <div className="cmp-form">
          <p className="cmp-note">
            Remove {unitText} from this campaign? Cancelling the part is the normal way to stop work; a part with linked
            work or requests cannot be removed.
          </p>
          {error && <p className="cmp-error" role="alert">{error}</p>}
          <div className="cmp-actions">
            <Button size="sm" onClick={remove} disabled={pending}>{pending ? "Removing…" : "Remove part"}</Button>
            <Button variant="ghost" size="sm" onClick={cancel} disabled={pending}>Keep it</Button>
          </div>
        </div>
      )}

      {mode === "view" && (canEdit || canManage) && (
        <div className="cmp-actions">
          {canEdit && <Button variant="ghost" size="sm" onClick={() => setMode("edit")}>Edit part</Button>}
          {canManage && <Button variant="ghost" size="sm" onClick={() => setMode("allocation")}>Set allocation</Button>}
          {canManage && <Button variant="ghost" size="sm" onClick={() => setMode("remove")}>Remove</Button>}
        </div>
      )}
      {mode === "view" && error && <p className="cmp-error" role="alert">{error}</p>}
    </article>
  );
}

// ── the work linked to a part ────────────────────────────────────────────────────────────────────

function PartLinks({ part, linkAccess }: { part: CampaignPart; linkAccess: CampaignPartsProps["linkAccess"] }) {
  const searchNote = linkAccessNote("search_campaign", linkAccess.searchCampaigns);
  const socialNote = linkAccessNote("social_campaign", linkAccess.socialCampaigns);
  return (
    <div className="cmp-links">
      <div className="cmp-links__group">
        <span className="cmp-links__title">SEO campaigns</span>
        {searchNote ? (
          <p className="cmp-note">{searchNote}</p>
        ) : part.links.searchCampaigns.length === 0 ? (
          <p className="cmp-note">None linked.</p>
        ) : (
          <ul className="cmp-links__list">
            {part.links.searchCampaigns.map((s) => (
              <li key={s.id} className="cmp-links__item">
                <span>{s.name}</span>
                <StatusBadge label={s.status} />
                {/* Its own budget and currency, beside the part: never added into the shared campaign's figures (§31.3 rule 8). */}
                {s.budgetMinor !== null ? <span className="cmp-links__own">Own budget {moneyText(s.budgetMinor, s.currency)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="cmp-links__group">
        <span className="cmp-links__title">Social campaigns</span>
        {socialNote ? (
          <p className="cmp-note">{socialNote}</p>
        ) : part.links.socialCampaigns.length === 0 ? (
          <p className="cmp-note">None linked.</p>
        ) : (
          <ul className="cmp-links__list">
            {part.links.socialCampaigns.map((s) => (
              <li key={s.id} className="cmp-links__item">
                <span>{s.name}</span>
                <StatusBadge label={s.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── add a department ─────────────────────────────────────────────────────────────────────────────

function AddPart({
  campaignId, currency, hasBudget, departments, people,
}: {
  campaignId: string; currency: string | null; hasBudget: boolean;
  departments: { id: string; name: string }[]; people: CampaignPartsProps["people"];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const unitId = val(fd, "unitId");
    if (!unitId) return setError("Choose a department.");
    const input: Parameters<typeof addPartAction>[1] = { unitId };
    const owner = val(fd, "ownerId");
    if (owner) input.ownerId = owner;
    const brief = val(fd, "brief");
    if (brief) input.brief = brief;
    const due = val(fd, "dueOn");
    if (due) input.dueOn = due;
    if (hasBudget) {
      const parsed = parseMoneyInput(val(fd, "allocation"), currency);
      if (!parsed.ok) return setError(parsed.error);
      if (parsed.minor !== null) input.budgetMinor = parsed.minor;
    }
    setError(null);
    startTransition(async () => {
      const res = await addPartAction(campaignId, input, currency);
      if (!res.ok) return setError(res.error);
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <div className="cmp-actions">
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)} disabled={departments.length === 0}>Add a department</Button>
        {departments.length === 0 && <span className="cmp-note">Every department of this company already has a part, or the org chart could not be read.</span>}
      </div>
    );
  }
  return (
    <form className="cmp-form" onSubmit={submit} aria-label="Add a department to this campaign">
      <div className="cmp-form__row">
        <Field name="unitId" label="Department" type="select" required placeholder="Choose a department" optionItems={departments.map((d) => ({ value: d.id, label: d.name }))} />
        <Field
          name="ownerId" label="Owner" type="select" placeholder="No owner yet" optionItems={ownerOptions(people, { id: null, name: null })}
          disabled={people === null} hint={people === null ? "The list of people could not be read." : undefined}
        />
        <Field name="dueOn" label="Due date" type="date" />
        {hasBudget && (
          <Field name="allocation" label={`Allocation${currency ? ` (${currency})` : ""}`} type="text" placeholder="Optional" hint="Taken from the campaign budget." />
        )}
      </div>
      {!hasBudget && <p className="cmp-note">This campaign has no budget yet, so a part cannot hold an allocation. Set the budget and currency first.</p>}
      <Field name="brief" label="Brief" type="textarea" hint="Plain text, up to 4,000 characters." />
      {error && <p className="cmp-error" role="alert">{error}</p>}
      <div className="cmp-actions">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Adding…" : "Add department"}</Button>
        <Button variant="ghost" size="sm" onClick={() => { setOpen(false); setError(null); }} disabled={pending}>Cancel</Button>
      </div>
    </form>
  );
}

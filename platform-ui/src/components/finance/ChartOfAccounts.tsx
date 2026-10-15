"use client";
import { useState, useTransition } from "react";
import { Card, Button, HairlineTable, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { addAccount, editAccount, archiveAccount, restoreAccount } from "@/lib/financeAccountActions";
import {
  ACCOUNT_CODE_PATTERN, ACCOUNT_DESCRIPTION_MAX, ACCOUNT_NAME_MAX, ACCOUNT_TYPES, defaultNormalBalance, usedByWords,
  type AccountUsedBy, type ChartActionResult,
} from "@/lib/chartOfAccounts";
import type { Account, AccountType, NormalBalance } from "@/lib/finance";

// DW-7g-2 — Finance > Chart of accounts: the read-only chart of today, plus New account, Rename and Archive or Restore for
// the people the server allows (BFF §49).
//
// ── THE CONTROLS ARE COSMETIC, THE SERVER REFUSES IN WORDS ──────────────────────────────────────────────────────
// `canEdit` is a superset of the Cerbos `finance_config` rule (see `canEditChart`). It decides whether the controls are
// DRAWN; the server decides what happens when one is used. Every refusal (a taken code, a balance, a child, a control
// account, a posting rule still pointing at it, a frozen code, an archived parent) comes back as the server's own sentence with
// its machine reason, and `account_in_use` with the tables that still use the account. Nothing is guessed here.
//
// ── ONLY WHAT THE SERVER RETURNED ────────────────────────────────────────────────────────────────────────────────
// The rows come from the page's read (`GET finance/accounts`), which re-runs after every action (the actions revalidate the
// route), so a row never shows a state this component invented. The code field is locked once `hasPostings` is true: the
// database freezes it then, and a locked field with its reason beats a form that submits and fails.
//
// ── ARCHIVED ACCOUNTS ARE HIDDEN BY DEFAULT ──────────────────────────────────────────────────────────────────────
// An archived account refuses new postings and keeps its history. The "Show archived" switch lists them, marked.
const GROUPS: Array<{ type: AccountType; label: string }> = [
  { type: "asset", label: "Assets" },
  { type: "liability", label: "Liabilities" },
  { type: "equity", label: "Equity" },
  { type: "revenue", label: "Revenue" },
  { type: "expense", label: "Expenses" },
];

interface Refusal { error: string; reason?: string; usedBy?: AccountUsedBy[] }

function RowButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: string }) {
  return (
    <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={label} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/** Name, description, and the code (locked once the account has postings). Only the fields that changed are sent. */
function RenameForm({
  account, onDone, onFailed, onCancel,
}: {
  account: Account;
  onDone: (message: string) => void;
  onFailed: (r: ChartActionResult<unknown>) => void;
  onCancel: () => void;
}) {
  const [pending, start] = useTransition();
  const [name, setName] = useState(account.name);
  const [description, setDescription] = useState(account.description ?? "");
  const [code, setCode] = useState(account.code);
  const locked = account.hasPostings;

  function submit() {
    const input: { name?: string; description?: string | null; newCode?: string } = {};
    if (name.trim() !== account.name) input.name = name;
    if (description.trim() !== (account.description ?? "")) input.description = description;
    if (!locked && code.trim() !== account.code) input.newCode = code;
    start(async () => {
      const r = await editAccount(account.code, input);
      if (!r.ok) return onFailed(r);
      onDone(`Saved ${r.result?.code ?? account.code}.`);
    });
  }

  return (
    <Card title={`Rename ${account.code} · ${account.name}`} style={{ marginTop: 22 }}>
      <form className="fin-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="fin-form__field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={ACCOUNT_NAME_MAX} autoComplete="off" />
        </label>
        <div className="fin-form__field">
          <label htmlFor={`rename-code-${account.code}`}>Code</label>
          <input
            id={`rename-code-${account.code}`}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={locked}
            aria-describedby={locked ? `rename-code-why-${account.code}` : undefined}
            maxLength={20}
            autoComplete="off"
          />
          {locked ? (
            <span id={`rename-code-why-${account.code}`}>
              The code is locked: this account has postings, and changing it would rewrite history. Archive it and create a new
              one instead.
            </span>
          ) : (
            <span>Free to change until the first posting.</span>
          )}
        </div>
        <label className="fin-form__field fin-form__field--wide">
          <span>Description</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={ACCOUNT_DESCRIPTION_MAX} rows={2} />
        </label>
        <div className="fin-form__actions">
          <Button type="submit" disabled={pending}>{pending ? "Working…" : "Save"}</Button>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

const BLANK = {
  code: "", name: "", accountType: "asset" as AccountType, normalBalance: "debit" as NormalBalance, normalTouched: false,
  parentCode: "", isPostable: true, currencyCode: "", description: "",
};

function NewAccountForm({
  accounts, onDone, onFailed,
}: {
  accounts: Account[];
  onDone: (message: string) => void;
  onFailed: (r: ChartActionResult<unknown>) => void;
}) {
  const [pending, start] = useTransition();
  const [f, setF] = useState(BLANK);
  // §49.2: a parent is a live, active HEADER (not postable) of the same type.
  const parents = accounts.filter((a) => !a.isPostable && a.accountType === f.accountType && a.status === "active");

  function chooseType(t: AccountType) {
    setF((s) => ({
      ...s,
      accountType: t,
      // The default follows the type until somebody overrides it (a contra account).
      normalBalance: s.normalTouched ? s.normalBalance : defaultNormalBalance(t),
      parentCode: "",
    }));
  }

  function submit() {
    start(async () => {
      const r = await addAccount({
        code: f.code, name: f.name, accountType: f.accountType, normalBalance: f.normalBalance,
        parentCode: f.parentCode || null, isPostable: f.isPostable, currencyCode: f.currencyCode || null, description: f.description,
      });
      if (!r.ok) return onFailed(r);
      setF(BLANK);
      onDone(`Added account ${r.result?.code ?? f.code.trim()}.`);
    });
  }

  const ready = ACCOUNT_CODE_PATTERN.test(f.code.trim()) && f.name.trim().length > 0;

  return (
    <Card
      title="New account"
      hint="A control account (receivables, payables, inventory, fixed assets) comes from the template and its subledger, so it is not added here. The normal balance follows the type; change it for a contra account."
      style={{ marginTop: 22 }}
    >
      <form className="fin-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="fin-form__field">
          <span>Code</span>
          <input value={f.code} onChange={(e) => setF((s) => ({ ...s, code: e.target.value }))} maxLength={20} autoComplete="off" placeholder="e.g. 6950" />
        </label>
        <label className="fin-form__field">
          <span>Name</span>
          <input value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} maxLength={ACCOUNT_NAME_MAX} autoComplete="off" />
        </label>
        <label className="fin-form__field">
          <span>Type</span>
          <select value={f.accountType} onChange={(e) => chooseType(e.target.value as AccountType)}>
            {ACCOUNT_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
          </select>
        </label>
        <label className="fin-form__field">
          <span>Normal balance</span>
          <select
            value={f.normalBalance}
            onChange={(e) => setF((s) => ({ ...s, normalBalance: e.target.value as NormalBalance, normalTouched: true }))}
          >
            <option value="debit">Debit</option>
            <option value="credit">Credit</option>
          </select>
        </label>
        <label className="fin-form__field">
          <span>Parent (a header of the same type)</span>
          <select value={f.parentCode} onChange={(e) => setF((s) => ({ ...s, parentCode: e.target.value }))}>
            <option value="">No parent (top level)</option>
            {parents.map((p) => <option key={p.code} value={p.code}>{p.code} · {p.name}</option>)}
          </select>
        </label>
        <label className="fin-form__field">
          <span>Currency (optional)</span>
          <input
            value={f.currencyCode}
            onChange={(e) => setF((s) => ({ ...s, currencyCode: e.target.value.toUpperCase() }))}
            maxLength={3}
            autoComplete="off"
            placeholder="company currency"
          />
        </label>
        <label className="fin-form__field">
          <span>
            <input type="checkbox" checked={f.isPostable} onChange={(e) => setF((s) => ({ ...s, isPostable: e.target.checked }))} />{" "}
            Postable
          </span>
          <span>Untick to make a header that only groups other accounts.</span>
        </label>
        <label className="fin-form__field fin-form__field--wide">
          <span>Description (optional)</span>
          <textarea value={f.description} onChange={(e) => setF((s) => ({ ...s, description: e.target.value }))} maxLength={ACCOUNT_DESCRIPTION_MAX} rows={2} />
        </label>
        <div className="fin-form__actions">
          <Button type="submit" disabled={!ready || pending}>{pending ? "Working…" : "Add account"}</Button>
        </div>
      </form>
    </Card>
  );
}

export function ChartOfAccounts({
  accounts, canEdit, query,
}: {
  accounts: Account[];
  /** Show New account, Rename and Archive or Restore. Cosmetic: the server refuses in words. */
  canEdit: boolean;
  /** The page's code-or-name filter, only to word the empty state. */
  query?: string;
}) {
  const [pending, start] = useTransition();
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const clear = () => { setRefusal(null); setNotice(null); };
  const fail = (r: ChartActionResult<unknown>) =>
    setRefusal({ error: r.error ?? "That did not go through.", ...(r.reason ? { reason: r.reason } : {}), ...(r.usedBy ? { usedBy: r.usedBy } : {}) });

  function toggle(a: Account, restore: boolean) {
    clear();
    start(async () => {
      const r = await (restore ? restoreAccount(a.code) : archiveAccount(a.code));
      if (!r.ok) return fail(r);
      setNotice(
        restore
          ? `Restored ${a.code} (${a.name}). It accepts postings again.`
          : `Archived ${a.code} (${a.name}). It refuses new postings; its history stays.`,
      );
    });
  }

  const archivedCount = accounts.filter((a) => a.status === "archived").length;
  const visible = [...accounts]
    .filter((a) => showArchived || a.status !== "archived")
    .sort((a, b) => a.code.localeCompare(b.code));
  const grouped = GROUPS.map((g) => ({ ...g, rows: visible.filter((a) => a.accountType === g.type) })).filter((g) => g.rows.length > 0);
  const renamingRow = renaming ? accounts.find((a) => a.code === renaming) ?? null : null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" role="switch" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          <span>Show archived</span>
        </label>
        {!showArchived && archivedCount > 0 ? (
          <span className="fin-muted">{archivedCount} archived account{archivedCount === 1 ? " is" : "s are"} hidden.</span>
        ) : null}
      </div>

      {accounts.length === 0 ? (
        <EmptyNote>
          {query
            ? `No account matches "${query}". The filter is on code and name; it does not search balances.`
            : "This company has no chart of accounts yet. Run the finance configuration seed to instantiate one from the Indonesian template."}
        </EmptyNote>
      ) : visible.length === 0 ? (
        <EmptyNote>Every account in this view is archived. Turn on Show archived to list them.</EmptyNote>
      ) : (
        grouped.map((g) => (
          <section key={g.type} style={{ marginBottom: 26 }}>
            <Eyebrow>{g.label}</Eyebrow>
            <HairlineTable
              columns={[
                { label: "Code" }, { label: "Name" }, { label: "Normal balance" },
                { label: "Manual posting" }, { label: "Control" }, ...(canEdit ? [{ label: "Action" }] : []),
              ]}
              rows={g.rows.map((a) => {
                const archived = a.status === "archived";
                return [
                  a.code,
                  <span key="n">
                    {a.name}
                    {archived ? <span className="fin-muted"> (archived)</span> : null}
                  </span>,
                  a.normalBalance,
                  // Stated as a refusal, not left blank: blank would read as "unknown" when it means "the subledger owns this".
                  a.allowManualPosting ? "allowed" : "subledger only",
                  a.isControl ? (a.controlSubledger ?? "control") : "—",
                  ...(canEdit
                    ? [
                        <span key="a" className="fin-form__actions" style={{ margin: 0 }}>
                          <RowButton label={`Rename ${a.code}`} onClick={() => { clear(); setRenaming(a.code); }} disabled={pending}>Rename</RowButton>
                          {archived ? (
                            <RowButton label={`Restore ${a.code}`} onClick={() => toggle(a, true)} disabled={pending}>Restore</RowButton>
                          ) : (
                            <RowButton label={`Archive ${a.code}`} onClick={() => toggle(a, false)} disabled={pending}>Archive</RowButton>
                          )}
                        </span>,
                      ]
                    : []),
                ];
              })}
            />
          </section>
        ))
      )}

      {renamingRow ? (
        <RenameForm
          key={renamingRow.code}
          account={renamingRow}
          onCancel={() => setRenaming(null)}
          onFailed={fail}
          onDone={(m) => { setRenaming(null); setNotice(m); }}
        />
      ) : null}

      {canEdit ? <NewAccountForm accounts={accounts} onFailed={(r) => { clear(); fail(r); }} onDone={(m) => { clear(); setNotice(m); }} /> : null}

      {refusal ? (
        <div className="fin-form__error" role="alert" style={{ marginTop: 12 }}>
          <p style={{ margin: 0 }}>{refusal.error}</p>
          {refusal.usedBy ? <p style={{ margin: "4px 0 0" }}>Still used by: {usedByWords(refusal.usedBy)}.</p> : null}
          {refusal.reason ? <p className="fin-muted" style={{ margin: "4px 0 0" }}>Reason: <code>{refusal.reason}</code></p> : null}
        </div>
      ) : null}
      {notice ? <p className="fin-muted" role="status" style={{ marginTop: 12 }}>{notice}</p> : null}
    </div>
  );
}

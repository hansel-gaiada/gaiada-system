// Shared inclusion-tagged envelope shape (UX-2 daily-work spec §4.2/§6, A16 graft): every
// cross-company / cross-served-company list response wraps its rows in this shape so the UI can
// render excluded companies as a "N more you can't view" count instead of silently dropping them.
// Types only — assembly happens at each call site, since what counts as "excluded" differs per
// read (permission denial, cross-holding boundary, a requested id that no longer resolves, ...).
export interface EnvelopeCompany {
  id: string;
  // F1 (ORG-14): name is present ONLY when included===true. An excluded company must never carry
  // a resolved display name — that would make this envelope a cross-holding UUID->name oracle for
  // any caller who can enumerate ids but not read them. Excluded entries are {id, included:false,
  // reason} only.
  name?: string;
  included: boolean;
  reason?: "no_access" | "not_served" | "suspended" | "error";
}

export interface Envelope<T> {
  items: T[];
  companies: EnvelopeCompany[];
}

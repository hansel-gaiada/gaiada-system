// PV5-04b — invoice numbering (ruling PV-D35). Client-safe (no I/O): the billing profile page, the invoice page and their tests
// import these types and rules; the reader is `billingNumbering-data.ts` and the writes are `billingNumberingActions.ts`.
//
// An invoice number reads `{company}/{yyyy}/{mm}/{code}/{nnnn}`, e.g. `GDA/2026/10/7K3/0001`. The `{code}` stands for a service
// line and the client's business type. It is deliberately NOT mnemonic: a client cannot easily read it, and STAFF decode it here.
// So nothing in this file, nor anything that renders it, may appear in the client portal.
//
// Backend: `platform-nest/src/modules/invoice/billing-numbering.controller.ts` (BFF §30).

export interface ServiceLine {
  key: string;
  name: string;
  /** An org department id this line is linked to (an invoice then defaults to it), or null. */
  departmentId: string | null;
  active: boolean;
  updatedAt: string;
  /** How many live invoices are filed under this line. */
  invoiceCount: number;
}

export interface NumberCodeRow {
  serviceLineKey: string;
  serviceLineName: string;
  businessType: string;
  businessTypeLabel: string;
  code: string;
  createdAt: string;
  invoiceCount: number;
  /** An issued invoice carries this code. (A code is never edited, used or not.) */
  used: boolean;
}

export interface NumberCodes {
  codes: NumberCodeRow[];
  /** The client business types a code can be pre-assigned for (the client centre's list). */
  businessTypes: { id: string; label: string }[];
}

/** The number's shape, as the owner ruled it (PV-D35). Shown wherever staff are told what a number is made of. */
export const NUMBER_FORMAT = "{company}/{yyyy}/{mm}/{code}/{nnnn}";

/** The key of a service line: a lower-case letter, then lower-case letters, digits or `_`; 2 to 32 characters. */
export const SERVICE_LINE_KEY = /^[a-z][a-z0-9_]{1,31}$/;
/** A number code someone may type when pre-assigning: 2 to 4 capital letters or digits. Left blank, one is generated. */
export const NUMBER_CODE = /^[A-Z0-9]{2,4}$/;

/** A key suggested from a name (`Web development` becomes `web_development`), for the add form. Never sent unchecked. */
export function suggestKey(name: string): string {
  const k = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  return /^[a-z]/.test(k) ? k : k ? `l_${k}`.slice(0, 32) : "";
}

export function validateServiceLine(v: { key: string; name: string }): { field: "key" | "name"; message: string } | null {
  if (!v.name.trim()) return { field: "name", message: "Give the service line a name." };
  if (v.name.trim().length > 120) return { field: "name", message: "The name is at most 120 characters." };
  if (!SERVICE_LINE_KEY.test(v.key.trim())) {
    return { field: "key", message: "The key is 2 to 32 characters: a lower-case letter, then lower-case letters, digits or an underscore." };
  }
  return null;
}

export function validatePreassign(v: { serviceLineKey: string; businessType: string; code: string }): { field: "serviceLineKey" | "businessType" | "code"; message: string } | null {
  if (!v.serviceLineKey) return { field: "serviceLineKey", message: "Pick a service line." };
  if (!v.businessType) return { field: "businessType", message: "Pick a client business type." };
  const code = v.code.trim();
  if (code && !NUMBER_CODE.test(code)) return { field: "code", message: "A code is 2 to 4 capital letters or digits. Leave it blank to have one generated." };
  return null;
}

/** The parts of an issued number, or null when it is not in the PV-D35 shape (an older, legacy number). Staff-side only. */
export function numberParts(no: string | null | undefined): { prefix: string; year: string; month: string; code: string; seq: string } | null {
  const m = /^(.+)\/(\d{4})\/(\d{2})\/([A-Z0-9]{2,4})\/(\d{4,})$/.exec((no ?? "").trim());
  return m ? { prefix: m[1], year: m[2], month: m[3], code: m[4], seq: m[5] } : null;
}

/** What a number's code stands for, in words, for the staff invoice page. `null` when nothing was recorded. */
export function decodeText(d: { serviceLineName: string | null; serviceLineKey: string; businessType: string } | null | undefined, businessTypeLabel?: string): string | null {
  if (!d) return null;
  return `${d.serviceLineName ?? d.serviceLineKey} · ${businessTypeLabel ?? d.businessType}`;
}

/** The number codes route's refusals in plain words. Branch on `reason`, never on the message text. */
export function numberingErrorText(status: number | null, reason: string | undefined, message: string): string {
  if (status === 403) return "Changing invoice numbering is limited to finance managers and company administrators.";
  if (status === 409) {
    switch (reason) {
      case "code_already_assigned":
        return "That service line and business type already have a code. A code is never changed, because an invoice may already carry it.";
      case "code_taken":
        return "That code already stands for another pair in this company. Pick another, or leave it blank to have one generated.";
      default:
        return message;
    }
  }
  return message;
}

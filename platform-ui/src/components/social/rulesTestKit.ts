// SCP-5 W5-C5 — what the rules sections' component tests share: a rules answer built from the seed twin (the defaults), with any section replaced, and a refusal as the server action returns it.
// Not a test file itself, and not imported by anything but tests.
import seed from "@/lib/socialRulesDefaults.json";
import { RULES_SECTIONS, asRulesAnswer, cloneJson, rulesRefusalText, type RulesAnswer, type RulesDoc, type RulesSection, type RulesWrite } from "@/lib/socialRules";

const { _about: _a, defaultsVersion, ...SEED } = seed as unknown as { _about: string; defaultsVersion: string } & RulesDoc;
/** A fresh copy of the seed's document. */
export const seedDoc = (): RulesDoc => cloneJson(SEED as RulesDoc);

export interface AnswerOver {
  version?: number;
  canEdit?: boolean;
  /** Replace a section's value, as a company that saved it would read. */
  rules?: Partial<RulesDoc>;
  /** The state of a section: who changed it, when, at which version. */
  state?: Partial<Record<RulesSection, { changed: boolean; version: number; editedBy: { id: string; name: string } | null; effectiveFrom: string | null }>>;
}

export function rulesAnswer(over: AnswerOver = {}): RulesAnswer {
  const sections = Object.fromEntries(RULES_SECTIONS.map((s) => [s, over.state?.[s] ?? { changed: over.rules?.[s] !== undefined, version: 0, editedBy: null, effectiveFrom: null }]));
  return asRulesAnswer({ version: over.version ?? 0, defaultsVersion, rules: { ...seedDoc(), ...over.rules }, defaults: seedDoc(), canEdit: over.canEdit ?? true, sections });
}

export const failure = (error: string, status: number, extra: Record<string, unknown> = {}, kind: RulesWrite = "save") => ({
  ok: false as const, refusal: { status, error, ...extra }, message: rulesRefusalText({ status, error, ...extra }, kind),
});

export const CLIENTS = [{ engagementId: "e1", clientName: "Mock Bakery" }, { engagementId: "e2", clientName: "Mock Surf School" }];

// PV5-06 - is a CERTIFIED (PSrE) signing provider set up? Today: never.
//
// PV-D25 parks certified signing (PV5-11) until counsel sets a threshold or a client asks. Until then every
// contract signs in the attested tier, "Mark certified" answers 409, and a send that would land in the certified
// tier is refused rather than producing a contract nobody can sign. PV5-11 replaces this body with the real adapter
// lookup (the configured provider's name); callers only ever ask this one question.
export function certifiedSigningProvider(): string | null {
  return null;
}

export const NO_CERTIFIED_PROVIDER = "no certified signing provider is set up";

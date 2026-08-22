import { LoginForm } from "./LoginForm";
import { sanitizeReturnToParam } from "@/lib/returnTo";
import { Eyebrow } from "@/components/ui";
import "./login.css";

type SP = Promise<Record<string, string | string[] | undefined>>;

// Static holding-group roster for the identity panel. This route is public and
// pre-session (see middleware allowlist) — there is no authenticated
// `platformFetch` here, so it cannot be backend-driven the way an in-app company
// list is.
//
// EVERY VALUE BELOW MUST BE REAL. This is the product's front door: an invented
// company name or founding year here is a false statement about the group, shown
// to everyone before they can even sign in. The names and `kind` labels are
// `lib/demoFixtures.ts`'s COMPANIES verbatim — nothing added, nothing embellished.
// Founding years are deliberately ABSENT rather than guessed; add the column back
// only when someone supplies the real dates. Same rule for the headline: it must
// not assert a company count, so the roster can change without the copy lying.
const ENTITIES: { name: string; kind: string; tone: number }[] = [
  { name: "D & A Syrowatka", kind: "Holding", tone: 8 },
  { name: "Gaia Digital Agency", kind: "Agency", tone: 2 },
  { name: "Viceroy", kind: "Resort", tone: 5 },
];

export default async function LoginPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const returnTo = sanitizeReturnToParam(sp.return);
  // Under AUTH_MODE=oidc the email box is not merely redundant, it is a trap: it posts to the
  // dev-login path that mode disables, so the most prominent control on the page is the one that
  // cannot work. Render SSO alone rather than offering a broken primary action.
  const ssoOnly = (process.env.AUTH_MODE ?? process.env.PLATFORM_AUTH_MODE ?? "dev") === "oidc";
  const ssoError = typeof sp.error === "string" ? sp.error : undefined;
  return (
    <main className="auth-shell">
      <aside className="auth-identity">
        <div className="auth-identity__top">
          <Eyebrow className="auth-identity__eyebrow">D &amp; A Syrowatka</Eyebrow>
          <p className="auth-identity__headline">
            Every company, <em>one</em> set of books.
          </p>
          <p className="auth-identity__lede">
            One ledger, one directory, one set of permissions — across every company the
            holding operates, from the digital agency to the resort.
          </p>
        </div>
        <ul className="auth-identity__entities">
          {ENTITIES.map((entity) => (
            <li key={entity.name} className="auth-entity">
              <span
                className="auth-entity__rail"
                style={{ background: `var(--cat-${entity.tone})` }}
                aria-hidden="true"
              />
              <span className="auth-entity__name">{entity.name}</span>
              <span className="auth-entity__year">{entity.kind}</span>
            </li>
          ))}
        </ul>
      </aside>
      <div className="auth-formcol">
        <LoginForm returnTo={returnTo} ssoOnly={ssoOnly} ssoError={ssoError} />
      </div>
    </main>
  );
}

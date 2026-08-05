import { LoginForm } from "./LoginForm";
import { sanitizeReturnToParam } from "@/lib/returnTo";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function LoginPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const returnTo = sanitizeReturnToParam(sp.return);
  // Under AUTH_MODE=oidc the email box is not merely redundant, it is a trap: it posts to the
  // dev-login path that mode disables, so the most prominent control on the page is the one that
  // cannot work. Render SSO alone rather than offering a broken primary action.
  const ssoOnly = (process.env.AUTH_MODE ?? process.env.PLATFORM_AUTH_MODE ?? "dev") === "oidc";
  const ssoError = typeof sp.error === "string" ? sp.error : undefined;
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--surface-page)" }}>
      <LoginForm returnTo={returnTo} ssoOnly={ssoOnly} ssoError={ssoError} />
    </main>
  );
}

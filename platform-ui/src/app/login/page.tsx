import { LoginForm } from "./LoginForm";

type SP = Promise<Record<string, string | string[] | undefined>>;

function safeReturn(v: string | string[] | undefined): string {
  const raw = Array.isArray(v) ? v[0] : v;
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/";
}

export default async function LoginPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const returnTo = safeReturn(sp.return);
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--surface-page)" }}>
      <LoginForm returnTo={returnTo} />
    </main>
  );
}

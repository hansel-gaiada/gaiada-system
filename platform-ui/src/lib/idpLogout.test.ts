// B0 sweep: sign-out must also end the Keycloak SSO session. These pin the call shape (the realm's logout
// endpoint, public client: client_id + refresh_token, no secret) and the fail-soft contract.
import { describe, it, expect, vi, afterEach } from "vitest";
import { endIdpSession } from "./idpLogout";

afterEach(() => vi.unstubAllEnvs());

describe("endIdpSession", () => {
  it("POSTs client_id + refresh_token to the logout endpoint next to the token endpoint", async () => {
    vi.stubEnv("OIDC_TOKEN_URL", "http://keycloak:8080/idp/realms/gaiada/protocol/openid-connect/token");
    vi.stubEnv("OIDC_CLIENT_ID", "gaiada-ui");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(endIdpSession("r-123", fetchImpl as unknown as typeof fetch)).resolves.toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://keycloak:8080/idp/realms/gaiada/protocol/openid-connect/logout");
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toEqual({ client_id: "gaiada-ui", refresh_token: "r-123" });
  });

  it("OIDC_LOGOUT_URL overrides the derived endpoint", async () => {
    vi.stubEnv("OIDC_LOGOUT_URL", "https://idp.example/logout");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await endIdpSession("r", fetchImpl as unknown as typeof fetch);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://idp.example/logout");
  });

  it("answers false, never throws, on a refusal or an unreachable IdP", async () => {
    await expect(endIdpSession("r", (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch)).resolves.toBe(false);
    await expect(endIdpSession("r", (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch)).resolves.toBe(false);
  });
});

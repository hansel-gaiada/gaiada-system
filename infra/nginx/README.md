# nginx — public edge for the gda-aicenter trial

`erp.gaiada.online.conf` is the LIVE vhost, captured from the box. It is not deployed
automatically (deploy.yml ships compose + mounted config, not host nginx), so treat this as the
reference copy: edit here, then install with

    sudo cp erp.gaiada.online.conf /etc/nginx/sites-available/erp.gaiada.online
    sudo ln -sf /etc/nginx/sites-available/erp.gaiada.online /etc/nginx/sites-enabled/
    sudo nginx -t && sudo systemctl reload nginx

The TLS lines are certbot-managed; re-run `certbot --nginx -d erp.gaiada.online` on a fresh box
rather than copying certificate paths blind.

## The two non-obvious bits

**`location /idp/` — Keycloak is mounted at `/idp`, not `/auth`.** platform-ui already serves
`/auth/login` and `/auth/callback`; mounting the IdP at `/auth` shadows the app's own OIDC routes
and breaks the exact flow the proxy exists to enable. `KC_HOSTNAME` must include that path
(`https://erp.gaiada.online/idp`) or Keycloak drops the prefix from the issuer it advertises, and
token verification then fails on an issuer mismatch. There is deliberately no auth gate here — an
IdP has to be reachable before anyone can authenticate.

**`proxy_redirect` in `location /`.** platform-ui builds absolute redirects from its own bind
address, so the OIDC callback returns `Location: https://<container-id>:3005/`. The user
authenticates successfully and is then sent to a hostname that only resolves inside Docker — it
presents as "login doesn't work" when in fact login already succeeded. The rule rewrites any
absolute Location back onto the public origin. It is scoped to this location so Keycloak's own
redirects under `/idp/` are left alone.

The proper fix is for platform-ui to build that redirect from a configured public origin instead of
`req.url`; until then this rule is load-bearing, not cosmetic.

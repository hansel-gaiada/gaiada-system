# CLAUDE.md — keycloak

Scope: `keycloak/`, the gaiada-keycloak image: the stock Keycloak image plus the two PID-2h additions. The plan is
`docs/plans/2026-10-30-phone-identity.md` (§5.3, §6 risks 11 and 18). Root `../CLAUDE.md` has the program rules.

| Path | What |
|---|---|
| `Dockerfile` | `ARG KEYCLOAK_VERSION` drives both stages: the jar compiles and is tested against the server it ships in |
| `extension/` | the phone sign-in form, a Keycloak `Authenticator` (Java 21, Maven, `mvn -B verify`) |
| `theme/gaiada/login/` | the login theme: keycloak.v2 + "Username or phone number" + a new password always signs out other devices |
| `theme/check-upstream.sh` | proves our `login-update-password.ftl` is upstream's plus the PID-D15 change only |

## What it does, and what it must keep doing

- **The form** (`gaiada-phone-username-password-form`) is Keycloak's `UsernamePasswordForm` with one difference:
  a phone-shaped entry (08…, 62…, +62…, with spaces or dashes) is found by the `phoneNumber` attribute. Usernames and
  emails go to the stock code unchanged.
- **It fails closed.** A number two accounts hold, or a number that is one account's phone and another account's
  username, names nobody. Every refusal is the stock "invalid username or password" after the stock dummy hash.
- **The `ATTEMPTED_USERNAME` note must hold the account's username** once a number matches.
  - Keycloak's brute-force check finds the person again from that note, by username or email
    (`AuthenticationManager#lookupUserForBruteForceLog`).
  - A phone number in the note would let anyone guess passwords by phone with no lockout. The e2e
    "2h brute force counts phone attempts" and "f locked (by phone)" hold this.
- **The theme** replaces the update-password page's "Sign out from other devices" checkbox (unticked by default)
  with a hidden `logout-sessions=on`. That is the one field `UpdatePassword#processAction` reads.
  - So every new password signs the other devices out (PID-D15): forgot password, a temporary password, the account
    console.
  - It is a page change, not a server rule. A hand-made POST without the field keeps the other sessions; only the
    person who just passed the passkey check can send one.
- **Both are inert until the realm uses them.** `infra/scripts/keycloak-passkey-realm.sh` binds the form
  (`LOGIN_FORM`) and selects the theme (`STEPS=theme`), on one client or the realm. The revert of the form alone:
  `STEPS=browser LOGIN_FORM=auth-username-password-form`.

## Building and proving

- `ci.yml` job `keycloak`: the unit tests, `check-upstream.sh`, an image build. No push.
- `.github/workflows/keycloak-image.yml` (push to main touching `keycloak/`): build, push, cosign-sign
  `gaiada-keycloak:<KEYCLOAK_VERSION>-<tree>`. `<tree>` is the first 12 characters of `git rev-parse HEAD:keycloak`.
  - It is **not** in release.yml. A per-release tag would restart Keycloak at every release, and a rollback would ask
    for a tag that was never built.
  - The same sources always give the same tag, and an existing tag is never rebuilt.
- The browser proof runs on sumopod (never here; no local Docker):
  `infra/scripts/keycloak-passkey-realm-test.sh all`, with this directory copied to `~/kc-pid2/keycloak`. It builds
  this image, upgrades a 26.0.8 realm onto it like live, and runs the Playwright suite with Chrome's virtual
  authenticator. It takes `~/e2e.lock`.

## Traps

- **A Keycloak upgrade is a change here.**
  1. Bump `ARG KEYCLOAK_VERSION`.
  2. `check-upstream.sh` fails if the upstream template moved: re-copy it, re-apply the one change, re-run.
  3. Re-run the sumopod proof.
  4. Follow `infra/runbooks/keycloak-upgrade.md`: the first start of a new version migrates the database, and there is
     no way back except the dump.
- **Moving live onto a new tag restarts Keycloak** (compose `image:` line, `infra/compose/docker-compose.vps.yml`).
  It rides a train ALONE, in the owner's window, like PID-1c (plan §6 risk 15).
- The extension stays small on purpose (plan §6 risk 11). Anything more belongs in the platform, not in the identity
  provider.

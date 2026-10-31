# PID-2h (docs/plans/2026-10-30-phone-identity.md §5.3): the stock Keycloak image + the phone sign-in form + the gaiada
# login theme. Nothing else changes: same Keycloak version as live (PID-1c), same start command, same database.
# Both additions are inert until the realm uses them (keycloak-passkey-realm.sh binds the form in its own flow and
# selects the theme), so the image can go live before any realm change.
#
# KEYCLOAK_VERSION drives BOTH stages: the jar compiles and is tested against the exact server it ships in. Bumping it is
# a Keycloak upgrade (infra/runbooks/keycloak-upgrade.md): rebuild, re-run the PID-2 proof, re-diff the theme template.
ARG KEYCLOAK_VERSION=26.8.1

FROM maven:3.9.16-eclipse-temurin-21-noble AS build
ARG KEYCLOAK_VERSION
WORKDIR /src
COPY extension/pom.xml ./
RUN mvn -B -q -Dkeycloak.version=${KEYCLOAK_VERSION} dependency:go-offline
COPY extension/src ./src
# `verify` runs the unit tests: a failing test fails the image build
RUN mvn -B -Dkeycloak.version=${KEYCLOAK_VERSION} verify

FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}
COPY --from=build /src/target/gaiada-keycloak-phone-form.jar /opt/keycloak/providers/
COPY theme/gaiada /opt/keycloak/themes/gaiada

# WebDesk api image. BUILD CONTEXT IS ./webdesk, NOT ./webdesk/api (M6-P4r-a):
#
#   docker build -f webdesk/api/Dockerfile webdesk
#
# release.yml builds it exactly so (context ./webdesk, file ./webdesk/api/Dockerfile). The wider
# context is there for two things that live next to api/ and are not part of it:
#   * delivery/vocabulary/ - the contract generator imports it with relative `.ts` specifiers, so
#     the bundle step inlines it (api/scripts/build-codegen-bundle.mjs);
#   * blocks/ - the @gaiada/webdesk-blocks library, packed here into a tarball that ships INSIDE the
#     image (the image's cosign signature and SLSA attestation therefore cover it).
# webdesk/.dockerignore admits only api/, blocks/ and delivery/, and never a node_modules/dist/*.tgz.
#
# Stages:
#   build          tsc (the Nest service -> dist/) + esbuild (the contract generator -> dist/codegen/generator.mjs)
#   blocks         npm pack of webdesk/blocks -> /out/gaiada-webdesk-blocks-<version>.tgz + SHA256SUMS
#   blocks-export  scratch stage holding only /out, so release.yml can extract the tarball and
#                  compute the sha256 BEFORE the real build (`--target blocks-export --output type=local`)
#   (final)        production deps + dist/ + artifacts/blocks/ - nothing writes into the image at runtime
#                  (the container runs read-only with a 64 MiB /tmp).
FROM node:22-alpine AS build
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
RUN npm ci
COPY api/tsconfig.json ./
COPY api/scripts ./scripts
COPY api/src ./src
# Sits at /app/delivery/vocabulary: the generator's `../../../../delivery/vocabulary/...` specifiers
# (from /app/api/src/codegen/generator/) resolve to it, exactly as in the repo.
COPY delivery/vocabulary /app/delivery/vocabulary
RUN npm run build

FROM node:22-alpine AS blocks
WORKDIR /app/blocks
COPY blocks/package.json blocks/package-lock.json ./
# Lockfile consistency check + the one runtime dependency; astro (peer) and the dev tooling are not
# needed to pack, so they are not installed. --ignore-scripts: nothing here may run lifecycle code.
RUN npm ci --omit=dev --omit=peer --ignore-scripts
COPY blocks/README.md blocks/tsconfig.json ./
COPY blocks/scripts ./scripts
COPY blocks/src ./src
# `prepack` runs vendor:check against ../delivery/vocabulary (= /app/delivery/vocabulary here).
COPY delivery/vocabulary /app/delivery/vocabulary
# Normalise file modes: a Windows build context marks every file executable, a Linux checkout does
# not, and the mode is recorded in the tarball. Dirs stay traversable, files lose the x bit.
RUN chmod -R a-x,a+X /app/blocks/src /app/blocks/scripts /app/blocks/README.md /app/blocks/package.json
# npm pack is byte-reproducible (mtime pinned, uid/gid stripped, sorted entries, fixed gzip level).
RUN set -eu; mkdir /out; npm pack --pack-destination /out --silent; \
    cd /out; sha256sum gaiada-webdesk-blocks-*.tgz > SHA256SUMS; cat SHA256SUMS
# Written AFTER the pack so that passing (or changing) these args never invalidates the pack layer.
ARG BLOCKS_SHA256=""
ARG BLOCKS_VERSION=""
RUN set -eu; \
    actual="$(cut -d' ' -f1 /out/SHA256SUMS)"; \
    version="$(node -p "require('./package.json').version")"; \
    if [ -n "$BLOCKS_SHA256" ] && [ "$BLOCKS_SHA256" != "$actual" ]; then \
      echo "BLOCKS_SHA256 mismatch: expected $BLOCKS_SHA256, packed tarball is $actual" >&2; exit 1; fi; \
    if [ -n "$BLOCKS_VERSION" ] && [ "$BLOCKS_VERSION" != "$version" ]; then \
      echo "BLOCKS_VERSION mismatch: expected $BLOCKS_VERSION, package.json is $version" >&2; exit 1; fi

FROM scratch AS blocks-export
COPY --from=blocks /out/ /

FROM node:22-alpine
ARG BLOCKS_SHA256=""
ARG BLOCKS_VERSION=""
LABEL org.gaiada.webdesk-blocks.sha256="$BLOCKS_SHA256" \
      org.gaiada.webdesk-blocks.version="$BLOCKS_VERSION"
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/api/dist ./dist
COPY --from=blocks /out/ ./artifacts/blocks/
EXPOSE 3000
CMD ["node", "dist/main.js"]

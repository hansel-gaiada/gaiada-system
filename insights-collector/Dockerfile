# insights-collector/Dockerfile -- the enrichment collector (M5-V2). Built and cosign-signed by CI (M5-V2-b);
# NEVER build it on the laptop or on gda-aicenter. Context = this folder.
#
# Runtime: distroless static, non-root (65532), no shell, no package manager. The container needs no writable
# path (run it `read_only: true`), mounts ./geo read-only at /geo, and has no egress by design (it sits on the
# `internal: true` network of the umami compose project). V2-b pins the distroless base by digest.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /collector ./cmd/collector

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
ARG VERSION=dev
ENV BUILD_VERSION=${VERSION}
COPY --from=build /collector /collector
USER 65532:65532
# 8080 aggregate channel (trusts X-Real-IP from the nginx edge); 8081 /healthz + /ops/v1/* (never reads X-Real-IP).
EXPOSE 8080 8081
# Distroless has no curl or wget: the binary checks itself.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 CMD ["/collector", "-healthcheck"]
ENTRYPOINT ["/collector"]

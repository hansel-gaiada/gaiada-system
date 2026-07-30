# search-crawl-go/Dockerfile — job-mode crawl worker (SM-07). One container run = one crawl of
# one registered+verified search_properties row, then exit. Not a long-running server (no exposed
# port, no restart:always in compose — see infra/compose/docker-compose.vps.yml's `search-crawl`
# service, profile "jobs", invoked with `docker compose run`).
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /crawl ./cmd/crawl

FROM alpine:3.20
RUN adduser -D -u 10001 crawler && mkdir -p /app/data && chown -R crawler:crawler /app
COPY --from=build /crawl /crawl
VOLUME /app/data
WORKDIR /app
USER crawler
ENTRYPOINT ["/crawl"]

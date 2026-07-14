# sync-engine-go/Dockerfile — the cross-site reconciliation engine (WS1 T2).
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /sync ./cmd/sync
RUN CGO_ENABLED=0 go build -o /synccert ./cmd/synccert

FROM alpine:3.20
COPY --from=build /sync /sync
COPY --from=build /synccert /synccert
VOLUME /app/data
WORKDIR /app
ENTRYPOINT ["/sync"]

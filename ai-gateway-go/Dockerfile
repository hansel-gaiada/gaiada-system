# ai-gateway-go/Dockerfile
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /gateway ./cmd/gateway

FROM alpine:3.20
COPY --from=build /gateway /gateway
VOLUME /app/data
WORKDIR /app
ENTRYPOINT ["/gateway"]

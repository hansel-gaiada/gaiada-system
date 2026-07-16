# WS9 synthetic prober — static Go binary on a distroless base.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /prober .

FROM gcr.io/distroless/static-debian12
COPY --from=build /prober /prober
ENTRYPOINT ["/prober"]

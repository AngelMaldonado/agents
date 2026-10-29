# The WhatsApp bridge (whatsmeow). Built on reko-3: just deploy whatsapp (dev: just dev up builds it).
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /whatsapp .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 1001 bridge
COPY --from=build /whatsapp /usr/local/bin/whatsapp
USER bridge
EXPOSE 8790
ENTRYPOINT ["/usr/local/bin/whatsapp"]

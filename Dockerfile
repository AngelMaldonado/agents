# Agents' app image: the backend serving the built web, plus the WhatsApp bridge (whatsapp/), which runs as
# its own service from this same image (entrypoint /usr/local/bin/agents-whatsapp): one image to build,
# sign and verify per release. The sandbox image is separate (sandbox/).
FROM golang:1.26-alpine AS whatsapp
WORKDIR /src
COPY whatsapp/go.mod whatsapp/go.sum ./
RUN go mod download
COPY whatsapp/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /agents-whatsapp .

FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY server/package.json server/
COPY web/package.json web/
RUN LEFTHOOK=0 bun install --frozen-lockfile
COPY server server
COPY sandbox/harness.ts sandbox/
COPY web web
RUN cd web && bun --bun vite build

FROM oven/bun:1.4.2
WORKDIR /app
COPY package.json bun.lock ./
COPY server/package.json server/
COPY web/package.json web/
RUN LEFTHOOK=0 bun install --production --frozen-lockfile
COPY server server
COPY sandbox/harness.ts sandbox/
COPY --from=build /app/web/dist web/dist
COPY --from=whatsapp /agents-whatsapp /usr/local/bin/agents-whatsapp
# production: Bun serves plain errors, not its development pages with stack traces.
ENV NODE_ENV=production AGENTS_WEB_DIST=/app/web/dist AGENTS_DATA=/data PORT=8787
WORKDIR /app/server
CMD ["bun", "src/index.ts"]

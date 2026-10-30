# Agents' app image: the backend serving the built web. The sandbox image is separate (sandbox/).
FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY server/package.json server/
COPY web/package.json web/
RUN LEFTHOOK=0 bun install --frozen-lockfile
COPY server server
COPY sandbox/harness.ts sandbox/features.ts sandbox/
COPY web web
RUN cd web && bun --bun vite build

FROM oven/bun:1.4.2
WORKDIR /app
COPY package.json bun.lock ./
COPY server/package.json server/
COPY web/package.json web/
RUN LEFTHOOK=0 bun install --production --frozen-lockfile
COPY server server
COPY sandbox/harness.ts sandbox/features.ts sandbox/
COPY --from=build /app/web/dist web/dist
# production: Bun serves plain errors, not its development pages with stack traces.
ENV NODE_ENV=production AGENTS_WEB_DIST=/app/web/dist AGENTS_DATA=/data PORT=8787
WORKDIR /app/server
CMD ["bun", "src/index.ts"]

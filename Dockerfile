# Buyer's app image: the backend serving the built web. The sandbox image is separate (sandbox/).
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY server/package.json server/
COPY web/package.json web/
RUN bun install --frozen-lockfile
COPY server server
COPY web web
RUN cd web && bun --bun vite build

FROM oven/bun:1.4
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server server
COPY --from=build /app/web/dist web/dist
ENV BUYER_WEB_DIST=/app/web/dist BUYER_DATA=/data PORT=8787
WORKDIR /app/server
CMD ["bun", "src/index.ts"]

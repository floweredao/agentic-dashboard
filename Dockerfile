# A small image of the dashboard: the built web app plus the Bun server and production dependencies.
#   docker build -t agentic-dashboard .
#   docker run -p 4310:8080 -v agentic-data:/app/data -e APP_ORIGIN=http://127.0.0.1:4310 agentic-dashboard
# Records and keys live in /app/data; mount a volume there to keep them. The public demo runs scripts/demo-start.sh instead.
# Both installs run on the build machine's own platform: the output is plain JavaScript, the same for every target,
# and an emulated `bun install` (for example amd64 under Rosetta, which has no AVX) crashes.
# BuildKit sets BUILDPLATFORM; the legacy builder leaves it empty, so it falls back to linux/amd64.
ARG BUILDPLATFORM
FROM --platform=${BUILDPLATFORM:-linux/amd64} oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM --platform=${BUILDPLATFORM:-linux/amd64} oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-slim
# Pass the package.json version when publishing: docker build --build-arg VERSION=<version> .
ARG VERSION=dev
LABEL org.opencontainers.image.title="agentic-dashboard" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.source="https://github.com/floweredao/agentic-dashboard" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY package.json bun.lock ./
COPY --from=deps /app/node_modules node_modules
RUN mkdir -p data && chown bun:bun data
COPY server server
COPY shared shared
COPY scripts scripts
COPY --from=build /app/dist dist
USER bun
EXPOSE 8080
CMD ["bun", "server/index.ts"]

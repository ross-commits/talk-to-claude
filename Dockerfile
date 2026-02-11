FROM oven/bun:1-alpine

WORKDIR /app

# Copy package files first (layer caching for deps)
COPY server/package.json server/bun.lock* ./

# Install dependencies
# --frozen-lockfile if lockfile exists, otherwise fresh install
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy server source
COPY server/src ./src

# MCP server communicates via stdio; HTTP webhook server on this port
EXPOSE 3333

# Health check against the built-in /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3333/health || exit 1

CMD ["bun", "run", "src/index.ts"]

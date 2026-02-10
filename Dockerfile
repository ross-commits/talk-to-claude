FROM oven/bun:1-alpine

WORKDIR /app

# Copy package files and install deps
COPY server/package.json server/bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Copy server source
COPY server/src ./src

# MCP server communicates via stdio, HTTP server on this port
EXPOSE 3333

CMD ["bun", "run", "src/index.ts"]

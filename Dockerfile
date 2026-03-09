# ---- Build stage ----
FROM node:22-slim AS builder

WORKDIR /app

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/

RUN npm run build

# Remove devDependencies from node_modules after build
RUN npm prune --omit=dev

# ---- Production stage ----
FROM node:22-slim

WORKDIR /app

# Install pm2 globally (separate layer, rarely changes)
RUN npm install -g pm2 && npm cache clean --force

# Create non-root user (required by Claude provider)
RUN groupadd --gid 1001 aiclaw && \
    useradd --uid 1001 --gid aiclaw --create-home aiclaw

# Copy production node_modules (with pre-built native modules from builder)
COPY --from=builder /app/node_modules/ node_modules/

# Copy build output + config
COPY --from=builder /app/dist/ dist/
COPY package.json ecosystem.config.cjs ./

# Data directory (mount a volume here for persistence)
RUN mkdir -p data skills_extra && chown -R aiclaw:aiclaw data skills_extra

# Switch to non-root user
USER aiclaw

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# PM2 in foreground mode (no-daemon) so Docker can track the process
CMD ["pm2-runtime", "ecosystem.config.cjs"]

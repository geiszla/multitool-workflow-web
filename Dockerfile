# Multi-stage Dockerfile for Multitool Workflow Web
# Optimized for Google Cloud Run deployment with pnpm

# ==============================================================================
# Stage 1: Base image with pnpm installed
# ==============================================================================
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# ==============================================================================
# Stage 2: Install all dependencies (including dev) for building
# ==============================================================================
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ==============================================================================
# Stage 3: Build the application
# ==============================================================================
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Set production environment for build optimizations
ENV NODE_ENV=production

# Build the application
RUN pnpm build

# ==============================================================================
# Stage 4: Production dependencies only
# ==============================================================================
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ==============================================================================
# Stage 5: Final production image
# ==============================================================================
FROM node:24-alpine AS runner

# Don't run as root
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 multitool-workflow-web

WORKDIR /app

# Copy production dependencies
COPY --from=prod-deps /app/node_modules ./node_modules

# Copy built application (including compiled server.js)
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json

# Set ownership
RUN chown -R multitool-workflow-web:nodejs /app

# Switch to non-root user
USER multitool-workflow-web

# Set production environment
ENV NODE_ENV=production
ENV PORT=8080

# Expose port (Cloud Run uses 8080 by default)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/healthz || exit 1

# Start the application with custom server (supports WebSocket terminal proxy)
CMD ["node", "build/server.js"]

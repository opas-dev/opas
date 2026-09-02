# ABOUTME: Builds a portable standalone OPAS image for Postgres-backed deployments.
# ABOUTME: Runs migrations and deterministic seed data before starting the non-root server.
FROM node:22.23.2-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS dependencies
RUN apk add --no-cache g++ make python3
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build
RUN pnpm build:prepare:postgres

FROM dependencies AS maintenance-builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm maintenance:prepare .
RUN pnpm build
RUN pnpm maintenance:scan .next/standalone && pnpm maintenance:scan .next/static

FROM node:22.23.2-alpine AS runner
WORKDIR /app
ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/drizzle/postgres ./drizzle/postgres
COPY --from=builder --chown=nextjs:nodejs /app/scripts/run-embedding-recovery.mjs ./scripts/run-embedding-recovery.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/run-analytics-cleanup.mjs ./scripts/run-analytics-cleanup.mjs

USER nextjs
EXPOSE 3000

CMD ["sh", "-c", "node prepare-postgres.cjs && node server.js"]

FROM node:22.23.2-alpine AS maintenance
WORKDIR /app
ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=maintenance-builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=maintenance-builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]

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

USER nextjs
EXPOSE 3000

CMD ["sh", "-c", "node prepare-postgres.cjs && node server.js"]

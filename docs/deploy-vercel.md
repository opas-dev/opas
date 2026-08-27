# Deploy to Vercel with Neon

Use one Neon branch for migration and runtime. Keep the branch in `eu-central-1` so the `fra1` Vercel function region in `vercel.json` remains close to the database.

## Environment

Set these Production environment variables in the Vercel project:

```dotenv
OPAS_DATABASE_DRIVER=neon
NEON_DATABASE_URL=<Neon serverless connection string>
OPAS_SITE_URL=https://<stable production domain>
ADMIN_EMAIL=<admin email>
ADMIN_PASSWORD=<at least 8 characters>
ADMIN_SESSION_SECRET=<at least 32 random bytes>
```

`OPAS_SITE_URL` must be the stable public HTTP(S) origin, with no path, query, or fragment. Set it before the build. Do not use a generated deployment or preview URL: OPAS uses this value for canonical metadata, sitemap entries, JSON-LD, Markdown links, and llms documents.

Use a direct Neon connection string while running migrations. The Vercel runtime may use the pooled serverless connection string for the same branch.

## Setup

Install dependencies, link the local checkout to the Vercel project, and add each variable above to Production:

```sh
pnpm install --frozen-lockfile
vercel link
vercel env add OPAS_DATABASE_DRIVER production
vercel env add NEON_DATABASE_URL production
vercel env add OPAS_SITE_URL production
vercel env add ADMIN_EMAIL production
vercel env add ADMIN_PASSWORD production
vercel env add ADMIN_SESSION_SECRET production
```

Vercel prompts for each value without placing it in shell history.

## Build, migrate, and seed

Build the staged Production artifact before changing Neon:

```sh
vercel build --prod --yes
```

Put the direct Neon connection string in the gitignored root `.env` as `NEON_DATABASE_URL`, then run the transactional migration and missing-only seed:

```sh
pnpm neon:prepare
```

The command applies `drizzle/postgres` migrations over a direct PostgreSQL connection and inserts missing demo records. It does not replace records already edited by an administrator. Run it once before the first deployment and again after pulling any commit that adds a migration.

Every migration must be expand-first and remain compatible with both the current deployment and the staged artifact. Building first removes compile failures from the post-migration window, but an upload can still fail while the current deployment continues using the migrated schema.

## Deploy and smoke-test

Create a staged Production deployment without moving the public domain:

```sh
vercel deploy --prebuilt --prod --skip-domain
```

Set `DEPLOYMENT_URL` to the HTTPS URL printed by Vercel and check the database-backed public surfaces:

```sh
DEPLOYMENT_URL=https://<deployment-url>
pnpm smoke "$DEPLOYMENT_URL"
```

The smoke suite discovers a published article and verifies its database-backed page, search result, Markdown, sitemap, JSON-LD, and llms entries. It follows the stable canonical origin advertised by the staged deployment without requiring `DEPLOYMENT_URL` to match it.

Promote only after those checks pass:

```sh
vercel promote "$DEPLOYMENT_URL"
```

Repeat the checks against `OPAS_SITE_URL` after promotion.

```sh
OPAS_SITE_URL=https://<stable-production-domain>
pnpm smoke "$OPAS_SITE_URL"
```

## Roll back

List the Production deployments, set `PREVIOUS_DEPLOYMENT_URL` to the last known-good URL, roll traffic back to it, and inspect the result:

```sh
vercel list --environment production
PREVIOUS_DEPLOYMENT_URL=https://<previous-production-deployment-url>
vercel rollback "$PREVIOUS_DEPLOYMENT_URL"
vercel rollback status
```

A Vercel rollback does not undo database migrations. Before a future destructive migration, create a Neon branch or backup. Repair schema state with a reviewed forward migration; do not edit or delete entries in `drizzle.__drizzle_migrations` manually.

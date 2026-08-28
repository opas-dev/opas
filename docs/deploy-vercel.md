# Deploy to Vercel with Neon

Vercel and Neon are OPAS's live compatibility target. Cloudflare Workers and D1 remain the primary production deployment. In this document, Vercel `Production` always means the Vercel environment name; it does not mean OPAS production traffic moves away from Cloudflare.

Use one Neon branch for migration and runtime. Keep the branch in `eu-central-1` so the `fra1` Vercel function region in `vercel.json` remains close to the database. The maintained project is `opas-mvp`, and its stable compatibility origin is [opas-mvp-timo-bejans-projects.vercel.app](https://opas-mvp-timo-bejans-projects.vercel.app). No `opas.dev` domain is attached to it. A fork must replace the maintained project name and origin in the commands below.

## Environment

Set these Production environment variables in the Vercel project:

```dotenv
OPAS_DATABASE_DRIVER=neon
NEON_DATABASE_URL=<Neon serverless connection string>
OPAS_SITE_URL=https://opas-mvp-timo-bejans-projects.vercel.app
ADMIN_EMAIL=<admin email>
ADMIN_PASSWORD=<at least 8 characters>
ADMIN_SESSION_SECRET=<at least 32 random bytes>
```

`OPAS_SITE_URL` must be the stable Vercel compatibility origin above, with no path, query, or fragment. Set it before the build. Do not use a generated deployment URL or the Cloudflare production URL: OPAS uses this value for canonical metadata, sitemap entries, JSON-LD, Markdown links, and llms documents.

Use a direct Neon connection string while running migrations. The Vercel runtime may use the pooled serverless connection string for the same branch.

## Setup

Install dependencies, link the local checkout to the Vercel project, and add each variable above to Production:

```sh
pnpm install --frozen-lockfile
vercel link
vercel project update opas-mvp --framework nextjs --node-version 22.x --yes
vercel env add OPAS_DATABASE_DRIVER production
vercel env add NEON_DATABASE_URL production
vercel env add OPAS_SITE_URL production
vercel env add ADMIN_EMAIL production
vercel env add ADMIN_PASSWORD production
vercel env add ADMIN_SESSION_SECRET production
vercel pull --environment=production --yes
```

Vercel prompts for each value without placing it in shell history. Pull again after changing a Production variable so the local build cannot reuse stale project settings. Vercel Secret values are intentionally written as `[SENSITIVE]` when pulled; `.vercel/.env.production.local` is therefore not a source of real local build secrets.

If the compatibility URL redirects to Vercel Authentication because the account default was inherited, disable SSO protection for this project only and verify the public health endpoint again:

```sh
vercel project protection disable opas-mvp --sso
curl --fail --silent --show-error https://opas-mvp-timo-bejans-projects.vercel.app/api/health
```

## Build, migrate, and seed

Put the direct Neon connection string and actual administrator values in the gitignored root `.env`. Build the staged Vercel Production-environment artifact before changing Neon. The build command loads those real local values without copying them into shell history and pins the Neon adapter plus stable compatibility origin:

```sh
pnpm vercel:build https://opas-mvp-timo-bejans-projects.vercel.app
```

Then run the transactional migration and missing-only seed against the direct connection:

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
DEPLOYMENT_URL=https://your-deployment.vercel.app
pnpm smoke "$DEPLOYMENT_URL"
```

The smoke suite discovers a published article and verifies its database-backed page, search result, Markdown, sitemap, JSON-LD, and llms entries. It follows the stable canonical origin advertised by the staged deployment without requiring `DEPLOYMENT_URL` to match it.

For a published FAQ article, require the complete Article and FAQPage structured-data contracts too:

```sh
OPAS_SMOKE_FAQ_PATH=/getting-started/your-faq-slug pnpm smoke "$DEPLOYMENT_URL"
```

Before promotion, verify the browser-only paths that curl cannot cover:

1. Open the staged home page, follow its client-side links to a category and the database-backed article, and confirm the MDX remains visible after hydration.
2. Confirm the browser console has no `Connection closed` exception and the network panel has no failed RSC or article requests.
3. Sign in on the staged `/admin` route, record the active theme, apply a different preset, and reload a staged public page. Confirm its computed theme values changed without a rebuild, then restore the original preset and verify the public page again.

Promote only after those checks pass. Promotion moves the Vercel compatibility aliases only; it does not change the Cloudflare Worker, OPAS DNS, or production traffic:

```sh
vercel promote "$DEPLOYMENT_URL" --yes
```

Repeat the checks against `OPAS_SITE_URL` after promotion.

```sh
pnpm smoke https://opas-mvp-timo-bejans-projects.vercel.app
```

Repeat the public home-to-article client navigation against the promoted origin and confirm the browser console and network panel remain clean.

## Roll back

List the Production deployments, set `PREVIOUS_DEPLOYMENT_URL` to the last known-good URL, roll traffic back to it, and inspect the result:

```sh
vercel list --environment production
PREVIOUS_DEPLOYMENT_URL=https://previous-deployment.vercel.app
vercel rollback "$PREVIOUS_DEPLOYMENT_URL"
vercel rollback status
```

A Vercel rollback moves only the compatibility alias and does not undo database migrations. Before a future destructive migration, create a Neon branch or backup. Repair schema state with a reviewed forward migration; do not edit or delete entries in `drizzle.__drizzle_migrations` manually.

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
CRON_SECRET=<separate random value of at least 32 bytes>
OPAS_GENERATION_ENDPOINT=<absolute OpenAI-compatible /chat/completions endpoint>
OPAS_GENERATION_MODEL=<provider model name>
OPAS_GENERATION_RETENTION_DISCLOSURE=<browser-visible provider and product retention statement>
OPAS_GENERATION_API_KEY=<optional provider credential>
OPAS_EMBEDDING_ENDPOINT=<absolute OpenAI-compatible /embeddings endpoint>
OPAS_EMBEDDING_MODEL=<provider model name>
OPAS_EMBEDDING_DIMENSION=<positive output dimension, at most 4096>
OPAS_EMBEDDING_DIMENSIONS_PARAMETER=false
OPAS_EMBEDDING_API_KEY=<optional provider credential>
OPAS_ANSWER_TOPIC_GUARDRAILS=<optional compact JSON; omit until a policy is approved>
```

`OPAS_SITE_URL` must be the stable Vercel compatibility origin above, with no path, query, or fragment. Set it before the build. Do not use a generated deployment URL or the Cloudflare production URL: OPAS uses this value for canonical metadata, sitemap entries, JSON-LD, Markdown links, and llms documents.

Use a direct Neon connection string while running migrations. The Vercel runtime may use the pooled serverless connection string for the same branch.

Answer generation requires the endpoint, model, and retention disclosure. The endpoint must be an absolute HTTP or HTTPS URL without embedded credentials, query, or fragment, and it must stream OpenAI-compatible server-sent events. Model and disclosure values must be non-empty and control-free, with respective UTF-8 limits of 256 and 1,024 bytes. The API key is optional for a trusted credential-free endpoint; a non-empty value may contain at most 16,384 UTF-8 bytes and no line break, and is sent only as a bearer credential. The retention disclosure is returned to and rendered by the browser, so it must be an accurate operator-authored statement rather than a secret or placeholder. OPAS sends provider requests with `cache: no-store`, discards non-success response bodies unread, and does not place prompts, evidence, credentials, responses, or provider messages in application logs. Provider-side storage and training remain governed by the selected provider and must agree with the disclosure. OPAS persistence is limited to configured redacted conversation records; the v0.2 target is a 30-day default once that record path ships.

Missing or malformed generation settings make `/api/answers` return a safe unavailable response; article rendering and ordinary search remain available. `vercel.json` deliberately contains no environment values because Vercel project settings own this deployment-specific provider contract.

`OPAS_ANSWER_TOPIC_GUARDRAILS` is optional. Leave it absent until the deployment has an approved scope. When used, it must be one compact JSON object with only `allow` and/or `deny` string arrays, at least one phrase, no overlap or duplicates, at most 4,096 UTF-8 bytes and 32 phrases combined, and at most 80 Unicode code points or eight words per phrase. Malformed non-empty configuration fails before provider or repository creation. An exact empty value in `.env` and Docker Compose is treated as absent; other blank or malformed values fail closed. Direct unsafe or denied requests abstain before retrieval, retrieved prompt injection abstains before generation, and denied history is not forwarded into a later clean turn. No model classifier is required for these controls.

The embedding endpoint, model, and dimension must all be present before recovery runs. The endpoint follows the same absolute-URL restrictions as generation; the trimmed model is limited to 200 characters, dimension is a base-10 integer from 1 through 4,096, and `OPAS_EMBEDDING_DIMENSIONS_PARAMETER` accepts only `true` or `false`. The API key is optional for a trusted credential-free endpoint; a non-empty value is limited to 4,096 characters with no line break, is sent as a bearer credential, and is never persisted. Missing provider settings leave publishing, keyword search, and the rest of the application available while semantic indexing remains disabled; malformed non-empty settings fail before the repository is opened.

Vercel sends `CRON_SECRET` to the private recovery route as a bearer credential. The route accepts 32 through 4,096 UTF-8 bytes with no line break, compares fixed-size SHA-256 digests, disables caching, and returns only status and counts. The maintained Vercel account is on the Hobby cron tier, so `vercel.json` uses its allowed daily recovery schedule; immediate post-commit recovery is the primary path. Pro and Enterprise forks may change the schedule to `* * * * *` for minute recovery. Vercel documents both [automatic bearer authentication](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs) and [the plan-specific minimum intervals](https://vercel.com/docs/cron-jobs/usage-and-pricing).

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
vercel env add CRON_SECRET production
vercel env add OPAS_GENERATION_ENDPOINT production
vercel env add OPAS_GENERATION_MODEL production
vercel env add OPAS_GENERATION_RETENTION_DISCLOSURE production
vercel env add OPAS_EMBEDDING_ENDPOINT production
vercel env add OPAS_EMBEDDING_MODEL production
vercel env add OPAS_EMBEDDING_DIMENSION production
vercel env add OPAS_EMBEDDING_DIMENSIONS_PARAMETER production
vercel pull --environment=production --yes
```

Add `OPAS_GENERATION_API_KEY` and `OPAS_EMBEDDING_API_KEY` only when their providers require bearer authentication. Add `OPAS_ANSWER_TOPIC_GUARDRAILS` only after selecting an explicit deployment policy; do not create a blank Vercel value for an omitted optional setting.

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

Exercise the answer stream with a question backed by a current published article:

```sh
curl --fail-with-body --no-buffer --silent --show-error \
  --dump-header /tmp/opas-vercel-answer.headers \
  --header 'content-type: application/json' \
  --data '{"question":"How is the Runtime MDX article loaded?"}' \
  "$DEPLOYMENT_URL/api/answers" | tee /tmp/opas-vercel-answer.ndjson
rg -i '^cache-control: no-store' /tmp/opas-vercel-answer.headers
```

The first NDJSON record must expose the configured provider, model, and exact retention disclosure. A supported answer then needs at least one validated content record followed by a server-owned citation and one finish record. Confirm the citation resolves to the current published revision. Send a direct prompt-injection attempt and verify it yields one `unsafe-request` abstention without a corresponding provider request. Provider dashboards or audit records must match the configured retention disclosure; OPAS cannot enforce an upstream provider's storage policy. In a disposable deployment with generation settings absent, the answer endpoint must be unavailable while `pnpm smoke "$DEPLOYMENT_URL"` still passes.

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

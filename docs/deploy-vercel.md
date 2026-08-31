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
OPAS_ANSWER_MAXIMUM_CONCURRENCY=<integer from 1 through 100>
OPAS_ANSWER_DAILY_BUDGET_MICRODOLLARS=<positive integer, at most 2000000000>
OPAS_ANSWER_MAXIMUM_INPUT_TOKENS=<provider's maximum billable input, at most 1000000>
OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS=<non-negative integer provider price>
OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS=<non-negative integer provider price>
OPAS_ANSWER_LEASE_MILLISECONDS=<integer from 35000 through 300000>
OPAS_ANSWER_ANALYTICS_RETENTION_DAYS=30
OPAS_ANALYTICS_REDACTION_PATTERNS=[]
OPAS_HANDOFF_DAILY_LIMIT=100
OPAS_HANDOFF_RETENTION_DAYS=30
OPAS_HANDOFF_PROVIDER=<cloudflare-rest-email or webhook>
OPAS_HANDOFF_FROM_EMAIL=<verified sender; required for cloudflare-rest-email>
OPAS_HANDOFF_TO_EMAIL=<fixed verified destination; required for cloudflare-rest-email>
OPAS_HANDOFF_CLOUDFLARE_ACCOUNT_ID=<Cloudflare account ID; required for cloudflare-rest-email>
OPAS_HANDOFF_CLOUDFLARE_API_TOKEN=<Email Sending token; required for cloudflare-rest-email>
OPAS_HANDOFF_WEBHOOK_URL=<fixed public HTTPS URL; required for webhook>
OPAS_HANDOFF_WEBHOOK_TOKEN=<optional webhook bearer token>
OPAS_EMBEDDING_ENDPOINT=<absolute OpenAI-compatible /embeddings endpoint>
OPAS_EMBEDDING_MODEL=<provider model name>
OPAS_EMBEDDING_DIMENSION=<positive output dimension, at most 4096>
OPAS_EMBEDDING_DIMENSIONS_PARAMETER=false
OPAS_EMBEDDING_API_KEY=<optional provider credential>
OPAS_ANSWER_TOPIC_GUARDRAILS=<optional compact JSON; omit until a policy is approved>
```

`OPAS_SITE_URL` must be the stable Vercel compatibility origin above, with no path, query, or fragment. Set it before the build. Do not use a generated deployment URL or the Cloudflare production URL: OPAS uses this value for canonical metadata, sitemap entries, JSON-LD, Markdown links, and llms documents.

Keep `NEON_DATABASE_URL` as the pooled serverless runtime connection. The guarded build and `pnpm neon:prepare` derive the same branch's direct hostname in memory by removing Neon’s exact `-pooler.` label, require official `ep-*.<region>.<provider>.neon.tech` authorities, reject connection-target query overrides, validate the endpoint, port, credentials, and database as one identity, and never print or persist the direct value. The URL may carry only Neon’s `sslmode` and `channel_binding` parameters. An explicit matching `NEON_DIRECT_DATABASE_URL` in local `.env` is accepted but optional; never add it to Vercel.

Answer generation requires the endpoint, model, and retention disclosure. The endpoint must be an absolute HTTP or HTTPS URL without embedded credentials, query, or fragment, and it must stream OpenAI-compatible server-sent events. Model and disclosure values must be non-empty and control-free, with respective UTF-8 limits of 256 and 1,024 bytes. The API key is optional for a trusted credential-free endpoint; a non-empty value may contain at most 16,384 UTF-8 bytes and no line break, and is sent only as a bearer credential. The retention disclosure is returned to and rendered by the browser, so it must be an accurate operator-authored statement rather than a secret or placeholder. OPAS sends provider requests with `cache: no-store`, discards non-success response bodies unread, and does not place prompts, evidence, credentials, responses, or provider messages in application logs. Provider-side storage and training remain governed by the selected provider and must agree with the disclosure. Redacted answer conversations default to 30 days, may be configured shorter or disabled, and never store requester IP, raw user agent, or cookies. A user-submitted support handoff stores its explicit contact and bounded context separately for `OPAS_HANDOFF_RETENTION_DAYS`, which defaults to 30 days and accepts 1 through 365.

Missing or malformed generation settings make `/api/answers` return a safe unavailable response; article rendering and ordinary search remain available. `vercel.json` deliberately contains no environment values because Vercel project settings own this deployment-specific provider contract.

The six answer-admission values are required whenever generation is active. They are canonical base-10 integers without signs, decimal points, leading zeroes, or whitespace. Prices are integer microdollars per one million provider-reported tokens, and at least one price must be non-zero. Set the maximum input to the provider's complete billable prompt ceiling, including provider framing, and copy current provider prices from its authoritative pricing page. The daily budget must cover the conservative cost of that input ceiling plus OPAS's 1,024-token output ceiling. Missing or malformed admission settings disable only `/api/answers`; there are no guessed prices or budget defaults.

Each request acquires one provider-and-model-bound lease before inference. A Neon transaction serializes the workspace, expires stale active leases, performs bounded cleanup, and admits only when concurrency and reserved-plus-charged rolling 24-hour spend stay within policy. Completion, cancellation, timeout, invalid output, and provider failure reconcile the lease once. Missing, invalid, over-limit, late, or crash-lost usage keeps the full reservation charged, while expiry releases concurrency. Terminal rows older than 31 days are removed opportunistically, at most 100 during one reservation. The implementation uses the serverless driver's [non-interactive transaction batch](https://neon.com/docs/serverless/serverless-driver) so the checks and insert share one database transaction. No fallback provider is configured; a failure cannot create a second reservation or silently change vendors.

The public route also applies a one-minute in-process cap of 120 valid requests. Vercel forwarding headers are not trusted for requester grouping. This best-effort gate sheds bursts; the Neon lease is the cross-instance concurrency and spend boundary.

Support handoff requires exactly one server-selected provider. `cloudflare-rest-email` calls Cloudflare's fixed account Email Sending endpoint and requires the account ID, API token, verified sender, and fixed verified destination. `webhook` accepts one configuration-owned public HTTPS URL and optional bearer token; it rejects credentials, redirects, IP literals, local hostnames, and any DNS answer containing a private, loopback, link-local, documentation, or ULA address. DNS is resolved on every delivery rather than cached; the endpoint remains operator-controlled. Request bodies cannot select a destination. The API accepts page URLs only on `OPAS_SITE_URL` or an exact configured embed-parent origin, validates and bounds contact/context, and rebuilds every citation from current Neon evidence before consuming the atomic workspace allowance. Delivery times out after 45 seconds under the 60-second route ceiling. The contact JSON remains in its own column, separate from conversation context. Provider response bodies and credentials are never logged or returned.

`OPAS_ANSWER_TOPIC_GUARDRAILS` is optional. Leave it absent until the deployment has an approved scope. When used, it must be one compact JSON object with only `allow` and/or `deny` string arrays, at least one phrase, no overlap or duplicates, at most 4,096 UTF-8 bytes and 32 phrases combined, and at most 80 Unicode code points or eight words per phrase. Malformed non-empty configuration fails before provider or repository creation. An exact empty value in `.env` and Docker Compose is treated as absent; other blank or malformed values fail closed. Direct unsafe or denied requests abstain before retrieval, retrieved prompt injection abstains before generation, and denied history is not forwarded into a later clean turn. No model classifier is required for these controls.

The embedding endpoint, model, and dimension must all be present before recovery runs. The endpoint follows the same absolute-URL restrictions as generation; the trimmed model is limited to 200 characters, dimension is a base-10 integer from 1 through 4,096, and `OPAS_EMBEDDING_DIMENSIONS_PARAMETER` accepts only `true` or `false`. The API key is optional for a trusted credential-free endpoint; a non-empty value is limited to 4,096 characters with no line break, is sent as a bearer credential, and is never persisted. Missing provider settings leave publishing, keyword search, and the rest of the application available while semantic indexing remains disabled; malformed non-empty settings fail before the repository is opened.

Vercel sends `CRON_SECRET` to both private scheduled routes as a bearer credential. The route contract accepts 32 through 4,096 UTF-8 bytes with no line break, compares fixed-size SHA-256 digests, disables caching, and returns only status and counts. `vercel.json` schedules embedding recovery at midnight and analytics/handoff physical cleanup at 00:15 UTC. Cleanup drains repeated 1,000-row batches, so it can outpace the 1,024 daily analytics slots plus handoff reservations. Vercel documents both [automatic bearer authentication](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs) and [the plan-specific minimum intervals](https://vercel.com/docs/cron-jobs/usage-and-pricing).

## Disposable acceptance target

An isolated compatibility run may use a linked Vercel project whose name begins with `opas-v02-acceptance-`. The project must have no custom domains, and its canonical origin must be the exact team-scoped automatic `https://<project>-timo-bejans-projects.vercel.app` origin. Opt in explicitly for both commands:

```sh
pnpm vercel:build --acceptance https://opas-v02-acceptance-<run>-timo-bejans-projects.vercel.app
pnpm vercel:deploy --acceptance https://opas-v02-acceptance-<run>-timo-bejans-projects.vercel.app
```

Without `--acceptance`, the wrappers remain pinned to the maintained `opas-mvp` identity and stable origin. Acceptance mode rejects every other project-name prefix and origin, preserves the isolated build and secret scans, and deploys with `--skip-domain`; it never promotes outside the disposable project or attaches an OPAS custom domain, although Vercel may assign that project's automatic team-scoped alias. Delete the disposable project and its matching database after recording verification evidence.

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
vercel env add OPAS_ANSWER_MAXIMUM_CONCURRENCY production
vercel env add OPAS_ANSWER_DAILY_BUDGET_MICRODOLLARS production
vercel env add OPAS_ANSWER_MAXIMUM_INPUT_TOKENS production
vercel env add OPAS_ANSWER_INPUT_MICRODOLLARS_PER_MILLION_TOKENS production
vercel env add OPAS_ANSWER_OUTPUT_MICRODOLLARS_PER_MILLION_TOKENS production
vercel env add OPAS_ANSWER_LEASE_MILLISECONDS production
vercel env add OPAS_ANSWER_ANALYTICS_RETENTION_DAYS production
vercel env add OPAS_ANALYTICS_REDACTION_PATTERNS production
vercel env add OPAS_HANDOFF_DAILY_LIMIT production
vercel env add OPAS_HANDOFF_RETENTION_DAYS production
vercel env add OPAS_HANDOFF_PROVIDER production
vercel env add OPAS_EMBEDDING_ENDPOINT production
vercel env add OPAS_EMBEDDING_MODEL production
vercel env add OPAS_EMBEDDING_DIMENSION production
vercel env add OPAS_EMBEDDING_DIMENSIONS_PARAMETER production
vercel pull --environment=production --yes
```

Add the four `OPAS_HANDOFF_CLOUDFLARE_*`/email values for `cloudflare-rest-email`, or `OPAS_HANDOFF_WEBHOOK_URL` and optional `OPAS_HANDOFF_WEBHOOK_TOKEN` for `webhook`. Add `OPAS_GENERATION_API_KEY` and `OPAS_EMBEDDING_API_KEY` only when their providers require bearer authentication. Add `OPAS_ANSWER_TOPIC_GUARDRAILS` only after selecting an explicit deployment policy; do not create a blank Vercel value for an omitted optional setting.

Vercel prompts for each value without placing it in shell history. Pull again after changing a Production variable so the local build cannot reuse stale project settings. Vercel Secret values are intentionally written as `[SENSITIVE]` when pulled; `.vercel/.env.production.local` is therefore not a source of real local build secrets.

The checked-in wrappers never invoke Next or the Vercel adapter in the repository that contains `.env`. They require the real, non-symbolic-link `.vercel/project.json` to identify the maintained OPAS project or an explicitly named disposable project in the same Vercel team, and reject another target before deleting output or invoking a CLI. The build validates the local administrator credentials plus matching pooled/direct Neon URLs, copies only the checked-in runtime input allowlist and validated project link into a private temporary project without dotenv, key, diagnostic, or tool-state files, and keeps the direct migration URL out of the build process. Package installation, build, and deployment use an empty private home and package-manager configuration; both package-install passes use the checkout's validated pnpm content store offline. Only normalized administrator values, the pooled runtime URL, stable origin, database driver, and an explicit Vercel CLI token enter the command environment. Before building, the wrapper replaces one isolated source module with an artifact-owned `neon` driver constant and a non-secret SHA-256 identity for the validated pooled URL; the checked-in module remains unset for direct Docker and Cloudflare builds. All repository, handoff, analytics, and public-write storage selection refuses a different project-level driver, and the Neon client refuses a different project-level URL before opening a connection. Vercel Sensitive-variable drift therefore fails closed without relying on overridable project or function environment markers and without packaging the URL. After `vercel build`, the wrapper follows only links that resolve inside `.vercel/output`, rejects broken or escaping links, and packages every function-manifest-traced `.next` or `node_modules` leaf into that output while the isolated build tree still exists. Because a flat file map otherwise destroys pnpm's package-local resolution topology, it restores only installed dependency aliases whose exact package-instance files were already traced, preserves scoped and generated placements, and rejects path collisions or files mixed from different package instances. Source paths, directory traversal, internal package links, dotenv names, cycles, and special entries are validated before the function maps are rewritten to the packaged copies. The wrapper then scans every raw, JSON-escaped, URL-escaped, base64, or base64url form of local and process secret values. Internal absolute links become portable relative links on Unix and materialized copies on Windows. Only the twice-scanned, self-contained output is copied back; a failed build or scan leaves no prebuilt output available for deployment.

If the compatibility URL redirects to Vercel Authentication because the account default was inherited, disable SSO protection for this project only and verify the public health endpoint again:

```sh
vercel project protection disable opas-mvp --sso
curl --fail --silent --show-error https://opas-mvp-timo-bejans-projects.vercel.app/api/health
```

## Build, migrate, and seed

Keep the pooled `NEON_DATABASE_URL` and actual administrator values in the gitignored root `.env`. The wrapper derives a direct URL in memory or validates an optional explicit `NEON_DIRECT_DATABASE_URL`; either way, only the pooled URL enters the isolated build environment. Build the staged Vercel Production-environment artifact before changing Neon:

```sh
pnpm vercel:build https://opas-mvp-timo-bejans-projects.vercel.app
```

Then run the transactional migration and missing-only seed against the direct connection. The command rejects every ambient `PG*`, Node TLS, OpenSSL, or certificate-store override before opening the validated URL. It constructs the effective host, port, credentials, database, verified TLS, and channel-binding settings explicitly rather than letting `pg` reinterpret the URL through ambient defaults:

```sh
pnpm neon:prepare
```

The command applies `drizzle/postgres` migrations over a direct PostgreSQL connection and inserts missing demo records. It does not replace records already edited by an administrator. Run it once before the first deployment and again after pulling any commit that adds a migration.

Every migration must be expand-first and remain compatible with both the current deployment and the staged artifact. Building first removes compile failures from the post-migration window, but an upload can still fail while the current deployment continues using the migrated schema.

## Deploy and smoke-test

Create a staged Production deployment without moving the public domain:

```sh
pnpm vercel:deploy https://opas-mvp-timo-bejans-projects.vercel.app
```

The deploy wrapper revalidates the project link and all local secret encodings, scans the saved prebuilt output again, copies it into a private temporary deployment project, rewrites internal links, scans the snapshot, and makes the snapshot read-only before invoking Vercel with fixed Production, `fra1`, and `--skip-domain` flags. The explicit deploy region keeps prebuilt functions beside the `eu-central-1` Neon branch even when Vercel would otherwise apply its default function region. The checkout artifact can change only after the immutable snapshot has been selected, so the uploaded bytes are the bytes that passed the final scan. The command prints the staged deployment URL and does not promote it.

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

The first NDJSON record must expose the configured provider, model, and exact retention disclosure. A supported answer then needs at least one validated content record followed by a server-owned citation and one finish record. Confirm the citation resolves to the current published revision and the lease is terminal, bound to the same provider and model, and charged no more than its reservation. Send a direct prompt-injection attempt and verify it yields one `unsafe-request` abstention without a corresponding provider request or lease. Provider dashboards or audit records must match the configured retention disclosure; OPAS cannot enforce an upstream provider's storage policy. In a disposable deployment with generation or admission settings absent, the answer endpoint must be unavailable while `pnpm smoke "$DEPLOYMENT_URL"` still passes.

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

A Vercel rollback moves only the compatibility alias and does not undo database migrations. Vercel Instant Rollback also does not update active cron jobs: inspect both registered paths after rollback. Do not accept a rollback to code without `/api/internal/analytics`; keep the current cleanup-capable version active or forward-fix immediately, and invoke the authenticated cleanup route manually while repairing traffic. Before a future destructive migration, create a Neon branch or backup. Repair schema state with a reviewed forward migration; do not edit or delete entries in `drizzle.__drizzle_migrations` manually.

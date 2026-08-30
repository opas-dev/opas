# Deploy to Cloudflare Workers and D1

Cloudflare Workers and D1 are the primary OPAS production deployment. The checked-in Wrangler config is pinned to the maintained `opas-mvp` deployment in the DevPlant account, with `demo.opas.dev` as its canonical Custom Domain and workers.dev explicitly retained as a fallback. Cloudflare creates the Custom Domain DNS record and certificate during deployment. A fork may replace the explicit account ID and use its own matching `opas-*` Worker, D1 database, and workers.dev hostname. The bootstrap rejects malformed account IDs, names outside `opas-*`, `opas-landing`, mismatched Worker/database names, and every custom route except the exact maintained `demo.opas.dev` target.

## First deployment

1. Install dependencies and authenticate Wrangler:

   ```sh
   pnpm install --frozen-lockfile
   pnpm exec wrangler login
   ```

2. Copy `.env.example` to `.env` and set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and a random `ADMIN_SESSION_SECRET` of at least 32 bytes. Wrangler OAuth supplies the Cloudflare credential; no API token belongs in `.env`.

3. Create an AI Gateway named `opas-answers` in the same account as the Worker. The checked-in configuration deliberately does not use Cloudflare's auto-created `default` gateway. The bootstrap validates the identifier but cannot prove that the remote gateway exists without making an inference request.

4. Run the guarded bootstrap:

   ```sh
   pnpm cf:bootstrap
   ```

The command builds with OpenNext before making remote changes, creates the exact D1 database when absent, pins its generated ID in `wrangler.jsonc`, dry-runs the deployment bundle, applies remote migrations, inserts missing demo records, deploys the Worker and admin secrets together, and runs the portable smoke suite. Re-running it is safe: migrations converge and the seed does not overwrite administrator edits.

`wrangler.jsonc` binds Workers AI as `AI` and runs bounded embedding recovery every minute. The custom Worker keeps OpenNext's generated fetch handler and adds only the scheduled handler, following OpenNext's [custom Worker contract](https://opennext.js.org/cloudflare/howtos/custom-worker). D1 always uses `@cf/baai/bge-base-en-v1.5`, 768 dimensions, and `cls` pooling; those values are part of the persisted configuration identity and are not deployment variables. Cloudflare documents the model's [dimension and pooling contract](https://developers.cloudflare.com/workers-ai/models/bge-base-en-v1.5/) and notes that Workers AI binding calls incur usage even during local development.

## Answer generation and safety

The maintained Worker uses `@cf/meta/llama-3.1-8b-instruct-fp8` through the `opas-answers` gateway. `OPAS_GENERATION_GATEWAY_ID`, `OPAS_GENERATION_MODEL`, and the browser-visible `OPAS_GENERATION_RETENTION_DISCLOSURE` live in `wrangler.jsonc`; they are not secrets. Bootstrap passes all three through the same bounded parser as the answer runtime. Gateway IDs must contain at most 128 lowercase letters, digits, or single hyphen separators. Model and disclosure values must be non-empty and control-free, with respective UTF-8 limits of 256 and 1,024 bytes. Missing or malformed values make only `/api/answers` unavailable; article rendering and ordinary search do not construct the answer runtime.

Every generation call sets `collectLog: false` and `skipCache: true`. Cloudflare documents that the first setting skips the entire [AI Gateway log entry](https://developers.cloudflare.com/ai-gateway/observability/logging/#collect-logs-cf-aig-collect-log), including prompt and response data, and that the second skips the [AI Gateway response cache](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/#gateway-options). `skipCache` does not claim to disable model-level inference optimizations such as Workers AI prompt caching. OPAS persistence is limited to configured redacted conversation records; the v0.2 target is a 30-day default once that record path ships. Raw provider prompts, retrieved evidence, provider responses, credentials, and error bodies stay out of application logs. The answer endpoint and portable provider request both use `no-store`, and provider error bodies are discarded unread. Cloudflare's [Workers AI data-use policy](https://developers.cloudflare.com/workers-ai/platform/data-usage/) says Customer Content is not exposed to other customers or used to train models or improve services without explicit consent, and may be stored when an explicit Cloudflare storage service is used with Workers AI.

`OPAS_ANSWER_TOPIC_GUARDRAILS` is optional and is intentionally absent from the checked-in deployment: OPAS ships no guessed allow or deny policy. When a deployment has an approved scope, add one compact JSON object to Wrangler `vars` with only `allow` and/or `deny` arrays. At least one phrase is required; the whole value is limited to 4,096 UTF-8 bytes and 32 phrases combined. Each normalized phrase is limited to 80 Unicode code points and eight letter-or-number words separated by single spaces or hyphens. Empty phrases, duplicate phrases, overlap between allow and deny, control characters, unknown keys, and malformed JSON fail closed before bindings, repositories, retrieval, or generation are created. Omit the variable when no deployment-specific topic policy has been selected; do not set an empty Wrangler value.

Topic rules and direct prompt-injection checks run on the current question before retrieval. A denied or unsafe earlier turn is removed from model history instead of poisoning a later clean question. Retrieved titles, headings, and evidence receive a separate deterministic injection check before generation. These checks do not require a model classifier. Citations remain server-owned and candidates are revalidated against the current published revision immediately before they can reach the provider.

## Routine deployment

Apply schema changes and missing seed records before deploying application code:

```sh
pnpm cf:build
pnpm exec opennextjs-cloudflare deploy --dry-run
pnpm cf:migrate
pnpm cf:seed
pnpm exec opennextjs-cloudflare deploy
pnpm smoke https://demo.opas.dev
curl --fail --silent --show-error https://opas-mvp.timo-bejan.workers.dev/api/health
```

When a published FAQ article is available, require both its complete Article and FAQPage structured-data contracts in the same run:

```sh
OPAS_SMOKE_FAQ_PATH=/getting-started/your-faq-slug pnpm smoke https://demo.opas.dev
```

Build before changing D1 so a compile or configuration failure leaves the active schema untouched. Every migration must be expand-first and remain compatible with both the active Worker and the build being deployed: an upload can still fail after migration. The deploy preserves existing Worker secrets. Use `pnpm cf:bootstrap` whenever admin credentials also need to be applied from `.env`; use `pnpm cf:deploy` only for an application-only release with no schema change.

To exercise the scheduled handler locally without deploying, build the OpenNext artifact, start Wrangler's scheduled-event test mode, and invoke its test endpoint. This calls Workers AI on the Cloudflare account and can incur usage:

```sh
pnpm cf:build
pnpm exec wrangler dev --test-scheduled
curl --fail --silent --show-error "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"
```

The recovery runner drains completed jobs until it reaches idle state, 100 jobs, or 50 seconds. Database leases make overlapping or duplicate cron events idempotent. Provider retry, terminal failure, and lease loss stop the current invocation; the next cron supplies expiry recovery without blocking publishing or ordinary requests. Logs contain status and counts, never credentials, evidence text, or provider response bodies.

## Answer verification

Run the local contract tests before a release:

```sh
pnpm exec tsx --test tests/generation-config.test.ts tests/answer-route.test.ts tests/answer-guardrails.test.ts tests/embedding-deployment.test.ts tests/cloudflare-bootstrap.test.ts
```

After deploying, ask a question whose answer appears in a current published article and retain the headers and complete NDJSON stream:

```sh
ANSWER_ORIGIN=https://demo.opas.dev
curl --fail-with-body --no-buffer --silent --show-error \
  --dump-header /tmp/opas-answer.headers \
  --header 'content-type: application/json' \
  --data '{"question":"How is the Runtime MDX article loaded?"}' \
  "$ANSWER_ORIGIN/api/answers" | tee /tmp/opas-answer.ndjson
rg -i '^cache-control: no-store' /tmp/opas-answer.headers
```

Acceptance requires a `metadata` record first, at least one independently validated `content` record followed by a server-owned `citation`, and one final `finish` record. The metadata disclosure must exactly match `wrangler.jsonc`. Confirm the cited URL is a currently published OPAS article, the gateway dashboard has no log row for the request, and a repeat request is not marked as an AI Gateway cache hit. Then send a direct injection attempt; it must return one `unsafe-request` abstention before any new gateway request appears. If the gateway or model is unavailable, `/api/answers` must return the safe `unavailable` code while `pnpm smoke "$ANSWER_ORIGIN"` still passes the article and search checks.

## Rollback

List versions, then roll the exact `opas-mvp` Worker back to a known-good version:

```sh
pnpm exec wrangler versions list --name opas-mvp
OPAS_WORKER_VERSION_ID=00000000-0000-0000-0000-000000000000
pnpm exec wrangler rollback "$OPAS_WORKER_VERSION_ID" --name opas-mvp --message "Rollback OPAS" --yes
pnpm smoke https://demo.opas.dev
curl --fail --silent --show-error https://opas-mvp.timo-bejan.workers.dev/api/health
```

The portable smoke suite runs against the canonical origin because it verifies exact canonical and sitemap URLs. The workers.dev fallback check is deliberately limited to the health endpoint; its rendered pages advertise `demo.opas.dev` as canonical.

Do not add the protected `opas.dev` root, `www`, `opas-landing`, or any unrelated route or resource to the Wrangler config. The only maintained Custom Domain exception is `demo.opas.dev` on `opas-mvp`.

A Worker rollback does not roll D1 back. Repair schema state with a reviewed forward migration.

Cloudflare references: [OpenNext CLI](https://opennext.js.org/cloudflare/cli), [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/), and [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

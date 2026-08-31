# Deploy to Cloudflare Workers and D1

Cloudflare Workers and D1 are the primary OPAS production deployment. The checked-in Wrangler config is pinned to the maintained `opas-mvp` deployment in the DevPlant account, with `demo.opas.dev` as its canonical Custom Domain and workers.dev explicitly retained as a fallback. Cloudflare creates the Custom Domain DNS record and certificate during deployment. A fork may replace the explicit account ID and use its own matching `opas-*` Worker, D1 database, and workers.dev hostname. The bootstrap rejects malformed account IDs, names outside `opas-*`, `opas-landing`, mismatched Worker/database names, and every custom route except the exact maintained `demo.opas.dev` target.

## First deployment

1. Install dependencies and authenticate Wrangler:

   ```sh
   pnpm install --frozen-lockfile
   pnpm exec wrangler login
   ```

2. Copy `.env.example` to `.env` and set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, a random `ADMIN_SESSION_SECRET` of at least 32 bytes, and `OPAS_HANDOFF_TO_EMAIL` to a destination verified for Cloudflare Email Sending. Wrangler OAuth supplies the Cloudflare credential; no API token belongs in `.env`.

3. Create an AI Gateway named `opas-answers` in the same account as the Worker. The checked-in configuration deliberately does not use Cloudflare's auto-created `default` gateway. The bootstrap validates the identifier but cannot prove that the remote gateway exists without making an inference request.

4. Run the guarded bootstrap:

   ```sh
   pnpm cf:bootstrap
   ```

The command builds with OpenNext before making remote changes, creates the exact D1 database when absent, pins its generated ID in `wrangler.jsonc`, dry-runs the deployment bundle, applies remote migrations, inserts missing demo records, deploys the Worker and admin secrets together, and runs the portable smoke suite. Re-running it is safe: migrations converge and the seed does not overwrite administrator edits. Every remote OPAS package command validates the selected account, Worker, D1 name and ID, and route before it can touch Cloudflare. Build, deploy, preview, and bootstrap commands additionally copy the project to a private temporary directory without `.env`, `.dev.vars`, prior build output, local deployment state, or symbolic-link inputs. Build subprocesses receive no application, package-registry, source-control, Cloudflare, or other credential-shaped variables. Deploy subprocesses receive only the sanitized operating environment and explicit Cloudflare authentication; inherited Wrangler target, name, endpoint, and environment controls are removed. A frozen offline install keeps dependencies inside that directory. The command rejects any dotenv file, non-empty compiled Next environment, escaping output link, or raw/escaped/URL-encoded/base64 local or process secret in the Next and OpenNext outputs; deployment dry-runs additionally scan Wrangler's final bundle. Build, scan, dry-run, and upload share the same temporary lifecycle because OpenNext emits absolute dependency paths; signal handlers and ordinary cleanup delete the temporary tree, plaintext bootstrap secret file, and managed bundle on success, failure, SIGINT, or SIGTERM, and no non-portable artifact is copied into the checkout. Do not invoke the OpenNext CLI directly from a checkout that contains `.env`.

`wrangler.jsonc` declares the exact encrypted bindings in `secrets.required`: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, and `OPAS_HANDOFF_TO_EMAIL`. An explicitly enabled cross-provider fallback must also declare `OPAS_GENERATION_FALLBACK_API_KEY` and `OPAS_GENERATION_FALLBACK_ENDPOINT`; declaring either without the complete fallback configuration is rejected. Wrangler treats `--secrets-file` as additive and does not remove omitted secrets, so every guarded upload runs `wrangler secret list --format json` against the isolated validated config before and after uploading. An existing Worker must have no undeclared remote secret names. Missing declared names are accepted before upload only when bootstrap supplies the complete validated secret file, and the post-upload set must be exact. A missing new `opas-*` Worker is accepted only on that same bootstrap path. Config and secret-file digests remain guarded throughout both checks and the upload, and secret values are never read from Cloudflare or printed.

`wrangler.jsonc` binds Workers AI as `AI`, runs bounded embedding recovery every minute, and runs independent privacy cleanup daily at 00:15 UTC. The custom Worker keeps OpenNext's generated fetch handler and adds only the scheduled handler, following OpenNext's [custom Worker contract](https://opennext.js.org/cloudflare/howtos/custom-worker). D1 always uses `@cf/baai/bge-base-en-v1.5`, 768 dimensions, and `cls` pooling; those values are part of the persisted configuration identity and are not deployment variables. Cloudflare documents the model's [dimension and pooling contract](https://developers.cloudflare.com/workers-ai/models/bge-base-en-v1.5/) and notes that Workers AI binding calls incur usage even during local development.

## Answer generation and safety

The maintained Worker uses `@cf/meta/llama-3.1-8b-instruct-fp8` through the `opas-answers` gateway. `OPAS_GENERATION_GATEWAY_ID`, `OPAS_GENERATION_MODEL`, and the browser-visible `OPAS_GENERATION_RETENTION_DISCLOSURE` live in `wrangler.jsonc`; they are not secrets. Bootstrap passes all three through the same bounded parser as the answer runtime. Gateway IDs must contain at most 128 lowercase letters, digits, or single hyphen separators. Model and disclosure values must be non-empty and control-free, with respective UTF-8 limits of 256 and 1,024 bytes. Missing or malformed values make only `/api/answers` unavailable; article rendering and ordinary search do not construct the answer runtime.

The checked-in admission contract allows four concurrent streams per workspace and a rolling 24-hour budget of 1,000,000 microdollars. It reserves against at most 32,000 input tokens and the server-owned 1,024-token output limit, with a 45-second lease. The input and output prices are 152,000 and 287,000 microdollars per million tokens, matching Cloudflare's current [Workers AI token-pricing table](https://developers.cloudflare.com/workers-ai/platform/pricing/); the model page confirms its [32,000-token context window](https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/). At those limits one request reserves 5,158 microdollars before Workers AI is called. Every value is a canonical base-10 integer; missing, signed, padded, fractional, whitespace-padded, or out-of-range values fail closed before a provider binding or repository is created. Recheck both linked contracts before changing the model or deploying after a price change.

An atomic D1 batch locks a per-workspace serialization row, expires stale active leases, performs bounded cleanup, and admits a lease only when both concurrency and reserved-plus-charged rolling spend remain within policy. Completion, cancellation, timeout, invalid output, and provider failure reconcile a still-active lease once from provider-reported usage. Missing, invalid, over-limit, late, or crash-lost usage keeps the full reservation charged; an expired lease releases concurrency but never releases possibly spent budget. Terminal rows older than 31 days are removed opportunistically, at most 100 for that workspace during one reservation. D1 documents that [`batch()` is transactional and rolls back the complete sequence on failure](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). No cross-provider fallback adapter is configured, so one lease remains bound to its recorded Workers AI provider and model.

Before database admission, a one-minute in-memory gate caps the process at 120 valid answer requests and a Cloudflare-authenticated requester at 10. The requester key is a process-salted SHA-256 digest of `CF-Connecting-IP`; raw addresses and digests are never persisted. Other deployment targets do not trust forwarded IP headers and apply only the process gate. These counters shed brief abuse; the database lease is the authoritative cross-isolate concurrency and spend boundary.

Every generation call sets `collectLog: false` and `skipCache: true`. Cloudflare documents that the first setting skips the entire [AI Gateway log entry](https://developers.cloudflare.com/ai-gateway/observability/logging/#collect-logs-cf-aig-collect-log), including prompt and response data, and that the second skips the [AI Gateway response cache](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/#gateway-options). `skipCache` does not claim to disable model-level inference optimizations such as Workers AI prompt caching. Redacted answer conversations default to 30 days and may be shortened or disabled; explicit support-handoff contact/context is a separate record with its own 30-day default. Raw requester IP, user agent, cookies, provider prompts, credentials, and error bodies are not persisted. The answer endpoint and portable provider request both use `no-store`, and provider error bodies are discarded unread. Cloudflare's [Workers AI data-use policy](https://developers.cloudflare.com/workers-ai/platform/data-usage/) says Customer Content is not exposed to other customers or used to train models or improve services without explicit consent, and may be stored when an explicit Cloudflare storage service is used with Workers AI.

`OPAS_ANSWER_TOPIC_GUARDRAILS` is optional and is intentionally absent from the checked-in deployment: OPAS ships no guessed allow or deny policy. When a deployment has an approved scope, add one compact JSON object to Wrangler `vars` with only `allow` and/or `deny` arrays. At least one phrase is required; the whole value is limited to 4,096 UTF-8 bytes and 32 phrases combined. Each normalized phrase is limited to 80 Unicode code points and eight letter-or-number words separated by single spaces or hyphens. Empty phrases, duplicate phrases, overlap between allow and deny, control characters, unknown keys, and malformed JSON fail closed before bindings, repositories, retrieval, or generation are created. Omit the variable when no deployment-specific topic policy has been selected; do not set an empty Wrangler value.

Topic rules and direct prompt-injection checks run on the current question before retrieval. A denied or unsafe earlier turn is removed from model history instead of poisoning a later clean question. Retrieved titles, headings, and evidence receive a separate deterministic injection check before generation. These checks do not require a model classifier. Citations remain server-owned and candidates are revalidated against the current published revision immediately before they can reach the provider.

## Support handoff delivery

`wrangler.jsonc` exposes one `SUPPORT_EMAIL` Send Email binding restricted to the verified `hello@opas.dev` sender. The bootstrap uploads `OPAS_HANDOFF_TO_EMAIL` with the administrator secrets; the destination is never a public Wrangler variable or request field. The browser offers the inline form after an abstention or a negative answer rating. The API bounds the question, eight-message transcript, page URL, contact, and citations; strips page query and fragment data; and rebuilds each citation from current published D1 evidence before storing or sending it.

Every request atomically inserts its UUID idempotency key into D1 `support_handoffs` before delivery. Contact JSON and conversation context use separate columns. Concurrent repeats can have only one reservation winner, a different payload under the same key conflicts, and a terminal delivery failure is not automatically resent because a network failure can be ambiguous after the provider accepts a message. The browser's “Check delivery” action repeats the same key and explicitly says that it will not send twice. Structured Email Sending fields carry the fixed sender, destination, user address as `Reply-To`, plain text, escaped HTML, and a safe idempotency header; provider bodies, credentials, and submitted content never enter application logs or public errors.

A one-minute warm-process gate admits at most 20 valid handoff requests and, on D1 only, at most two per Cloudflare-authenticated `CF-Connecting-IP`. After complete payload and current-evidence validation, the D1 transaction admits at most 100 distinct handoff keys in a rolling 24 hours; same-key checks do not spend again, and invalid citations spend nothing. The requester key is a process-salted digest held only in memory; raw addresses, user agents, cookies, and digests are never persisted. Delivery is capped at 45 seconds, and the separate `support_handoffs` cleanup deletes contact/context older than `OPAS_HANDOFF_RETENTION_DAYS` (30 by default).

Run `pnpm test:handoff` before release. After deploying the migration and Worker secrets, trigger one handoff from the browser, confirm one message reaches the verified destination, and confirm the matching D1 row becomes `delivered`. Repeat the same browser request and verify no second message is accepted. Then test a forced provider failure and confirm the row becomes `failed`, the response stays sanitized, and “Check delivery” does not resend. This real provider acceptance is required for release and cannot be inferred from a dry-run build.

## Routine deployment

Apply schema changes and missing seed records before deploying application code:

```sh
pnpm cf:build
pnpm cf:dry-run
pnpm cf:migrate
pnpm cf:seed
pnpm cf:deploy
pnpm smoke https://demo.opas.dev
curl --fail --silent --show-error https://opas-mvp.timo-bejan.workers.dev/api/health
```

When a published FAQ article is available, require both its complete Article and FAQPage structured-data contracts in the same run:

```sh
OPAS_SMOKE_FAQ_PATH=/getting-started/your-faq-slug pnpm smoke https://demo.opas.dev
```

`pnpm cf:build` is an isolated build-and-scan check and deliberately leaves no local artifact. Its dotenv-free project installs from the exact content store recorded by the checkout's `node_modules/.modules.yaml`, with offline mode pinned after environment sanitization; run `pnpm install --frozen-lockfile` first. Build and dry-run before changing D1 so a compile, configuration, dependency-store, or final-bundle safety failure leaves the active schema untouched. `pnpm cf:deploy` performs its own isolated rebuild and scanned dry-run before upload. Every migration must be expand-first and remain compatible with both the active Worker and the build being deployed: an upload can still fail after migration. Routine deploys require the remote secret-name set to already match `secrets.required`; they never preserve an undeclared secret silently. Use `pnpm cf:bootstrap` whenever declared credentials also need to be applied from `.env`; use `pnpm cf:deploy` only for an application-only release with no schema change. If a preflight reports an undeclared remote name, review it and remove that exact binding with `pnpm exec wrangler secret delete <NAME> --config wrangler.jsonc` under the production confirmation gate, then rerun the guarded deployment.

To exercise the scheduled handler locally without deploying, start the guarded preview in scheduled-event test mode and invoke its test endpoint from another terminal while it is running. This calls Workers AI on the Cloudflare account and can incur usage:

```sh
pnpm cf:preview -- --test-scheduled
curl --fail --silent --show-error "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"
curl --fail --silent --show-error "http://127.0.0.1:8787/__scheduled?cron=15+0+*+*+*"
```

The recovery runner drains completed jobs until it reaches idle state, 100 jobs, or 50 seconds. Database leases make overlapping or duplicate cron events idempotent. Provider retry, terminal failure, and lease loss stop the current invocation; the next cron supplies expiry recovery without blocking publishing or ordinary requests. Logs contain status and counts, never credentials, evidence text, or provider response bodies.

## Answer verification

Run the local contract tests before a release:

```sh
pnpm exec tsx --test tests/generation-config.test.ts tests/answer-admission.test.ts tests/answer-gate.test.ts tests/answer-route.test.ts tests/answer-guardrails.test.ts tests/embedding-deployment.test.ts tests/cloudflare-bootstrap.test.ts
pnpm test:handoff
pnpm exec tsx --test --test-concurrency=1 tests/repository.integration.test.ts
```

The answer tests must prove denial happens before the provider, every stream exit settles once, admission outages expose no internal details, and no provider fallback or second reservation occurs. The repository suite races 12 reservations against both Postgres and SQLite, accepts exactly the configured concurrency, blocks spend overflow, preserves the first reconciliation, and charges expired leases conservatively before releasing their concurrency.

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

Acceptance requires a `metadata` record first, at least one complete validated `content` record followed by a server-owned `citation`, and one final `finish` record. The metadata disclosure must exactly match `wrangler.jsonc`. Confirm the cited URL is a currently published OPAS article, the gateway dashboard has no log row for the request, and a repeat request is not marked as an AI Gateway cache hit. Confirm the successful lease records the configured provider and model, is terminal rather than active, and charges no more than its 5,158-microdollar reservation. Then send a direct injection attempt; it must return one `unsafe-request` abstention before any new gateway request or inference lease appears. If the gateway, model, admission configuration, or lease repository is unavailable, `/api/answers` must return the safe `unavailable` code while `pnpm smoke "$ANSWER_ORIGIN"` still passes the article and search checks.

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

A Worker rollback does not roll D1 back. The daily trigger may remain registered while older code lacks its cleanup branch, so verify both cron events after rollback. Do not leave cleanup inactive: invoke the authenticated Node route where available, keep rollback shorter than the retention cleanup interval, or forward-fix the Worker before accepting the rollback. Repair schema state with a reviewed forward migration.

Cloudflare references: [OpenNext CLI](https://opennext.js.org/cloudflare/cli), [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/), and [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

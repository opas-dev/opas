# Deploy to Cloudflare Workers and D1

Cloudflare Workers and D1 are the primary OPAS production deployment. The checked-in Wrangler config is pinned to the maintained `opas-mvp` deployment in the DevPlant account, with `demo.opas.dev` as its canonical Custom Domain and workers.dev explicitly retained as a fallback. Cloudflare creates the Custom Domain DNS record and certificate during deployment. A fork may replace the explicit account ID and use its own matching `opas-*` Worker, D1 database, and workers.dev hostname. The bootstrap rejects malformed account IDs, names outside `opas-*`, `opas-landing`, mismatched Worker/database names, and every custom route except the exact maintained `demo.opas.dev` target.

## First deployment

1. Install dependencies and authenticate Wrangler:

   ```sh
   pnpm install --frozen-lockfile
   pnpm exec wrangler login
   ```

2. Copy `.env.example` to `.env` and set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and a random `ADMIN_SESSION_SECRET` of at least 32 bytes. Wrangler OAuth supplies the Cloudflare credential; no API token belongs in `.env`.

3. Run the guarded bootstrap:

   ```sh
   pnpm cf:bootstrap
   ```

The command builds with OpenNext before making remote changes, creates the exact D1 database when absent, pins its generated ID in `wrangler.jsonc`, dry-runs the deployment bundle, applies remote migrations, inserts missing demo records, deploys the Worker and admin secrets together, and runs the portable smoke suite. Re-running it is safe: migrations converge and the seed does not overwrite administrator edits.

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

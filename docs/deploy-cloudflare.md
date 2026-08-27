# Deploy to Cloudflare Workers and D1

The checked-in Wrangler config is pinned to the maintained `opas-mvp` deployment in the DevPlant account. A fork may replace that explicit account ID and use its own matching `opas-*` Worker, D1 database, and workers.dev hostname. The bootstrap rejects malformed account IDs, names outside `opas-*`, `opas-landing`, mismatched Worker/database names, and custom routes.

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
pnpm smoke https://opas-mvp.timo-bejan.workers.dev
```

Build before changing D1 so a compile or configuration failure leaves the active schema untouched. Every migration must be expand-first and remain compatible with both the active Worker and the build being deployed: an upload can still fail after migration. The deploy preserves existing Worker secrets. Use `pnpm cf:bootstrap` whenever admin credentials also need to be applied from `.env`; use `pnpm cf:deploy` only for an application-only release with no schema change.

## Rollback

List versions, then roll the exact `opas-mvp` Worker back to a known-good version:

```sh
pnpm exec wrangler versions list --name opas-mvp
pnpm exec wrangler rollback <version-id> --name opas-mvp --message "Rollback OPAS" --yes
pnpm smoke https://opas-mvp.timo-bejan.workers.dev
```

Do not add the protected `opas.dev` root, `www`, `opas-landing`, or any unrelated resource to the Wrangler config.

A Worker rollback does not roll D1 back. Repair schema state with a reviewed forward migration.

Cloudflare references: [OpenNext CLI](https://opennext.js.org/cloudflare/cli), [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/), and [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

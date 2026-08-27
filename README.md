# OPAS

OPAS is an open-source help center for the AI era: theme it at runtime, deploy it anywhere, and own both the content and the agent-readable surfaces.

- Runtime theming stores brand colors, fonts, radii, and the logo in the database and applies them without a rebuild.
- Database-backed MDX gives administrators one authoring and publishing workflow across every deployment target.
- Search, sitemap, Article and FAQ structured data, `/llms.txt`, `/llms-full.txt`, and per-article Markdown are built in.
- Anonymous helpfulness feedback and 30-day aggregate analytics avoid cookies and persisted requester metadata.
- The same application supports Docker with Postgres, Vercel with Neon, and Cloudflare Workers with D1.

OPAS is preparing its v0.1 release. The implementation plan and verification record live in [progress.md](progress.md); the product and architecture brief is in [docs/brief.md](docs/brief.md).

## Live targets

| Target | Database | URL |
| --- | --- | --- |
| Docker | Postgres | `http://localhost:3000` after local startup |
| Cloudflare Workers | D1 | [opas-mvp.timo-bejan.workers.dev](https://opas-mvp.timo-bejan.workers.dev) |
| Vercel | Neon Postgres | Pending production verification; the URL will be added after rollout |

## Prerequisites

- Node.js 22 or newer
- pnpm 10.13.1 through Corepack
- Docker for the Docker target and repository integration tests
- An authenticated Wrangler CLI and Cloudflare account for a Workers deployment
- A Neon database and authenticated Vercel CLI for a Vercel deployment

Install the pinned dependencies once:

```sh
corepack enable
pnpm install --frozen-lockfile
```

## Docker quickstart

Copy the single environment template and set `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET`. Keep `OPAS_SITE_URL` aligned with the public port; the template already uses `http://localhost:3000`.

```sh
cp .env.example .env
docker compose up --build
```

The container waits for Postgres, applies migrations, inserts missing demo records, and starts as a non-root user. Existing records are not overwritten on restart.

Verify the public and database-backed routes from another terminal:

```sh
pnpm smoke http://localhost:3000
```

The public site is at [localhost:3000](http://localhost:3000) and administration is at [localhost:3000/admin](http://localhost:3000/admin). Stop the stack with `docker compose down`; add `--volumes` only when you intentionally want to remove the local database.

## Cloudflare quickstart

OPAS uses `@opennextjs/cloudflare` and D1. The checked-in release target is pinned to the DevPlant account, the `opas-mvp` Worker and D1 database, and its workers.dev origin. A fork can set its own explicit account ID and matching `opas-*` names. Copy `.env.example` to the gitignored `.env`, set the administrator credentials, then run:

```sh
pnpm exec wrangler login
pnpm cf:bootstrap
```

The bootstrap validates the scoped names and account, creates or finds the exact D1 database, applies migrations, inserts missing demo records, deploys with encrypted Worker secrets, and runs the HTTP smoke suite. Use `pnpm cf:deploy` for subsequent application-only releases.

See [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md) for configuration, migration, verification, and rollback details.

## Vercel quickstart

Create one Neon branch, copy `.env.example` to `.env`, and put its direct connection string there as `NEON_DATABASE_URL`. Link the checkout to Vercel and configure the six Production variables listed in [docs/deploy-vercel.md](docs/deploy-vercel.md). Then build before migrating, prepare Neon transactionally, and upload the staged artifact:

```sh
vercel link
vercel build --prod --yes
pnpm neon:prepare
vercel deploy --prebuilt --prod --skip-domain
```

Smoke-test the staged deployment before promoting it. `vercel.json` keeps the function in `fra1`, close to the documented Neon region. The complete environment, promotion, and rollback procedure is in [docs/deploy-vercel.md](docs/deploy-vercel.md).

## Development and verification

Run the app against the Postgres URL in `.env`:

```sh
docker compose up -d --wait db
node --env-file=.env --import tsx scripts/prepare-postgres.ts
pnpm dev
```

Before submitting a change, keep Docker available for the cross-dialect repository suite and run:

```sh
pnpm test
pnpm build
pnpm cf:build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for repository conventions and contribution scope.

## Roadmap

- v0.1: finish the verified Docker, Cloudflare, and Vercel release with runtime theming, MDX authoring, search, discovery surfaces, and privacy-light analytics.
- Community follow-ups: content-freshness automation, draft-from-ticket workflows, theme experiments, and a plugin system.
- Commercial edition: SAML and SCIM, audit logs, advanced permissions, multi-brand operation, and white-label controls in the isolated `/ee` directory.

Ticketing, live chat, AI retrieval answers, multi-language authoring, and a WYSIWYG editor are outside the v0.1 scope.

## License

The community code is licensed under [AGPL-3.0-only](LICENSE). Future commercially licensed features belong only in [`/ee`](ee/README.md); community core code must never import from that directory.

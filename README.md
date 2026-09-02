# OPAS Answers

OPAS Answers is an open-source help center and source-grounded answer system: theme it at runtime, deploy it anywhere, and own the knowledge, answer pipeline, and agent-readable surfaces.

- Runtime theming stores brand colors, fonts, radii, and the logo in the database and applies them without a rebuild.
- Database-backed Markdown gives administrators visual and source authoring, safe preview, and one publishing workflow across every deployment target.
- Markdown and GitBook imports preserve shallow navigation, source order, links, and bounded content-addressed images with dry-run and rollback reports.
- Search, sitemap, Article and FAQ structured data, `/llms.txt`, `/llms-full.txt`, and per-article Markdown are built in.
- Native and embeddable answers stream from current published evidence with server-owned citations, deterministic abstention, and contextual support handoff.
- Saved evaluations, answer outcomes, redacted traces, and content-gap analytics turn failed questions into a measurable knowledge-improvement queue.
- Read-only MCP search and read tools expose the current published help corpus to compatible agents.
- Anonymous helpfulness feedback and 30-day aggregate analytics avoid cookies and persisted requester metadata.
- The same application supports Docker with Postgres, Vercel with Neon, and Cloudflare Workers with D1.

OPAS Answers v0.2.0 is the latest verified release. The completed release evidence is tracked in [progress.md](progress.md), the source-backed product direction is in [docs/competitive-roadmap.md](docs/competitive-roadmap.md), and the proposed next release is the [Team Authoring v0.3 implementation plan](docs/team-authoring-plan.md). The original product and architecture brief remains in [docs/brief.md](docs/brief.md).

## Live targets

| Target | Database | Role | URL |
| --- | --- | --- | --- |
| Docker | Postgres | Self-hosted | `http://localhost:3000` after local startup |
| Cloudflare Workers | D1 | Primary production | [demo.opas.dev](https://demo.opas.dev) ([workers.dev fallback](https://opas-mvp.timo-bejan.workers.dev)) |
| Cloudflare Workers | Isolated D1 | Maintained CROFusion pilot demo | [demo-cro.opas.dev](https://demo-cro.opas.dev) |
| Vercel | Neon Postgres | Live compatibility | [opas-mvp-timo-bejans-projects.vercel.app](https://opas-mvp-timo-bejans-projects.vercel.app) |

## Prerequisites

- Node.js 22.x
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

Copy the single environment template and set `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, and a separate 32-byte `CRON_SECRET`; the cleanup sidecar requires the cron secret to enforce physical retention. Keep `OPAS_SITE_URL` aligned with the public port; the template already uses `http://localhost:3000`. The assistant needs the three non-secret generation endpoint, model, and retention-disclosure fields and, when required, `OPAS_GENERATION_API_KEY`. It also needs the six strict `OPAS_ANSWER_*` concurrency, rolling-budget, token-price, input-limit, and lease settings shown in the template. Prices are integer microdollars per one million provider-reported tokens; copy the selected provider's current prices rather than guessing them. Cross-provider fallback is disabled by default. Enabling it requires the complete `OPAS_GENERATION_FALLBACK_*` provider contract, both fallback token prices, an opposite provider, and a lease of at least 65 seconds; the browser disclosure names both vendors and models. Without a complete valid generation and admission contract, `/api/answers` returns unavailable while articles and search keep working. Answer analytics default to 30 days and can be shortened or disabled; explicit handoff contact/context has its own 30-day default. Configure support handoff with either `cloudflare-rest-email` or a fixed HTTPS `webhook`; leaving `OPAS_HANDOFF_PROVIDER` blank keeps the form fail-closed without affecting answers. Embedding provider settings remain optional: answers use lexical published-evidence retrieval until a matching embedding generation becomes active.

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

Cloudflare Workers and D1 are the primary OPAS production target. The checked-in release target uses `@opennextjs/cloudflare` and is pinned to the DevPlant account, the `opas-mvp` Worker and D1 database, and the `demo.opas.dev` custom domain. Its workers.dev endpoint remains enabled as a fallback. A fork can set its own explicit account ID and matching `opas-*` names for a workers.dev deployment. Copy `.env.example` to the gitignored `.env`, set the administrator credentials and verified `OPAS_HANDOFF_TO_EMAIL` destination, then run:

```sh
pnpm exec wrangler login
pnpm cf:bootstrap
```

Before activating answers, create the checked-in `opas-answers` AI Gateway in the same Cloudflare account. The bootstrap validates the scoped names, account, answer variables, and optional topic-policy syntax; it creates or finds the exact D1 database, applies migrations, inserts missing demo records, deploys with encrypted Worker secrets, and runs the HTTP smoke suite. Use `pnpm cf:deploy` for subsequent application-only releases.

See [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md) for configuration, migration, verification, and rollback details.

## Vercel quickstart

Vercel and Neon are a live portability target, not OPAS production. “Production” in the commands below is only Vercel's environment name; promotion changes the Vercel project alias and does not move Cloudflare traffic or attach an OPAS domain.

Create one Neon branch, copy `.env.example` to `.env`, and put its direct connection string and real administrator values there. Link the checkout to Vercel and configure the Vercel Production-environment variables listed in [docs/deploy-vercel.md](docs/deploy-vercel.md). Then pin the project to Node 22, build before migrating, prepare Neon transactionally, and upload the staged artifact:

```sh
vercel link
vercel pull --environment=production --yes
vercel project update opas-mvp --framework nextjs --node-version 22.x --yes
pnpm vercel:build https://opas-mvp-timo-bejans-projects.vercel.app
pnpm neon:prepare
pnpm vercel:deploy https://opas-mvp-timo-bejans-projects.vercel.app
```

Smoke-test the staged deployment and complete the browser MDX, client-navigation, console, and runtime-theme checks before promoting it. `vercel.json` keeps the function in `fra1`, close to the documented Neon region. The complete environment, verification, promotion, and rollback procedure is in [docs/deploy-vercel.md](docs/deploy-vercel.md).

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

- v0.1: shipped across Docker/Postgres, primary Cloudflare/D1 production, and the live Vercel/Neon compatibility target with runtime theming, MDX authoring, search, discovery surfaces, and privacy-light analytics.
- v0.2 — OPAS Answers (current development line): Markdown/GitBook migration, Markdown-native WYSIWYG authoring, published-source RAG with citations and abstention, native and embeddable chat, support handoff, answer evaluation, content-gap analytics, and read-only MCP. Production rollout and design-partner evaluation remain release gates.
- Next: revisions, signed previews, multiple administrators, review roles, GitHub sync, permission-scoped private knowledge, and demand-backed AI-agent traffic analytics.
- Commercial edition: managed AI usage, organization connectors, SAML and SCIM, audit logs, advanced permissions, multi-brand operation, and white-label controls in the isolated `/ee` directory.

Ticketing/inbox, live-agent chat, autonomous support actions, arbitrary custom-block editing, real-time collaboration, multi-language authoring, and multi-tenancy remain outside the v0.2 scope.

## License

The community code is licensed under [AGPL-3.0-only](LICENSE). Future commercially licensed features belong only in [`/ee`](ee/README.md); community core code must never import from that directory.

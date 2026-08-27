# Contributing to OPAS

OPAS accepts focused fixes and features that fit the current plan in [progress.md](progress.md). Discuss framework changes, major refactors, new deployment architecture, or changes to the community/commercial boundary before implementing them.

## Set up the repository

Requirements are Node.js 22 or newer, pnpm 10.13.1 through Corepack, and a running Docker engine for the Postgres integration suite.

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

Set `ADMIN_PASSWORD` to at least eight characters and `ADMIN_SESSION_SECRET` to at least 32 bytes. The Docker quickstart in [README.md](README.md) is the shortest way to run the complete application locally.

For a development server backed by the Postgres URL in `.env`:

```sh
docker compose up -d --wait db
node --env-file=.env --import tsx scripts/prepare-postgres.ts
pnpm dev
```

## Make a change

- Keep the change as small as the behavior requires; do not add speculative abstractions or compatibility shims.
- Add or update a failing check before fixing a bug when practical.
- Start every code file with two `ABOUTME:` comment lines that state what the file does.
- Keep database access behind the shared repository layer. Application code must work with both the Postgres and SQLite/D1 dialects.
- Keep the AGPL community core independent of `/ee`; core code must never import commercial-edition code.
- Do not commit `.env`, credentials, generated build output, or deployment secrets.
- If a change completes an item in [progress.md](progress.md), record the verification in the same change.

## Verify the result

Keep Docker running, then execute the complete local gate:

```sh
pnpm test
pnpm build
pnpm cf:build
```

For deployment-related work, also run the read-only smoke suite against the affected target:

```sh
pnpm smoke https://your-opas-origin.example
```

Include the commands and results in the pull request. Do not disable checks or skip a failing dialect.

## Licensing

Contributions to the community code are accepted under the repository's [AGPL-3.0-only license](LICENSE). Only place work in `/ee` when its separate commercial licensing has been established for that work.

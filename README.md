# OPAS

Open-source help center for the AI era. **Theme it at runtime. Deploy it anywhere. Own your content and your AI surfaces.**

- **Runtime theming** — brand colors, fonts, radius, and logo live as JSON in the database and apply as CSS variables with zero rebuilds.
- **Deploy anywhere** — the same codebase runs via `docker compose up` (Postgres), on Vercel (Neon), and on Cloudflare Workers (D1).
- **Agent-readable by default** — `/llms.txt`, per-article `.md` endpoints, sitemap, and JSON-LD out of the box.

**Status: pre-MVP, under active development.** Plan and live progress: [progress.md](progress.md). Product research: [docs/brief.md](docs/brief.md).

## Stack

Next.js (App Router, Node runtime) · Drizzle ORM (Postgres + SQLite/D1 dialects) · `@fumadocs/mdx-remote` · Tailwind v4 runtime theme tokens · Orama search

| Target | Database |
|---|---|
| Docker (`docker compose up`) | Postgres (bundled) |
| Vercel | Neon Postgres |
| Cloudflare Workers (`@opennextjs/cloudflare`) | D1 |

## License

AGPL-3.0. Enterprise features will live in an isolated `/ee` directory under a commercial license (none exist yet).

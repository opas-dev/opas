# OPAS MVP (v0.1) — Plan & Progress

**Mission:** ship OPAS v0.1 — an open-source, runtime-themable, deploy-anywhere help center — per [docs/brief.md](docs/brief.md), verified on all three targets: Docker (Postgres), Vercel (Neon), Cloudflare Workers (D1).

## Protocol
1. Work phases top to bottom; within a phase, reorder freely when it helps.
2. An item is done only when its **Verify** line has actually been run and passed. Then: check the box, commit (progress.md update in the same commit), push, add a Log entry.
3. Non-obvious choices go in **Decisions**. Missing credentials or external accounts go in **Blockers**: record them, park only the dependent items, keep building everything else.
4. Never stop while any unchecked item is unblocked. Re-check Blockers at every phase boundary — `.env` may have gained credentials since.
5. Keep the Status counters current.

## Status
- **Current phase:** 0
- **Done:** 0 / 40

## Blockers
| # | Blocked | Needs | Parked items |
|---|---|---|---|
| B2 | Neon database | `NEON_DATABASE_URL` in `.env` | 0.6, 7.4 |

Resolved: B1 (Vercel) — CLI authenticated locally as `timobejan`, 2026-08-27.

## Decisions
| Date | Decision | Why |
|---|---|---|
| 2026-08-27 | D1 on Cloudflare, Neon on Vercel, Postgres in Docker; one adapter layer supports all three | Timo's call; supersedes the brief's "don't hard-depend on D1" |
| 2026-08-27 | Keyword search via Orama (in-process) | Portable across all targets — Postgres FTS does not exist on D1 |
| 2026-08-27 | Branding is OPAS everywhere; AGPL-3.0 core with isolated `/ee` later | Timo's call |

## Phase 0 — Three-target runtime spike (de-risk first)
- [ ] 0.1 Scaffold Next.js (latest 16.x) App Router + TypeScript + Tailwind v4 + pnpm; pin `export const runtime = 'nodejs'` on all dynamic routes. **Verify:** `pnpm build` clean; `pnpm dev` serves.
- [ ] 0.2 Runtime MDX: a page that compiles MDX read at request time (from a file or DB, not imported) with `@fumadocs/mdx-remote` — never `mdx-bundler`. **Verify:** changing the source shows new output with no rebuild.
- [ ] 0.3 Minimal DB read: Drizzle + Postgres (docker) storing one article row; the page renders MDX from the DB. **Verify:** update the row via psql → refresh shows the change.
- [ ] 0.4 Docker target: Dockerfile (standalone output) + `docker-compose.yml` (app + Postgres), single `.env`. **Verify:** `docker compose up` from a clean checkout serves the MDX page.
- [ ] 0.5 Cloudflare target: `@opennextjs/cloudflare` (NOT `@cloudflare/next-on-pages`); create D1 database `opas-mvp` on the DevPlant account; Drizzle D1 dialect path for the same article read. **Verify:** deployed workers.dev URL renders D1-stored MDX; confirm MDX eval works on workerd and note CSP implications in `docs/notes.md`.
- [ ] 0.6 Vercel target (B2): deploy with the Neon serverless driver; reproduce/resolve the `@fumadocs/mdx-remote` "Connection closed" issue (Fumadocs discussion #1623). **Verify:** production URL renders Neon-stored MDX.
- [ ] 0.7 Write `docs/notes.md` with spike findings; adjust this plan if a target fails irrecoverably (brief fallback: CF drops to static-export-only — document honestly, don't ship a broken path).

## Phase 1 — Data layer & adapters
- [ ] 1.1 Schema in both dialects (shared table/column names): workspaces, categories, articles (slug, title, mdx, draft/published, timestamps), themes (JSON), article_feedback, article_views, search_misses.
- [ ] 1.2 Storage adapter: one `db` module resolving the driver per deployment (node-postgres for Docker, Neon serverless driver for Vercel, D1 binding for Workers); repository functions are dialect-agnostic.
- [ ] 1.3 Migrations per dialect (drizzle-kit) + seed script: demo workspace, categories, articles, default theme.
- [ ] 1.4 Repository integration tests running against both Postgres (docker) and SQLite/D1 (miniflare or local SQLite). **Verify:** the same suite is green on both dialects.

## Phase 2 — Theme engine (Priority 1)
- [ ] 2.1 JSON theme schema (zod): OKLCH colors, radius, font stacks, logo URL, light+dark variants. Generous token namespace — document the hard limit: only token *values* change at runtime, no new utilities without a rebuild.
- [ ] 2.2 Tailwind v4 `@theme inline` semantic tokens mapped to CSS variables; all UI uses semantic tokens only.
- [ ] 2.3 SSR-injected `<style>` block redefining the variables from the DB theme row, per request; light/dark.
- [ ] 2.4 3–4 preset themes; admin page to switch and edit theme JSON.
- [ ] 2.5 **Verify (headline demo):** change theme in admin → public pages re-skin on reload with zero rebuild; before/after screenshots in `docs/`.

## Phase 3 — Content model & rendering
- [ ] 3.1 Admin auth: single admin from env credentials, session cookie, middleware-protected `/admin`.
- [ ] 3.2 Admin CRUD: categories + articles, MDX editor with live preview, draft/published.
- [ ] 3.3 Sanitize DB-stored MDX before compiling (no imports/exports, component allowlist); document the threat model in `docs/notes.md`.
- [ ] 3.4 Public UI: home (categories), category page, article page; shallow IA (2 levels max), breadcrumbs, last-updated.
- [ ] 3.5 **Verify:** author → publish → public page, end-to-end on the Docker target.

## Phase 4 — Search
- [ ] 4.1 Orama index over published articles, rebuilt on publish, served via a route handler.
- [ ] 4.2 As-you-type search UI with typo tolerance.
- [ ] 4.3 Zero-result queries recorded to search_misses. **Verify:** search works on Docker and CF targets; a miss gets logged.

## Phase 5 — SEO & AI surfaces
- [ ] 5.1 SSR metadata, canonical URLs, `sitemap.xml`.
- [ ] 5.2 `Article` JSON-LD (datePublished/dateModified/author/publisher) on every article; `FAQPage` JSON-LD on articles flagged Q&A-shaped.
- [ ] 5.3 `/llms.txt` + `/llms-full.txt` generated from the DB.
- [ ] 5.4 Per-article `.md` endpoint plus `Link` / `X-Llms-Txt` headers. **Verify:** curl checks for 5.1–5.4 against a deployed target.

## Phase 6 — Feedback & analytics
- [ ] 6.1 "Was this helpful?" widget (yes/no + optional comment) → article_feedback.
- [ ] 6.2 View counting, privacy-light (no cookies).
- [ ] 6.3 Admin dashboard: views, helpful %, top zero-result queries. **Verify:** data flows end-to-end.

## Phase 7 — Deploy hardening (Priority 2)
- [ ] 7.1 `docker compose up` from a clean clone: single `.env`, healthchecks, auto-migrate + seed on first boot. **Verify:** fresh clone → compose up → working seeded help center.
- [ ] 7.2 CF Workers deploy script + docs (creates D1, migrates, seeds, deploys). **Verify:** clean deploy to workers.dev. May bind `mvp.opas.dev`; NEVER touch `opas.dev` root or `www`.
- [ ] 7.3 Smoke-test script (curl of key routes incl. search, llms.txt, `.md`) runnable against any base URL.
- [ ] 7.4 Vercel + Neon verified deploy + docs (B2).
- [ ] 7.5 README quickstarts for all three targets, with live URLs.

## Phase 8 — Release
- [ ] 8.1 `/ee` directory placeholder with commercial-license README; verify core has zero imports from `/ee`.
- [ ] 8.2 CONTRIBUTING.md + short public roadmap section in README.
- [ ] 8.3 CI on GitHub Actions: lint, typecheck, both-dialect tests.
- [ ] 8.4 Tag `v0.1.0` + GitHub release with changelog. **Verify:** CI green on the tag; every Definition-of-done box below checked.

## Definition of done (v0.1)
- [ ] `docker compose up` on a clean machine yields a seeded, themed, searchable help center.
- [ ] Deployed and smoke-tested on Cloudflare Workers with D1 — live URL in README.
- [ ] Deployed and smoke-tested on Vercel with Neon — live URL in README (parked on B2 until the Neon connection string lands).
- [ ] A theme change via admin re-skins the site with zero rebuild, on every target.
- [ ] `llms.txt`, `llms-full.txt`, per-article `.md`, sitemap, and JSON-LD all pass the smoke-test script.
- [ ] Feedback widget and view analytics work.
- [ ] Non-goals honored — NOT built: ticketing/inbox, live chat, AI/RAG answers, multi-language, WYSIWYG, plugin system, multi-tenancy, vector search.

## Log
Append-only, newest first: `YYYY-MM-DD — item(s) — what happened — verification result — commit`.

- 2026-08-27 — setup — repo created, plan authored, landing page live at opas.dev; no app code yet — n/a — initial commit

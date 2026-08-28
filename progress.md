# OPAS MVP (v0.1) — Plan & Progress

**Mission:** ship OPAS v0.1 — an open-source, runtime-themable, deploy-anywhere help center — per [docs/brief.md](docs/brief.md), verified on all three targets: Docker (Postgres), Vercel (Neon), Cloudflare Workers (D1).

## Protocol
1. Work phases top to bottom; within a phase, reorder freely when it helps.
2. An item is done only when its **Verify** line has actually been run and passed. Then: check the box, commit (progress.md update in the same commit), push, add a Log entry.
3. Non-obvious choices go in **Decisions**. Missing credentials or external accounts go in **Blockers**: record them, park only the dependent items, keep building everything else.
4. Never stop while any unchecked item is unblocked. Re-check Blockers at every phase boundary — `.env` may have gained credentials since.
5. Keep the Status counters current.

## Status
- **Current phase:** Complete
- **Done:** 40 / 40

## Blockers
None.

Resolved: B1 (Vercel) — CLI authenticated locally as `timobejan`, 2026-08-27. B2 (Neon) — `NEON_DATABASE_URL` in `.env`, connection verified (Postgres 18.6, eu-central-1), 2026-08-27. B3 (rollout authority) — Timo authorized the complete rollout on 2026-08-28 and clarified that Cloudflare, not Vercel, is production.

## Decisions
| Date | Decision | Why |
|---|---|---|
| 2026-08-27 | D1 on Cloudflare, Neon on Vercel, Postgres in Docker; one adapter layer supports all three | Timo's call; supersedes the brief's "don't hard-depend on D1" |
| 2026-08-27 | Keyword search via Orama (in-process) | Portable across all targets — Postgres FTS does not exist on D1 |
| 2026-08-27 | Branding is OPAS everywhere; AGPL-3.0 core with isolated `/ee` later | Timo's call |
| 2026-08-27 | Default design register is a restrained, light product UI with crimson reserved for primary action and active state | The public help center and admin are task surfaces; this keeps long-form reading clear while runtime presets demonstrate brand range |
| 2026-08-27 | Cloudflare compiles DB-backed MDX in workerd and executes the function body in the browser | Workerd forbids request-time dynamic evaluation; this preserves live D1 content, makes the required `unsafe-eval` script policy explicit, and requires item 3.3 to sanitize before compiling |
| 2026-08-27 | Runtime MDX uses Fumadocs' minimal preset with its unused documentation-plugin import aliased out | Avoids the Shiki initialization failure reported on Vercel and reduced the spike Worker from 3.126 MiB to about 1.27 MiB compressed |
| 2026-08-27 | Repository behavior is verified with Testcontainers PostgreSQL and better-sqlite3, then checked against Wrangler's local D1 runtime | The same contract covers both dialects while Wrangler separately proves the checked-in D1 migrations and deployment seed execute on workerd's database runtime |
| 2026-08-27 | The Cloudflare D1 database runs in Eastern Europe and the runtime spike stays on its workers.dev hostname | Keeps OPAS data near the initial operator region and avoids touching the protected `opas.dev` root, `www`, or DNS during the spike |
| 2026-08-27 | Runtime themes use a fixed namespace of 23 semantic colors, five radii, two font stacks, and one logo URL | A generous closed set supports distinct presets safely; runtime values can change without rebuilding, while arbitrary declarations, token names, and layout overrides stay out of the MVP |
| 2026-08-27 | The active theme is loaded once per request and injected by the root server layout, with the OPAS preset as the fail-closed fallback | Reloads observe database changes immediately without cross-request staleness, while missing or invalid rows cannot inject CSS or break rendering |
| 2026-08-27 | Admin authentication ships before the writable theme action even though it is numbered in Phase 3 | Server Actions are directly reachable POST endpoints, so the editor must never exist with only UI-level route hiding |
| 2026-08-27 | The single administrator uses an eight-hour signed stateless session scoped to `/admin` | The same secure boundary works without another table on Postgres, Neon, and D1; production cookies are always Secure and therefore require HTTPS |
| 2026-08-27 | Runtime articles use a strict Markdown subset, an empty component allowlist, and a first-H1-equals-title contract | The stored body remains useful Markdown while imports, expressions, JSX, metadata drift, and duplicate public headings cannot cross the compilation boundary |
| 2026-08-27 | Content mutations stay in authenticated Server Actions while live preview uses an authenticated abortable POST route | Save and delete keep authoritative workspace checks; previews do not queue behind each other or delay a mutation |
| 2026-08-27 | Category deletion is an atomic delete-if-empty repository operation | The UI's helpful article-count message cannot become a cascade-delete race under concurrent writes |
| 2026-08-27 | Search indexes the authoritative published database snapshot and reuses it only while a deterministic content signature is unchanged; anonymous misses use 1,024 daily sample slots with opportunistic cleanup beyond 30 days | Every isolate stays correct after publish, edit, unpublish, or restart; the cache remains optional, and public analytics writes and stored row count are bounded |
| 2026-08-28 | One request-time publication projection and the explicit `OPAS_SITE_URL` origin drive HTML metadata, sitemap, JSON-LD, llms documents, and per-article Markdown | Every discovery surface applies the same workspace, category, slug, and published-state boundary, while canonical URLs remain exact on Docker, Workers, and the future Vercel target |
| 2026-08-28 | Article readership and helpfulness use bounded 30-day samples with no cookies or persisted request metadata | Fixed daily slots bound stored rows, ephemeral admission gates bound per-process database attempts, Cloudflare adds a trusted per-requester window, and the report remains honest about collisions and opportunistic physical cleanup |
| 2026-08-28 | Deployment seeds insert only records that are missing | First boot remains automatic while an administrator's edits survive container restarts and repeat D1 or Neon preparation |
| 2026-08-28 | Cloudflare bootstrap permits the exact `demo.opas.dev` Custom Domain only for the maintained DevPlant `opas-mvp` Worker, explicitly keeps workers.dev enabled, and rejects every other custom route | The app gets a stable canonical production hostname without exposing `opas.dev`, `www`, `opas-landing`, or unrelated shared-account resources |
| 2026-08-28 | Cloudflare Workers/D1 is the primary production deployment; Vercel/Neon is a live compatibility target using Vercel's `Production` environment | Vercel's environment label must not imply that OPAS traffic, domains, or production ownership moved away from Cloudflare |

## Phase 0 — Three-target runtime spike (de-risk first)
- [x] 0.1 Scaffold Next.js (latest 16.x) App Router + TypeScript + Tailwind v4 + pnpm; pin `export const runtime = 'nodejs'` on all dynamic routes. **Verify:** `pnpm build` clean; `pnpm dev` serves.
- [x] 0.2 Runtime MDX: a page that compiles MDX read at request time (from a file or DB, not imported) with `@fumadocs/mdx-remote` — never `mdx-bundler`. **Verify:** changing the source shows new output with no rebuild.
- [x] 0.3 Minimal DB read: Drizzle + Postgres (docker) storing one article row; the page renders MDX from the DB. **Verify:** update the row via psql → refresh shows the change.
- [x] 0.4 Docker target: Dockerfile (standalone output) + `docker-compose.yml` (app + Postgres), single `.env`. **Verify:** `docker compose up` from a clean checkout serves the MDX page.
- [x] 0.5 Cloudflare target: `@opennextjs/cloudflare` (NOT `@cloudflare/next-on-pages`); create D1 database `opas-mvp` on the DevPlant account; Drizzle D1 dialect path for the same article read. **Verify:** deployed workers.dev URL renders D1-stored MDX; confirm the workerd-compatible path compiles validated MDX in the Worker and executes the resulting render function in the browser, and note CSP implications in `docs/notes.md`.
- [x] 0.6 Vercel target: deploy with the Neon serverless driver; reproduce/resolve the `@fumadocs/mdx-remote` "Connection closed" issue (Fumadocs discussion #1623). **Verify:** the live Vercel Production-environment compatibility URL renders Neon-stored MDX.
- [x] 0.7 Write `docs/notes.md` with spike findings; adjust this plan if a target fails irrecoverably (brief fallback: CF drops to static-export-only — document honestly, don't ship a broken path).

## Phase 1 — Data layer & adapters
- [x] 1.1 Schema in both dialects (shared table/column names): workspaces, categories, articles (slug, title, mdx, draft/published, timestamps), themes (JSON), article_feedback, article_views, search_misses.
- [x] 1.2 Storage adapter: one `db` module resolving the driver per deployment (node-postgres for Docker, Neon serverless driver for Vercel, D1 binding for Workers); repository functions are dialect-agnostic.
- [x] 1.3 Migrations per dialect (drizzle-kit) + seed script: demo workspace, categories, articles, default theme.
- [x] 1.4 Repository integration tests running against both Postgres (docker) and SQLite/D1 (miniflare or local SQLite). **Verify:** the same suite is green on both dialects.

## Phase 2 — Theme engine (Priority 1)
- [x] 2.1 JSON theme schema (zod): OKLCH colors, radius, font stacks, logo URL, light+dark variants. Generous token namespace — document the hard limit: only token *values* change at runtime, no new utilities without a rebuild.
- [x] 2.2 Tailwind v4 `@theme inline` semantic tokens mapped to CSS variables; product styling uses semantic tokens, with validated preset-preview swatches and the static app icon as narrow fixed-color exceptions.
- [x] 2.3 SSR-injected `<style>` block redefining the variables from the DB theme row, per request; light/dark.
- [x] 2.4 3–4 preset themes; admin page to switch and edit theme JSON.
- [x] 2.5 **Verify (headline demo):** change theme in admin → public pages re-skin on reload with zero rebuild; before/after screenshots in `docs/`.

## Phase 3 — Content model & rendering
- [x] 3.1 Admin auth: single admin from env credentials, session cookie, middleware-protected `/admin`.
- [x] 3.2 Admin CRUD: categories + articles, MDX editor with live preview, draft/published.
- [x] 3.3 Sanitize DB-stored MDX before compiling (no imports/exports, component allowlist); document the threat model in `docs/notes.md`.
- [x] 3.4 Public UI: home (categories), category page, article page; shallow IA (2 levels max), breadcrumbs, last-updated.
- [x] 3.5 **Verify:** author → publish → public page, end-to-end on the Docker target.

## Phase 4 — Search
- [x] 4.1 Orama index over published articles, rebuilt on publish, served via a route handler.
- [x] 4.2 As-you-type search UI with typo tolerance.
- [x] 4.3 Zero-result queries recorded to search_misses. **Verify:** search works on Docker and CF targets; a miss gets logged.

## Phase 5 — SEO & AI surfaces
- [x] 5.1 SSR metadata, canonical URLs, `sitemap.xml`.
- [x] 5.2 `Article` JSON-LD (datePublished/dateModified/author/publisher) on every article; `FAQPage` JSON-LD on articles flagged Q&A-shaped.
- [x] 5.3 `/llms.txt` + `/llms-full.txt` generated from the DB.
- [x] 5.4 Per-article `.md` endpoint plus `Link` / `X-Llms-Txt` headers. **Verify:** curl checks for 5.1–5.4 against a deployed target.

## Phase 6 — Feedback & analytics
- [x] 6.1 "Was this helpful?" widget (yes/no + optional comment) → article_feedback.
- [x] 6.2 View counting, privacy-light (no cookies).
- [x] 6.3 Admin dashboard: views, helpful %, top zero-result queries. **Verify:** data flows end-to-end.

## Phase 7 — Deploy hardening (Priority 2)
- [x] 7.1 `docker compose up` from a clean clone: single `.env`, healthchecks, auto-migrate + seed on first boot. **Verify:** fresh clone → compose up → working seeded help center.
- [x] 7.2 CF Workers deploy script + docs (creates D1, migrates, seeds, deploys). **Verify:** clean deploy to workers.dev. The maintained Worker may additionally bind `demo.opas.dev`; NEVER touch `opas.dev` root or `www`.
- [x] 7.3 Smoke-test script (curl of key routes incl. search, `llms.txt`, `.md`) runnable against any base URL.
- [x] 7.4 Vercel + Neon verified deploy + docs.
- [x] 7.5 README quickstarts for all three targets, with live URLs.

## Phase 8 — Release
- [x] 8.1 `/ee` directory placeholder with commercial-license README; verify core has zero imports from `/ee`.
- [x] 8.2 CONTRIBUTING.md + short public roadmap section in README.
- [x] 8.3 CI on GitHub Actions: lint, typecheck, both-dialect tests.
- [x] 8.4 Tag `v0.1.0` + GitHub release with changelog. **Verify:** CI green on the tag; every Definition-of-done box below checked.

## Definition of done (v0.1)
- [x] `docker compose up` on a clean machine yields a seeded, themed, searchable help center.
- [x] Deployed and smoke-tested on Cloudflare Workers with D1 — live URL in README.
- [x] Deployed and smoke-tested on Vercel with Neon — live URL in README.
- [x] A theme change via admin re-skins the site with zero rebuild, on every target.
- [x] `llms.txt`, `llms-full.txt`, per-article `.md`, sitemap, and JSON-LD all pass the smoke-test script.
- [x] Feedback widget and view analytics work.
- [x] Non-goals honored — NOT built: ticketing/inbox, live chat, AI/RAG answers, multi-language, WYSIWYG, plugin system, multi-tenancy, vector search.

## Log
Append-only, newest first: `YYYY-MM-DD — item(s) — what happened — verification result — commit`.

- 2026-08-28 — production domain rollout — bound the maintained `opas-mvp` Worker to `demo.opas.dev`, made that Custom Domain authoritative for canonical and discovery URLs, retained workers.dev as a non-canonical fallback, and preserved the protected apex/`www` landing deployment — Cloudflare created the Custom Domain record and certificate; Worker version `dc03e4da-bd42-4c91-98ef-be64808defa6` passed lint, typecheck, the deployment guard suite, OpenNext build, Wrangler dry-run, the complete D1-backed smoke suite on `demo.opas.dev`, and the workers.dev health check — this commit
- 2026-08-28 — 8.4 — tagged verified checkpoint `34df183` as annotated `v0.1.0` and published the [OPAS v0.1.0 GitHub release](https://github.com/opas-dev/opas/releases/tag/v0.1.0) with the three-target changelog and Cloudflare/D1 identified as primary production — exact tag CI run `33139327166` passed all tests plus Next/OpenNext builds, all seven definition-of-done gates were checked, and final Cloudflare/Vercel live smoke suites passed — this commit
- 2026-08-28 — 0.6–0.7, 7.4–7.5, Vercel definition-of-done gates — created the isolated `opas-mvp` Vercel project and Neon schema, pinned Node 22.x in `fra1`, added a secret-safe reproducible compatibility build, deployed the artifact through Vercel's Production environment, documented Cloudflare/D1 as primary production, and published the stable compatibility URL — Neon preparation converged twice with two migrations and the missing-only seed; the immutable deployment `dpl_D92FbsStyTNb6FATs1ou89GZPvYy` and promoted stable alias passed the complete smoke suite including a temporary FAQ; hydrated home-to-article navigation kept Neon MDX visible, all completed RSC requests returned 200, the console contained no `Connection closed` error, and an authenticated Ocean theme change plus OPAS restore appeared publicly without rebuilding; exact proof analytics/FAQ rows were removed; 65 tests, Next/OpenNext/Vercel builds, actionlint, the core import scan, and final live Cloudflare/Vercel smoke suites passed, while Neon retained the OPAS Default theme and zero analytics rows — this commit
- 2026-08-28 — completion evidence follow-up — aligned the literal workerd and semantic-token wording with the shipped design and expanded the portable smoke suite to validate every Article field plus optional required FAQPage structured data — shell validation, the complete test suite, live Cloudflare Article/FAQ proof, remote cleanup, and CI passed — this commit
- 2026-08-28 — 7.4 preflight — made the Vercel runbook pull current Production settings and require staged plus promoted browser proofs for hydrated MDX, client navigation, clean RSC traffic, and runtime theme change/restore — the exact Neon preparation command migrated and seeded disposable Postgres three times without replacing article/theme edits; the confirmed direct Neon endpoint connected read-only to the expected empty Postgres 18.6 schema, local secrets were restricted to mode 0600, and no runtime code blocker remained — this commit
- 2026-08-28 — 8.3 release follow-up — added version-tag CI runs so the v0.1.0 release gate can be verified on its exact tag — actionlint and the preceding complete `main` CI run passed — this commit
- 2026-08-28 — 8.1–8.3 — established the empty commercial-edition boundary, added the contribution guide and public three-target quickstarts/roadmap, and added a pinned GitHub Actions gate for the complete test suite plus Next/OpenNext builds — the core import scan, actionlint, 65 tests, Next/OpenNext/Docker builds, and Docker/Cloudflare smoke suites passed — this commit
- 2026-08-28 — 7.1–7.3 — made all deployment seeds preserve administrator edits, required complete Compose configuration, added a guarded create/migrate/seed/deploy Cloudflare workflow, aligned the stored-MDX URL policy with the documented workerd-compatible CSP, and added one portable read-only smoke suite — 65 tests, lint, typecheck, clean-source Docker build/first boot/non-root runtime/smoke, and cross-workspace seed preservation checks passed; an absent disposable `opas-*` Worker/D1 pair completed the bootstrap and smoke suite as version `e25a9167-8e7b-4b8e-9139-c73d7e521939` before both resources were deleted; final live `opas-mvp` version `0583f6b9-3a28-472a-a1a3-bd32d6a479d6` passed the build-first dry run, missing-only D1 seed, CSP headers, full smoke suite, and zero-row analytics check, following the clean browser MDX/CSP proof — this commit
- 2026-08-28 — 6.1–6.3 — added the accessible anonymous helpfulness form, browser view beacon, strict bounded event APIs, salted Cloudflare requester and portable process admission gates, collision-bounded 30-day samples, cross-dialect aggregates, and the authenticated analytics report — 60 tests, lint, typecheck, Next/OpenNext/Docker builds, Docker browser/API/database/admin checks, limiter race tests, and exact cleanup passed; Worker `40d90ba4-f530-423e-88d6-3072f93a1296` rendered workerd MDX, persisted D1 view/feedback/miss samples, displayed them in the authenticated report with no browser errors, rejected invalid and draft events, and retained zero proof rows — this commit
- 2026-08-28 — 5.1–5.4 — added one workspace-safe publication projection for SSR metadata and canonicals, dynamic sitemap, escaped Article and conditional FAQPage JSON-LD, DB-generated llms documents, and rewritten per-article Markdown with discovery and crawler headers — 44 tests, lint, typecheck, Next/OpenNext/Docker builds, and Docker live publish→draft checks passed; Worker `61d7ca6a-e7d7-406e-98ee-17512d4c1831` passed exact-origin curl checks across all surfaces, reflected a D1 FAQ publish and unpublish without rebuilding, rejected drafts and wrong-category Markdown, and retained no canary row — this commit
- 2026-08-27 — 4.1–4.3 — added snapshot-aware Orama indexing over published Markdown, one Unicode query contract, a normalized no-store search route, accessible abortable as-you-type results with one-character typo tolerance, and bounded zero-result analytics — 38 tests, lint, typecheck, Next/OpenNext/Docker builds, Docker draft→publish→edit index refresh, responsive browser checks, and Docker/PostgreSQL retention and miss persistence passed; deployed Worker `251eed75-161e-4528-8cd3-2757d3d8c629` returned the D1 article for `runtme`, kept a one-code-point query out of D1, logged exactly one bounded-slot D1 miss in EEUR/FRA, removed the canary row, and passed the live browser/console check — this commit
- 2026-08-27 — 3.2–3.5 — added cross-dialect category/article CRUD, strict authenticated authoring and abortable live preview, parser-enforced MDX safety, publication-aware public category/article routes, and atomic empty-category deletion — 31 tests passed across auth, validation, MDX, themes, PostgreSQL, and SQLite; Next/OpenNext/Docker builds passed; Docker browser proof rejected executable MDX, kept a draft at a real 404, published and live-edited without rebuilding, verified home/category/article navigation, preserved controlled form state after saves, deleted all proof rows, and invalidated the temporary session — this commit
- 2026-08-27 — 0.5, 2.5, 3.1 live Cloudflare verification — deployed commit `8360567` to the scoped `opas-mvp` Worker and D1 database, exercised the authenticated runtime-theme write path, and rotated the final admin secrets — health, unauthenticated Proxy redirect, authenticated Ocean save, distinct public light/dark values, D1-backed MDX, OPAS restore, clean browser logs, and smoke-session invalidation all passed; current Worker version `d55a1674-c016-48ed-bccb-8684c6dd479a` — this commit
- 2026-08-27 — 2.4–2.5 — added four authenticated preset choices, the strict JSON editor, cross-dialect persistence, runtime logo rendering, and the before/after proof images — the admin switched OPAS Default to Ocean under unchanged build `uqcM6NbnkaX5Q_THJczg8` and PID `81795`; SSR light/dark variables, browser console, full tests, Next build, and OpenNext build passed; the local row was restored — this commit
- 2026-08-27 — 3.1 — added fixed-time env credential checks, signed eight-hour sessions, secure scoped cookies, Next 16 Proxy gating, authoritative page/action guards, and login/logout UI — six auth/Proxy tests, unauthenticated browser redirect, production browser login, lint, typecheck, Next build, and OpenNext build passed — this commit
- 2026-08-27 — 2.2–2.3 — mapped the complete semantic theme namespace through Tailwind, loaded and validated the active row once per request, and SSR-injected light/dark CSS in the root layout — lint, typecheck, theme tests, Next/OpenNext production builds, live Postgres row changes under one unchanged server process, and browser-computed light/dark styles passed — `1e78ae4`
- 2026-08-27 — 2.1 — added the strict Zod theme contract, safe deterministic stylesheet serializer, four complete presets, aligned deployment seeds, and documented the fixed runtime token limit — `pnpm test` passed all theme safety checks and both repository dialect contracts — `2184552`
- 2026-08-27 — 0.5 — created the scoped `opas-mvp` D1 database in EEUR, applied and seeded both migrations, deployed the OpenNext Worker to `opas-mvp.timo-bejan.workers.dev`, and documented workerd/CSP behavior — health and browser-rendered MDX passed; a remote D1 edit appeared on reload without a redeploy, the seed restored it, and Worker version `fd9ac205-1df9-4d57-af03-7868274f4026` remained active — `07b7d02` + this commit
- 2026-08-27 — 1.1–1.4 — aligned all seven tables and constraints across Postgres and SQLite, consolidated runtime driver selection behind one repository, added convergent seeds and data-preserving migrations, and added one cross-dialect contract — `pnpm test`, both no-drift generation checks, a fresh Wrangler local D1 migration/seed/query, `pnpm build`, and `pnpm cf:build` passed — this commit
- 2026-08-27 — 0.4 — added the standalone non-root image, Postgres migration/seed preparation, app and DB healthchecks, and two-service Compose stack — removed the OPAS volume, rebuilt from source, reached healthy state, and curled database-backed MDX plus `/api/health` successfully — this commit
- 2026-08-27 — 0.3 — added the Postgres Drizzle schema, generated migration, idempotent demo seed, and database-backed runtime MDX read — updated the seeded row through `psql` and confirmed the next production-server response changed without rebuilding; build, lint, and typecheck passed — this commit
- 2026-08-27 — 0.2 — added request-time compilation through `@fumadocs/mdx-remote` 1.5.1 on a dynamic Node route — changed the source while `pnpm dev` stayed running and confirmed the next response changed without a rebuild; build, lint, and typecheck passed — this commit
- 2026-08-27 — 0.1 — scaffolded Next.js 16.3.3, React 19.2.8, TypeScript, Tailwind v4, standalone output, Node runtime exports, and initial product/design context — `pnpm build`, live `pnpm dev` request, lint, and typecheck passed — this commit
- 2026-08-27 — setup — repo created, plan authored, landing page live at opas.dev; no app code yet — n/a — initial commit

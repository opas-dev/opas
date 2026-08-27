# Product Brief: Open-Source Help Center ("OpenHelp") — Market, Architecture, and MVP

## TL;DR
- The "expensive and overrated" pain is real and concentrated in two places: seat-based helpdesk suites that gate the KB behind $55+/agent/mo tiers (Zendesk Suite Team, Intercom/Fin) and stack per-resolution AI fees on top, and standalone KB tools that charge roughly $199-$799/mo per project with sales-gated pricing (Document360, HelpJuice). The white space is a self-hostable, runtime-themable, deploy-anywhere help center with AI/agent-readable docs baked in — no existing OSS project occupies that exact intersection.
- Build it as Next.js 16 App Router pinned to the Node.js runtime (works identically on a self-hosted container, Vercel Node functions, and Cloudflare Workers via `@opennextjs/cloudflare`), with database-backed content compiled at runtime via `@fumadocs/mdx-remote` (bundler-free, no esbuild), Postgres + pgvector as the default store (Drizzle ORM; swappable to libSQL/Turso for the edge story), and runtime theming via Tailwind v4 `@theme inline` CSS variables injected per-tenant from the DB as a `<style>` block. Avoid `mdx-bundler` (esbuild does not run on Workers).
- MVP (v0.1) should be ruthlessly scoped to Priority 1 (runtime theming) and Priority 2 (one-command container deploy + Vercel + Cloudflare): categories/articles CRUD, runtime MDX rendering, a CSS-variable theme engine with a JSON schema, keyword search (Postgres FTS/Orama), SSR + sitemap + FAQPage/Article schema, `llms.txt` + `.md` endpoints, and a "was this helpful" widget. Explicitly NOT in MVP: ticketing/inbox, live chat, AI RAG answers, multi-language, WYSIWYG, plugin marketplace. License AGPL-3.0 with a separate `/ee` enterprise directory (Cal.com/Documenso pattern).

## Key Findings

### 1. The pain is real, and it is bifurcated
Two distinct buyer complaints drive "expensive and overrated":

**Helpdesk suites gate the KB behind mid-tier seats and add AI metering.** Zendesk's knowledge base (Guide) is only in Suite Team at $55/agent/mo and up (Support Team at $19 is ticketing only); Suite Professional is $115/agent/mo; Copilot is a separate $50/agent/mo add-on. AI Agent resolutions bill on a meter: third-party 2026 analyses report roughly $1.50 per automated resolution on committed volume and about $2.00 pay-as-you-go (Zendesk does not publish the rate), and a January 2026 billing change began auto-charging resolution overages with no grace period. The 2025 restructure folded the old standalone Support Professional/Enterprise tiers into Suite, and Suite Enterprise (formerly listed around $169/agent/mo) is now quote-only.

Intercom completed a rebrand to **Fin** in May 2026, and on June 15, 2026 Salesforce signed a definitive agreement to acquire Fin (formerly Intercom, 30,000+ customers) for approximately $3.6 billion, expected to close in Q4 of Salesforce's fiscal 2027. Seat plans are $29 (Essential) / $85 (Advanced) / $132 (Expert) per seat/mo on annual billing, plus $0.99 per Fin "outcome" with a 50-outcome monthly minimum. A 10-seat team with moderate AI volume lands around $2,800-$3,100/mo all-in (one competitor estimate puts 10 agents + 2,000 outcomes at ~$2,830/mo). The recurring review-site complaint is unpredictable AI billing and basics (multilingual KB, AI, analytics) locked behind higher tiers.

**Standalone KB tools are flat but expensive and increasingly sales-gated.** Document360 discontinued its free tier for new signups in November 2024 (existing accounts grandfathered) and moved to quote-only pricing. Historical list pricing was Professional $149 / Business $299 / Enterprise $599 per project per month; 2026 quotes typically land 30-40% higher (Professional ~$199-$249, Business ~$399-$499, Enterprise ~$799 and up), with multilingual and SSO/SCIM gated at the top. HelpJuice starts at $249/mo for 30 users. KnowledgeOwl runs $79 (Flex) to $999/mo (unlimited + SSO). HelpDocs is the cheap outlier at $55/mo flat (1 KB, 5 authors) but caps at 3 KBs / $219/mo and has no AI. Developer-docs platforms gate custom CSS/JS and white-labeling behind Enterprise and lock content into proprietary blocks: Mintlify Pro ~$250-$300/mo per project (custom CSS/JS and white-label are Enterprise-only), ReadMe ~$300/mo (Pro), GitBook ~$79/mo + $15/user.

The overrated angle is documented directly: buyers report paying monthly SaaS fees for "an empty shell" — a branded portal that still requires all the content work, with painful vendor lock-in on export.

### 2. OSS competition exists but nobody owns the exact intersection
The space is crowded at the edges but empty in the center. Two clusters:

**Docs-as-code frameworks (developer-owned, git/MDX, build-time):**

| Project | License | Stack | Theming | Runtime content / authoring | Gap for this use case |
|---|---|---|---|---|---|
| Docusaurus 3.x | MIT | React (Meta), SSG | Swizzling (eject/wrap components) | No — git + MDX, rebuild to publish | No WYSIWYG, no DB content, no deflection/feedback |
| Nextra v4 | MIT | Next.js App Router | Opinionated theme, CSS vars | No — file-based MDX | Less composable than Fumadocs |
| Fumadocs 16.x | MIT | Next.js App Router (also Waku/RR/Tanstack) | CSS variables (`--fd-*`), shadcn-inspired, most composable | Partial — `@fumadocs/mdx-remote` supports DB/CMS at runtime | Framework, not a product; no authoring UI/analytics |
| Starlight | MIT | Astro, SSG | Component overrides + palette vars | No — file-based | Astro stack; overrides less flexible than swizzling |

All are excellent for developer docs but require git + MDX + a dev environment to edit — no WYSIWYG, no runtime content by default, no non-technical authoring, no built-in feedback/analytics/deflection.

**Wiki/KB/helpdesk apps (DB-backed, WYSIWYG, self-hosted):**

| Project | License | Stack | Notes / shortfall |
|---|---|---|---|
| BookStack | MIT | PHP/Laravel (15k+ stars) | Simple book/chapter/page; not runtime-themable; PHP stack |
| Outline | **BSL 1.1 (source-available, NOT OSI open source)** | Node/React | Notion-like; license disqualifies it for OSI-open compliance |
| Wiki.js | AGPL-3.0 | Node | Git-backed option; v3 rewrite in progress |
| Docmost | AGPL-3.0 | Node | Notion-like, launched 2024; young, few integrations |
| phpMyFAQ 4.2 | GPL | PHP 8.3+ | FAQ-focused; v4.2 added a theme manager + translation layer |
| FreeScout KB module | AGPL-3.0 (paid module) | PHP/Laravel | KB is an add-on module on an email inbox |
| Chatwoot | MIT core + separately-licensed `/enterprise` dir | Rails/Vue | Help center + Captain AI; **no new institutional funding announced since 2022 + founder leadership changes = maintenance-risk flag** |

**The gap:** none combine (a) a modern Next.js/React stack, (b) runtime (no-rebuild) theming via configs, (c) DB-backed content with non-technical authoring, (d) deploy-anywhere (container + Vercel + Cloudflare), and (e) AI-era agent-readable docs (llms.txt/MCP/markdown endpoints) as first-class. Docs frameworks have the stack and theming but not the runtime/authoring/deflection story; wiki apps have authoring but sit on PHP/Rails, are rebuild-free but not runtime-themable, and lack the AI-native surfaces. That intersection is the wedge. The space is crowded, but not at the center — this is a real, defensible position rather than a me-too.

### 3. What defines a good help center (evidence-based)
- **Information architecture:** shallow taxonomy (categories/collections → articles), 2 levels max for public help centers; deep nesting hurts findability.
- **Search:** typo tolerance and instant/as-you-type are table stakes. Keyword (Postgres FTS, Orama, Meilisearch, Typesense) covers most queries; hybrid (keyword + vector) is the 2026 bar. Track failed/zero-result searches as a content-gap signal.
- **Authoring:** MDX is the power-user sweet spot (Markdown + components); a WYSIWYG/rich-text layer is needed for non-technical authors. Real-time preview expected.
- **SEO:** SSR/SSG, sitemaps, canonical URLs, hreflang for i18n, and structured data. Google retired the FAQ rich *result* (rolled out through 2023-2026), but `FAQPage` and `Article` remain valid Schema.org types and are now valued for AI-answer extraction (ChatGPT/Perplexity/AI Overviews cite structured Q&A). Keep them on genuinely Q&A-shaped support content; add `Article` with `datePublished`/`dateModified`/author/publisher.
- **i18n:** per-language content variants, RTL support, language switcher, hreflang.
- **Accessibility:** WCAG 2.2 AA — semantic headings, focus management, contrast.
- **Performance:** Core Web Vitals; static-first rendering wins (Docusaurus/Starlight are the speed benchmarks; GitBook is the slow outlier).
- **Deflection loop:** "was this helpful" feedback widget, analytics on failed searches, content-freshness workflow (last-updated, stale flags), versioning, private/permissioned KBs, and an embeddable widget for in-app help.

### 4. AI-era requirements (2025-2026) — now table stakes
Mintlify has redefined the baseline: it auto-generates `/llms.txt` and `/llms-full.txt`, serves every page as Markdown (append `.md`, or via HTTP content negotiation), hosts an MCP server at `/mcp`, and advertises these via `Link` and `X-Llms-Txt` HTTP headers plus `/.well-known/llms.txt`. Mintlify's March 2026 "state of agent traffic" report, based on ~790M requests over 30 days, found AI coding agents accounted for 45.3% of all requests, nearly tied with browser traffic at 45.8% (Claude Code and Cursor made up 95.6% of identified agent traffic); its July midyear report later put agent share at 66%. GitBook and Documentation.AI have shipped MCP/llms.txt as well; Mintlify partners with Trieve for the retrieval engine. The 2026 checklist:
- RAG/AI answers over the KB (grounded, cited).
- Vector search options: **pgvector** (in Postgres, simplest for a single-DB deploy), or **Typesense**/**Meilisearch** (both have vector/hybrid; Typesense's vector support is more mature, Meilisearch's was flagged experimental), or **Orama** (runs in-process/in-browser). **Algolia** is the managed premium baseline (NeuralSearch hybrid).
- `llms.txt` + `llms-full.txt`, markdown-for-LLMs endpoints (`.md` per page), content negotiation.
- MCP server exposing docs as tools.
- Chat-to-docs widget; auto-generated draft articles from resolved tickets.

### 5. Technical architecture for the three-target constraint

**Runtime: pin to Node.js everywhere.** `@cloudflare/next-on-pages` is deprecated (npm author message: "Please use the OpenNext adapter instead"); it only supported the Edge runtime and lacked many Next.js features. `@opennextjs/cloudflare` runs Next.js in the **Node.js runtime** on Workers (`workerd` + `nodejs_compat`), which is the critical enabler: the same `export const runtime = 'nodejs'` code path works on a self-hosted Node container, Vercel Node functions, and Cloudflare Workers. OpenNext supports Next.js 16 and the latest minors of 14/15 (14 support dropping Q1 2026); Cloudflare now also promotes `vinext` (a Vite plugin reimplementing the Next.js API surface) as a default path for Next.js 16 on Workers. Constraints to respect on `workerd`: no `fs`/`child_process`, and dynamic code eval is restricted.

**Database: Postgres + pgvector default, libSQL/Turso for edge-first, D1 optional.** For the "container with a DB" requirement, Postgres (self-hosted, or Neon/Supabase serverless) is the pragmatic default: pg_trgm/FTS for keyword search and pgvector for semantic in one engine, no extra service. libSQL/Turso (MIT, SQLite-family, self-hostable, embedded/edge replication) is the strongest fit if edge latency and single-file portability matter, at the cost of Postgres-specific features (JSONB operators, pg_trgm). Cloudflare D1 is cheapest for Cloudflare-native deploys but couples you to that platform. **Recommendation:** abstract via **Drizzle ORM** with a Postgres-first schema and a libSQL adapter; do not hard-depend on D1.

**Runtime theming (Priority 1) — the core architecture.** Tailwind v4 emits `@theme` tokens as real CSS custom properties; utility classes reference the variables, so overriding a variable at runtime re-skins every utility with no rebuild. The pattern:
- Define semantic tokens (`--primary`, `--background`, `--border`, radius, fonts) in `:root`/`.dark` and map them with `@theme inline`. The `inline` keyword is required for the indirection to cascade correctly (confirmed in Tailwind discussion #15600): without it, a `@theme` token pointing at a variable you later override in `:root` won't cascade.
- SSR-inject a per-tenant `<style>` block that redefines those variables from the tenant's DB row. Because the compiled utility CSS is static/cached and only variable *values* change per request, one build serves all tenants.
- shadcn/ui v4 uses exactly this model (semantic CSS variables in `:root`/`.dark`, OKLCH values, `@theme inline`, `data-slot` attributes), and Fumadocs UI uses `--fd-`-prefixed CSS variables inspired by shadcn — both are runtime-overridable by the same `<style>`-injection technique. Theme-editor tooling (tweakcn, themux) generates the variable blocks and can seed the JSON schema.
- **Hard limit to document:** only *values* of pre-defined tokens can change at runtime; you cannot mint brand-new utility classes at runtime without a Tailwind rebuild. Design the token namespace generously up front.
- Component-override system: adopt the Fumadocs/shadcn "components live in your repo" ownership model plus MDX component overrides (map MDX elements to themeable components) and named layout slots — this is the runtime, config-driven analog of Docusaurus swizzling / Starlight component overrides.

**Content storage & MDX compilation: DB-backed, compiled at runtime (no rebuild to publish).** Use **`@fumadocs/mdx-remote`** (v1.5.x) — it compiles MDX to JSX nodes **without a bundler/esbuild**, is RSC-compatible, and is purpose-built for "content from a database" (limits: images optimized at runtime, no import/export in MDX). Alternatives: `@mdx-js/mdx` `compile()` directly, or `next-mdx-remote-client` v2.x (better maintained than hashicorp's `next-mdx-remote`, which is flaky on Next 15.2 RSC and effectively unmaintained). **Do NOT use `mdx-bundler`** — it shells out to the esbuild Go binary, which fails on Vercel serverless (`esbuild-linux-64 could not be found`) and cannot run in `workerd`. Note that all MDX runtimes evaluate compiled JS via the `Function` constructor / `Reflect.construct` (effectively eval), so you must either loosen CSP `script-src` to `unsafe-eval` on the compile route, compile server-side and `run()` on the client, or use a rehype→HTML path (no eval, loses interactive components). Sanitize DB-stored MDX before compiling (it allows code execution by default). Test the known Vercel `@fumadocs/mdx-remote` "Connection closed" deployment issue (Fumadocs discussion #1623) early.

**Search on serverless:** Postgres FTS + pgvector keeps everything in one DB (works on container and via Neon/Supabase from serverless). Orama can run in-process/in-browser for zero-infra keyword search. Meilisearch/Typesense are better standalone engines but add a service to operate (harder on pure serverless). Fumadocs natively supports Orama and Algolia via a route handler — reuse that pattern.

**Auth/multi-tenancy:** per-tenant theming and private KBs imply tenant isolation. Postgres row-level scoping (`tenant_id`) or Turso's per-tenant-database model. Auth via Auth.js/Lucia; SSO/SAML/SCIM as enterprise (`/ee`) features.

**Assets/images:** avoid `fs`-based image handling (unavailable on Workers). Use object storage (S3/R2) with signed URLs; integrate Cloudflare Images for the CF target and Next/Image with a custom loader elsewhere. Optimize at runtime per the `@fumadocs/mdx-remote` constraint.

**Custom CSS/JS injection safety:** sanitize-html (server) + DOMPurify (client) for HTML — but **DOMPurify does NOT sanitize CSS** (both `<style>` and `style` are allowed by default). Add explicit guards against CSS exfiltration (attribute-selector `url()` tricks) and legacy `expression()`. Per-tenant custom JS should be sandboxed in an `<iframe sandbox>` with its own CSP. Note the inherent tension: runtime MDX eval wants `unsafe-eval` in `script-src`, while strict per-tenant JS injection wants a strict nonce-based CSP (which also forces dynamic rendering in Next.js) — isolate the two surfaces.

### 6. MVP scope (ruthlessly prioritized)

**v0.1 (MVP) — prove Priority 1 and Priority 2:**
- Content model: workspaces → categories → articles; draft/published states; DB-backed (Postgres + Drizzle).
- Runtime MDX rendering via `@fumadocs/mdx-remote`, Node runtime.
- **Theme engine:** JSON theme schema (colors, radius, fonts, logo, layout slots) stored in DB, injected as runtime `<style>` CSS variables; light/dark; a handful of preset themes. Editable and applied with no rebuild.
- **Deploy:** one `docker compose up` (app + Postgres) with a single `.env`; verified `vercel deploy`; verified Cloudflare Workers via `@opennextjs/cloudflare`. This is the headline of Priority 2.
- Keyword search (Postgres FTS or Orama).
- SEO: SSR, sitemap.xml, canonical URLs, `FAQPage` + `Article` JSON-LD.
- AI surfaces (cheap to ship, high signal): `/llms.txt`, per-page `.md` endpoint.
- "Was this helpful" feedback widget + basic view analytics.
- Basic auth + single-tenant admin.

**v1 — make it a product:**
- WYSIWYG/rich-text authoring alongside MDX; media library on S3/R2.
- Hybrid search (pgvector) + failed-search analytics.
- AI answers (RAG over the KB) + chat-to-docs widget; MCP server endpoint.
- i18n (per-language variants, hreflang, RTL); versioning; private/permissioned KBs.
- Multi-tenancy + per-tenant theming; embeddable in-app widget.
- Component/slot override system and per-page layout composition.

**Later:** auto-draft articles from tickets, A/B theme testing, plugin system, SAML/SCIM/audit logs (enterprise), workflow/approvals, content-freshness automation.

**Explicitly do NOT build:** ticketing/shared inbox, live chat, CRM, phone/voice, a plugin marketplace at launch, or your own vector database. Those are where Chatwoot/Zendesk already win or where you'd drown. Stay a help center, not a helpdesk.

### 7. Go-to-market / OSS strategy
- **License: AGPL-3.0 core + a separate `/ee` enterprise directory** under a commercial license. This is the proven devtools open-core pattern: Cal.com moved MIT→AGPLv3 and open-sourced its Enterprise Edition (the commercial license applies to the `/packages/features/ee` directory); Documenso is AGPL-3.0 community + commercial EE; Plausible, Typebot, Formbricks, and Twenty are all AGPL-3.0. AGPL's network-copyleft forces cloud competitors to open their modifications or buy a commercial license, creating the licensing lever sustainable OSS relies on, while still permitting commercial self-hosting. Keep `/ee` cleanly separable to avoid the Documenso #1415 critique (that AGPL core code depended on EE code, arguably making the whole thing AGPL under section 7). MIT (like Chatwoot core, BookStack, Fumadocs) maximizes adoption but leaves monetization to hosting/support only — a weaker moat for an app you intend to commercialize.
- **Monetization paths (2026 devtools playbook):** (1) managed cloud hosting — the primary revenue engine for Supabase/Cal.com/Documenso/Trigger.dev; (2) enterprise features in `/ee` — SSO/SAML/SCIM, audit logs, advanced permissions, multi-brand, white-label; (3) support/SLA contracts (Chatwoot sells self-hosted Premium Support at $19/agent/mo and Enterprise at $99). AI answer usage is a natural metered add-on, but price it transparently to contrast against Zendesk/Fin's opaque per-resolution fees.
- **Positioning/naming gap:** the market has no "open-source, deploy-anywhere, runtime-themable help center for the AI era." Position explicitly against (a) Zendesk/Fin seat+AI pricing and (b) proprietary/lock-in docs SaaS (Document360, Mintlify Enterprise gating of custom CSS). Lead with "theme it at runtime, deploy it anywhere, own your content and your AI surfaces." Target CTOs/solution architects and DX/docs teams who already run containers and want no per-seat tax.

## Recommendations
1. **Week 0-2 — de-risk the three-target runtime spike.** Build a throwaway Next.js 16 App Router app that compiles DB-stored MDX at runtime with `@fumadocs/mdx-remote` on `runtime = 'nodejs'`, and deploy the *same code* to a Docker container, Vercel, and Cloudflare Workers via `@opennextjs/cloudflare`. Specifically reproduce and resolve the known Vercel `@fumadocs/mdx-remote` "Connection closed" gotcha (Fumadocs discussion #1623) and confirm eval/CSP behavior on `workerd`. If any target fails irrecoverably, that changes the whole architecture — do this before anything else.
2. **Week 2-4 — ship the theme engine.** JSON theme schema in Postgres → SSR `<style>` injection of Tailwind v4 `@theme inline` CSS variables (shadcn / Fumadocs `--fd-*` model). Prove a theme change with zero rebuild. This is Priority 1; it should be demoable before the content model is complete.
3. **Week 4-8 — MVP surface.** Categories/articles CRUD, Postgres FTS search, SSR + sitemap + FAQPage/Article JSON-LD, `/llms.txt` + `.md` endpoints, feedback widget, and complete `docker compose up` + Vercel + CF deploy docs.
4. **License and structure the repo now** as AGPL-3.0 with an isolated `/ee`, a CLA, and a public roadmap, so cloud/enterprise monetization is not retrofitted later.
5. **Benchmarks that change the plan:**
   - If the Cloudflare Workers target proves too fragile for runtime MDX eval, drop CF to "static export only" and make container + Vercel the supported *dynamic* targets — document it honestly rather than shipping a broken CF path.
   - If pgvector latency/quality is inadequate at scale, add Typesense as an optional external engine in v1 rather than switching the default store.
   - If AGPL adoption friction is high among target self-hosters, consider Apache-2.0 core + commercial EE instead — decide by tracking self-host conversions and enterprise-license inquiries over the first two quarters.

## Caveats
- Pricing figures are 2026 vendor and third-party guide numbers; several vendors (Document360, Fin/Intercom, HelpJuice enterprise, Zendesk Suite Enterprise) have moved to quote-only or dynamically-loaded pricing, so verify against primary pricing pages before quoting externally. Several cited comparison/pricing pages are competitor-marketing blogs (eesel, BoldDesk, Docsie, BunnyDesk, happysupport, Richpanel); their directional claims about tier-gating and complaints are consistent across many independent sources, but individual dollar figures should be corroborated on primary pricing pages.
- The Fin (Intercom)→Salesforce acquisition was signed but not closed as of mid-2026; pricing and product direction may shift post-close.
- "Nearly half (45.3%) of docs traffic is AI agents" is Mintlify's own reported figure and is self-interested; treat the direction as real and the exact number as vendor-sourced (Mintlify's later midyear figure of 66% underscores the volatility).
- `@fumadocs/mdx-remote`, `next-mdx-remote-client`, Fumadocs (16.x), OpenNext's CF adapter, and Tailwind v4 are all fast-moving; re-pin exact version numbers at implementation time.
- Google's FAQ rich-result retirement means `FAQPage` schema no longer yields a visible SERP feature; its value is now AI extraction and semantic clarity, not rich snippets — do not oversell SEO gains from it. Search Console FAQ reporting is being retired mid-2026, so export any historical data before then.
- Outline's BSL 1.1 license is source-available, not OSI-approved open source — do not cite it as an "open-source" precedent or dependency if OSI compliance matters to your users.
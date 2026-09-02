# OPAS Answers v0.2 — competitive roadmap

**Decision date:** 2026-08-28

**Amended:** 2026-08-30

**Status:** v0.2 shipped; follow-on releases are demand-gated

**Goal:** convert current interest into design-partner usage with a trustworthy answer-and-improvement loop

## Recommendation

Build **OPAS Answers v0.2** around one complete loop:

> Import existing knowledge → retrieve only published evidence → answer with inspectable citations → abstain when evidence is insufficient → offer human contact with context → turn failures into a ranked content-improvement queue.

The release should ship six connected capabilities:

1. Markdown/ZIP and GitBook-export migration with a dry-run report.
2. A Markdown-native WYSIWYG editor with a lossless source mode.
3. Heading-aware chunking, hybrid retrieval, streaming answers, citations, and explicit abstention.
4. Native docs chat plus an iframe-isolated embeddable widget with page context and email/webhook handoff.
5. Conversation outcomes, source traces, a saved-question test playground, and a content-gap queue.
6. Read-only MCP and page actions for agent access.

This is more valuable than shipping a chat bubble alone. Across the current market, the durable product is a closed quality loop: grounded answer, visible sources, safe failure, human recovery, and evidence about what the documentation still needs.

## What the market sells today

Prices below are public list prices checked on 2026-08-28. Enterprise prices and some AI overages remain private.

### Documentation platforms

| Product | Current public entry point | Strongest capabilities | Opportunity for OPAS |
| --- | --- | --- | --- |
| GitBook | Premium $65/site/month annually + $12/user/month; Ultimate $249/site/month annually + $12/user/month | Bidirectional Git sync, reviews, AI search, embedded contextual Assistant, insights, adaptive and authenticated content | Put public-content answers and self-hosting in the open core instead of an upper tier. [Pricing](https://www.gitbook.com/pricing), [Assistant](https://gitbook.com/docs/publishing-documentation/gitbook-ai-assistant), [Git sync](https://gitbook.com/docs/integrations/git-sync) |
| Mintlify | Starter free; Pro displayed at $450/month | Git-backed visual editor, previews, cited Assistant, Agent, automations, MCP, API playground | Compete on ownership, portability, transparent provider choice, and a simpler operational surface. [Pricing](https://www.mintlify.com/pricing), [Assistant](https://www.mintlify.com/docs/guides/assistant), [MCP](https://www.mintlify.com/docs/ai/model-context-protocol) |
| ReadMe | Pro $250/month annually; full Ask AI +$150/month | Interactive API reference, personalized credentials, API metrics, Git workflow, grounded Ask AI | Treat OpenAPI tooling as a design-partner-dependent expansion, not a prerequisite for general help centers. [Pricing](https://readme.com/pricing), [Ask AI](https://docs.readme.com/main/docs/ask-ai), [metrics](https://docs.readme.com/main/docs/using-metrics-charts) |
| Fern | Hobby free; Team displayed at $150/month | Multi-protocol API docs, SDK generation, version/product/role-scoped Ask Fern, MCP, self-hosting at Enterprise | Copy the retrieval scoping discipline; do not chase SDK generation without proven API-first demand. [Pricing](https://buildwithfern.com/pricing), [Ask Fern](https://buildwithfern.com/learn/docs/ai-features/ask-fern/overview), [MCP](https://buildwithfern.com/learn/docs/ai-features/mcp-server) |
| Redocly Realm | Modular per-seat pricing; AI and RBAC in higher tiers | API governance, deep React/Markdoc customization, RAG governance, analytics, MCP | Keep OPAS focused on support content; borrow inspectable AI operations and read-only agent access. [Pricing](https://redocly.com/pricing), [AI governance](https://redocly.com/docs/realm/faq/ai-governance), [AI-ready docs](https://redocly.com/docs/realm/ai-ready) |
| Document360 | Sales quote | Revision history and rollback, review workflows, embedded help, AI chat/search, feedback and analytics, access controls, integrations | Its breadth reinforces revisions and review as the next team-readiness release, not a reason to delay the v0.2 answer loop. [Pricing and features](https://document360.com/pricing/) |
| Docusaurus | No software license fee; MIT-licensed and self-hosted | Static portability, MDX/React customization, versioning, i18n, large plugin ecosystem | Remain the managed, database-backed alternative for teams that do not want to assemble every workflow. [Repository](https://github.com/facebook/docusaurus), [deployment](https://www.docusaurus.io/docs/next/deployment), [versioning](https://docusaurus.io/docs/versioning) |

### AI support and knowledge products

| Product group | What matters | Product lesson for OPAS |
| --- | --- | --- |
| Intercom Fin and Zendesk AI | Cited generative answers, clarification, escalation, restricted-source handling, conversation outcomes, detailed quality reporting | Reliability is a workflow, not a prompt. OPAS needs abstention, traces, outcome definitions, and escalation from the first pilot. [Fin behavior](https://www.intercom.com/help/en/articles/11433030-conversational-fin-experience), [Fin outcomes](https://www.intercom.com/help/en/articles/8205718-fin-ai-agent-outcomes), [Zendesk source display](https://support.zendesk.com/hc/en-us/articles/9517744828058-Configuring-settings-for-generative-replies-in-advanced-AI-agents), [restricted content](https://support.zendesk.com/hc/en-us/articles/8087943201306-Using-restricted-help-center-content-in-AI-agent-responses), [conversation logs](https://support.zendesk.com/hc/en-us/articles/8357749580186-Reviewing-conversation-logs-for-AI-agents) |
| Help Scout AI Answers | Corrective “Improvements,” topic guardrails, a test tab, support transition, and a $0.75 resolved-session price | A small quality-control surface can outperform a large connector list for early users. [Best practices](https://docs.helpscout.com/article/1771-ai-answers-best-practices), [pricing](https://docs.helpscout.com/article/1746-ai-resolutions-pricing) |
| Kapa and Inkeep | Source-scoped RAG, citations, broad ingestion, embeds, content gaps, support handoff, evaluation and observability | These are the closest feature and operational benchmarks for technical knowledge. Their managed retrieval is sales-led, leaving room for a transparent self-hosted core. [Kapa sources](https://www.kapa.ai/product/connect), [Kapa analytics](https://www.kapa.ai/product/analyze), [Inkeep pricing](https://docs.inkeep.com/pricing) |
| Chatbase and similar self-serve RAG tools | Broad ingestion, widgets, verified identity, helpdesk handoff, source maintenance, and subscription-plus-credit pricing | OPAS should match the core loop, not their catalog breadth. Server-derived citation objects can avoid the fabricated-link weakness Chatbase documents. [Sources](https://www.chatbase.co/docs/user-guides/chatbot/data-sources), [handoff](https://www.chatbase.co/docs/user-guides/chatbot/actions/escalate-to-human), [identity](https://www.chatbase.co/docs/developer-guides/identity-verification), [response quality](https://www.chatbase.co/docs/user-guides/quick-start/response-quality), [pricing](https://www.chatbase.co/pricing) |

This review found no credible public evidence of a zero-hallucination guarantee. OPAS should promise **approved-source grounding, inspectable citations, explicit uncertainty, and fast recovery to a human**.

## OPAS position

OPAS v0.1 already has the difficult portability foundation: database-backed MDX, drafts and publishing, runtime themes, typo-tolerant Orama search, privacy-light analytics, `llms.txt`, `llms-full.txt`, page Markdown, Docker/Postgres, Vercel/Neon compatibility, and Cloudflare/D1 production.

The shortest path to a competitive answer product is therefore not a second search stack. It is one shared evidence pipeline that ordinary search, RAG, MCP, and evaluation consume.

The proposed v0.2 product has a credible market wedge:

- genuine AGPL self-hosting and data ownership;
- Cloudflare-first edge deployment without giving up Docker or Postgres;
- runtime branding without rebuilds;
- provider-neutral AI and BYOK rather than a required model vendor once v0.2 ships;
- agent-readable output as a core product surface;
- a smaller, auditable system than the enterprise suites.

## Priority order

| Rank | Capability | Decision | Why now |
| ---: | --- | --- | --- |
| 1 | Grounded chat/RAG | Build in v0.2 | It is the clearest missing customer value and the common paid-platform feature. |
| 2 | Migration/import | Build in v0.2 | Interested teams will not reauthor their knowledge base to run a pilot. GitBook supports URL, Markdown, HTML, Word, ZIP, and repository imports, which shows how central migration is to activation. [GitBook migration](https://gitbook.com/docs/getting-started/import) |
| 3 | Markdown-native WYSIWYG | Build in v0.2 | Import gets knowledge into OPAS; a visual editor lets non-technical owners keep it correct without sacrificing portable source. |
| 4 | Embed and handoff | Build in v0.2 | Answers become more valuable inside the customer's product, and handoff makes abstention useful instead of terminal. |
| 5 | Evaluation and content gaps | Build in v0.2 | Quality must be measurable before real users trust the assistant. Failed questions should improve the knowledge base. |
| 6 | MCP and page actions | Build in v0.2 | MCP is now present across major docs platforms; OPAS already has most of the source material required. |
| 7 | Revisions, previews, multiple admins, reviewer role | Build next | These make team authoring safe after the pilot value loop exists. |
| 8 | GitHub sync and selected connectors | Build next | Freshness matters, but the ingestion and conflict contracts should be proven first. |
| 9 | Private docs and retrieval ACLs | Later | High value, but a source-authorization bug would be severe. Build only with end-to-end isolation tests. |
| 10 | OpenAPI reference/playground | Conditional | Move up only if the first design partners are API-first. |
| 11 | AI writer, translation, adaptive content, autonomous actions | Defer | These broaden risk before answer quality and activation are proven. |

## Technical direction

### Safe, portable migration

Keep OPAS's shallow information architecture for v0.2. Map the first GitBook level to categories, flatten deeper paths deterministically into ordered articles, derive workspace-unique slugs from full source paths, rewrite internal links, and report every rename. Add an article position field so the source order survives; do not change the existing public URL contract merely to imitate GitBook's deeper tree.

Imported assets need writable storage, which OPAS does not currently have. The smallest portable v0.2 choice is content-addressed binary rows shared by Postgres and D1, limited to allowlisted image types and 1 MiB per object, served from immutable same-origin URLs with hashes and cache headers. Authenticated imports and editor uploads stage assets under an expiring manifest; a successful article transaction attaches referenced hashes, while failure, cancellation, article deletion, and expiry remove unreferenced rows. Blob and data URLs never become stored article sources. That stays below D1's 2 MB row/BLOB limit. If a real pilot cannot fit this bound, introduce an R2/S3-compatible asset adapter before importing that pilot rather than writing to ephemeral application files. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

Treat every archive as hostile. Reject path traversal, absolute paths, symlinks, encrypted entries, nested archives, duplicate normalized paths, MIME spoofing, and unsupported types; enforce compressed size, expanded size, compression ratio, file count, per-file, and total-asset limits before writes. Stage an import under one manifest and activate it only after validation so a failed import leaves no visible articles, rewritten links, or orphaned assets.

Frontmatter is import metadata, not stored MDX. Map only an explicit allowlist to corresponding OPAS article fields, strip it before the existing safety validator sees the body, and report every unknown field and every conflict with path, `SUMMARY.md`, or form metadata. Use the first H1 as the title when no stronger mapped title exists; deterministically demote later H1s to H2 during import and report each change. Source-mode saves reject later H1s, preserving exactly one title-owned H1 after import.

### Markdown-native visual authoring

Keep validated Markdown/MDX as the canonical stored value; do not introduce a proprietary editor document format. Replace the raw-text-only article experience with Visual and Source modes backed by one document. Define one Markdown syntax and compiler/plugin contract shared by editor parsing, server validation, preview, Node rendering, workerd rendering, and export; extend it with table support before exposing the table control. The visual surface covers headings, paragraphs, emphasis, links, lists, quotes, code, tables, dividers, and persisted or allowed remote images, with an accessible toolbar and keyboard commands, undo/redo, safe paste, and drag-and-drop asset insertion through the staged asset lifecycle.

The title field owns the article title. Serialization writes exactly one matching level-one heading, and server validation rejects any later H1, so renaming an article cannot leave its body invalid. Switching Visual → Source → Visual must preserve semantic content and stable links. If a valid imported document contains syntax the visual grammar cannot represent losslessly, Visual mode must preserve it as an explicit read-only source block or refuse conversion with a precise message; it must never delete or silently normalize that content. Saving still passes through the existing server-side MDX safety and publication validation boundary.

Select the editor library through a small round-trip and accessibility spike when implementation starts. The acceptance contract matters more than the library: client-only authoring must not enlarge or weaken the public runtime, stored content must remain exportable Markdown, and an existing article must remain byte-for-byte unchanged until the author saves.

### One portable evidence pipeline

Create deterministic heading-level chunks for every published article. Each chunk needs workspace, article, canonical URL, title, heading path, content hash, and publication state. Publishing commits the article, current chunks, content hash, an incremented workspace index generation, and a pending embedding job without calling an AI provider inside the transaction. Unpublish and delete invalidate old chunks and increment the generation synchronously. A bounded retryable worker activates embeddings only when their article hash, provider, model, dimension, and configuration still match; pending or stale generations are never eligible for vector retrieval. Keyword search remains immediately available if embedding fails.

Keep one retrieval contract across targets. For pilot-sized knowledge bases, store embeddings and build an Orama hybrid index from chunks. Every request compares the cached immutable index generation with the database, rebuilds on mismatch, and revalidates the selected chunk hashes and publication state before generation; this prevents a warm Cloudflare isolate from serving an unpublished source. Cloudflare production can generate embeddings with Workers AI; Docker and Vercel can use a configured OpenAI-compatible embedding endpoint. Orama supports vector and hybrid search, but the supported OPAS scale must be measured rather than assumed. [Orama vector search](https://docs.orama.com/docs/orama-js/search/vector-search), [hybrid search](https://docs.orama.com/docs/orama-js/search/hybrid-search)

Cloudflare Workers allow 128 MB per isolate, so v0.2 must measure memory and publish a supported chunk limit. If real pilot content exceeds it, keep the contract and add Vectorize on Cloudflare and pgvector on Postgres. Do not create two storage-specific retrieval paths before the portable implementation fails a measured gate. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

Use the same deterministic embedding fixture to prove retrieval logic across runtimes, then run quality gates separately for every production embedding provider because different models can rank sources differently. Evaluate [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/platform/limits-pricing/) against the same question set, but keep it optional: it remains open beta, future billing is not announced, and requiring it would weaken deploy-anywhere portability.

### Answers with citations by construction

The answer endpoint should:

1. validate a bounded question, conversation history, and current-page context;
2. retrieve only currently published chunks for the active workspace and scope, then apply an evidence-sufficiency threshold calibrated on the saved question set;
3. abstain below that threshold; otherwise ask the model for a constrained answer containing only server-issued citation IDs;
4. stream the answer over SSE through a strict Markdown renderer;
5. map citation IDs to canonical metadata and reject every unknown ID;
6. redact the transcript before recording the outcome, trace, latency, token use, and configured cost estimate.

The model must never invent citation URLs. The server owns the link objects, so every displayed source can be proven to have been retrieved and published. That proves provenance, not support: the evaluation set must also score whether the cited passage actually entails each material claim and whether all material claims are covered.

Generated answer content never enters the runtime MDX renderer. Permit only paragraphs, lists, emphasis, and fenced/inline code; escape raw HTML, reject images and unsafe protocols, and render links only from server-owned citation records. Test both direct model output and malicious instructions embedded inside retrieved articles.

Use a Workers AI binding through AI Gateway on the Cloudflare deployment. For every conversation, set the binding's gateway options to `skipCache: true` and `collectLog: false`; AI Gateway otherwise enables logs containing request and response data by default. OPAS records only its own redacted usage metadata. Other targets use the same answer contract through a generic OpenAI-compatible provider with its retention behavior disclosed. Provider fallback is opt-in because it can send the conversation to another vendor. [Workers binding options](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/), [AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/), [AI Gateway caching](https://developers.cloudflare.com/ai-gateway/features/caching/)

### Embed and handoff, not a helpdesk

Ship one small loader script that renders a dedicated assistant document in an isolated iframe. OPAS currently applies `frame-ancestors 'none'` to every route, so the implementation must exclude only this embed document from the catch-all policy and emit an exact configured parent-origin allowlist. Every other public and admin route keeps `frame-ancestors 'none'`. The embed document does not render runtime MDX and therefore should not inherit the public article policy's `unsafe-eval`; parent/child messages validate the exact origin in both directions.

The loader supplies only a URL that OPAS resolves back to a current published article; arbitrary parent-page text never becomes trusted context. Signed visitor identity is deferred with private widgets unless a design partner proves that verified handoff attribution is required.

Every answer exposes “Contact support.” Abstention and negative feedback make it prominent. The first handoff sends a configurable email or generic webhook with the question, bounded transcript, citations, page URL, outcome, and user-supplied contact details. OPAS should integrate with existing helpdesks later; it should not build an inbox or live-agent system.

### Quality, privacy, and cost are part of the MVP

Freeze and version a 50-question launch-partner fixture by source-content hash: at least 20 answerable, 5 ambiguous, 10 unsupported, 5 stale/conflicting with both types represented, and 10 adversarial. Save retrieval and answer runs with per-class numerator/denominator so releases can be compared. The first release may use one operator-authorized launch partner plus the independent synthetic safety fixture; it must not invent additional customer evidence.

These are OPAS release targets, not claimed market benchmarks:

- 100% of displayed citation URLs are server-derived from retrieved, currently published chunks.
- No draft, deleted, cross-workspace, or out-of-scope source appears in retrieval or output.
- At least 90% of answerable questions retrieve an accepted source in the top five.
- At least 90% of unanswerable or adversarial questions abstain or hand off.
- At least 90% of manually scored answers are grounded and materially correct before pilot release, and at least 90% of their material factual claims are entailed by and covered by the displayed citations.
- First-token latency, total latency, tokens, and cost are visible in production.
- At the documented supported corpus limit, workerd peak memory stays at or below 96 MB, warm retrieval p95 stays at or below 250 ms, cached-index rebuild from persisted embeddings p95 stays at or below 2 seconds, newly published embeddings become active within 60 seconds p95, first token arrives within 3 seconds p95, and average evaluated inference cost stays at or below $0.02 per answer.
- Atomic per-workspace reservations cap concurrent streams and maximum token cost before inference; completion, cancellation, timeout, and expired-lease recovery reconcile the reservation exactly once.
- Configurable abuse and spend limits stop AI generation cleanly while ordinary documentation and search remain available.

Default conversation retention to 30 days, while letting a core operator disable analytics or choose a shorter retention period. Redact emails, phone numbers, tokens, credentials, IP-shaped values, and configured customer patterns on the server before storing the bounded transcript; raw input exists only in request memory and the disclosed model-provider call. Store explicit contact details only in a separate handoff record. Do not store IP addresses, raw user agents, or cookies. Enforce expiry in every read and ship a real cleanup invocation for Cloudflare, Vercel, and Docker so expired rows are physically removed.

Private sources remain out of v0.2. They require signed viewer identity, source-level authorization metadata, permission filtering before retrieval, and adversarial tests proving there is no cross-scope leakage.

## Execution plan

### Milestone 0 — Pilot intake and migration

- Capture the first operator-authorized launch partner's source of truth, format, required refresh cadence, and frozen 50-question fixture; retain the synthetic fixture as an independent control and add further partners as they enter an actual pilot.
- Add deterministic shallow-navigation mapping, article order, and bounded content-addressed database assets.
- Import Markdown files and ZIPs, including GitBook `SUMMARY.md`, frontmatter, safe assets, relative links, and redirect candidates.
- Replace raw-text-only authoring with the Markdown-native Visual/Source editor and prove lossless round trips over imported and hand-authored fixtures.
- Produce dry-run, rename, conflict, skipped-content, and post-import reports; never silently discard unsupported custom blocks or assets.
- Verify a representative GitBook export can be imported, visually edited, source-edited, rendered, searched, exported, and rolled back after an intentionally failed run.

### Milestone 1 — Evidence and retrieval

- Add cross-dialect chunk, embedding-generation, retryable-job, indexing-state, and saved-test records.
- Commit current chunks and pending state with content, invalidate removals synchronously, and activate embeddings only after a matching post-commit job succeeds.
- Implement portable hybrid retrieval with published/workspace scope enforced before scoring.
- Benchmark lexical, Orama hybrid, and optional Cloudflare AI Search with the same question set; select the smallest implementation that clears the release gates.
- Verify both database dialects, workerd memory/CPU behavior, index freshness, isolation, and regression results.

### Milestone 2 — Native answers

- Add streaming search/chat UI, bounded follow-ups, current-page context, suggested questions, citations, and explicit abstention.
- Add Cloudflare Workers AI and generic OpenAI-compatible providers behind one contract, with AI Gateway conversation logs and caching disabled and other provider retention disclosed.
- Add a strict answer renderer, visible AI labeling, retention disclosure, model timeouts, opt-in fallback, atomic usage reservations, abuse limits, and hard spend controls.
- Verify citation provenance, entailment and coverage, direct and retrieved prompt injection, streamed XSS, no-answer behavior, provider failure, limit exhaustion, mobile behavior, and accessibility.

### Milestone 3 — Embed and recovery

- Add the dedicated iframe document, exact parent-origin CSP, loader, and validated current-page metadata while keeping every other route unframeable.
- Add email and generic webhook handoff with the full support context.
- Record answered, abstained, low-rated, escalated, and abandoned outcomes.
- Verify allowed and denied parent origins, CSP/CORS isolation, redaction and transcript fidelity, duplicate-send prevention, and real email/webhook delivery on all three deployment paths.

### Milestone 4 — Quality operations and agent surfaces

- Add redacted conversation/source trace review, feedback reasons, saved tests, topic guardrails, and a ranked knowledge-gap queue. Corrections remain editor suggestions until merged into a published, citable article; hidden corrective records never enter retrieval.
- Add read-only MCP search/read tools plus `Copy page`, `View Markdown`, and `Open in ChatGPT/Claude` actions.
- Verify retention cleanup, CSV export, published-scope isolation, and MCP behavior against the current protocol.

The MCP implementation must reread the current specification when work starts. The protocol changed on 2026-07-28, and TypeScript SDK versions 1.10 through 1.25.3 had a cross-client data-leak advisory fixed in 1.26.0. Use a current patched release and a fresh stateless server/transport per request. [Current transport specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx), [security advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-345p-7cg4-v4c7)

## Follow-on order

After v0.2 proves adoption and answer quality:

1. Article revisions, rollback, signed previews, multiple admins, and editor/reviewer roles, specified in the [OPAS Team Authoring v0.3 implementation plan](team-authoring-plan.md).
2. One-way GitHub import/sync, followed by bidirectional sync only after conflict semantics are proven.
3. Signed private widgets and audience/version/product-scoped retrieval.
4. The one connector requested by multiple design partners, then a small connector SDK.
5. OpenAPI reference/playground if pilot usage shows a developer-docs concentration.
6. Aggregate AI-agent traffic by family if pilot operators say it changes content or distribution decisions.

Do not schedule SDK generation, arbitrary custom-block visual authoring, real-time collaborative editing, live human chat, a ticket inbox, voice/social channels, autonomous support actions, a large connector catalog, multi-tenancy, or a plugin marketplace before the core loop has retained pilots.

## Packaging

Keep public-content import, Markdown-native visual authoring, retrieval, chat, citations, abstention, embed, read-only MCP, and basic quality analytics in the AGPL core. That is the product wedge, not a teaser.

Use hosted or `/ee` packaging for managed inference and credits, organization-wide connectors, private sources, SAML/SCIM, granular RBAC, audit logs and legal holds, managed residency guarantees, multi-brand operation, and SLAs. Core self-hosters retain control over whether conversations are stored and for how long. Start hosted pilots with a flat subscription and included capped AI usage. Outcome-based billing should wait until OPAS has stable outcome semantics and enough data to explain disputed resolutions; current competitors use both per-outcome pricing—[Help Scout at $0.75](https://docs.helpscout.com/article/1746-ai-resolutions-pricing) and [Intercom at $0.99 for standard Fin outcomes](https://www.intercom.com/help/en/articles/8205718-fin-ai-agent-outcomes)—and subscription-plus-credit models.

## Research limits

- Capability evidence is primarily first-party vendor documentation. It proves that features are marketed and documented, not that one vendor is objectively more accurate.
- No credible public apples-to-apples RAG benchmark was found. OPAS needs its own launch-partner test set plus an independent synthetic control.
- Enterprise prices, some overage rules, self-hosting mechanics, and retention details are private or ambiguous.
- Cloudflare AI Search, AI model catalogs, MCP, pricing, and vendor plans are moving targets and must be rechecked at implementation time.

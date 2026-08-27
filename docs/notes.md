# Runtime constraints

## Cloudflare Workers and D1

The Next.js application builds with `@opennextjs/cloudflare` 1.20.4 and runs against the D1 dialect through the same repository contract used by Postgres. Fresh local Wrangler migrations and the deployment seed complete successfully, and changing the D1 article row changes the next rendered response without rebuilding.

Workerd rejects request-time dynamic evaluation. OPAS therefore compiles MDX to a function body inside the Worker and executes that body in the browser. Public content rendering consequently needs `unsafe-eval` in `script-src`; the content must pass the MDX allowlist added in item 3.3 before compiling or editing ships.

Fumadocs uses its minimal runtime preset, with the unused documentation-plugin import excluded. This removed the Shiki initialization path and reduced the spike Worker from 3.126 MiB to about 1.27 MiB compressed. The Phase 1 bundle is about 1.44 MiB compressed after adding all database adapters.

The remote database is `opas-mvp` in Eastern Europe and the deployed Worker is [opas-mvp.timo-bejan.workers.dev](https://opas-mvp.timo-bejan.workers.dev). The first spike rendered the D1-backed MDX, then rendered a remote row edit on reload without changing Worker version `fd9ac205-1df9-4d57-af03-7868274f4026`; the deterministic seed restored the original article afterward. The Phase 2 build was verified through final secret-backed version `d55a1674-c016-48ed-bccb-8684c6dd479a`: the public MDX rendered, an authenticated Ocean preset write appeared in distinct light and dark public CSS on reload, and the OPAS preset was restored. Phase 4 Worker version `251eed75-161e-4528-8cd3-2757d3d8c629` added D1-backed search; a typo returned the published runtime article, a one-code-point query bypassed database work, and a unique zero-result query wrote exactly one bounded-slot row before the proof row was removed. The spike sends no Content-Security-Policy header, so hardening must add a policy that permits the renderer's `unsafe-eval` requirement while keeping other script sources constrained.

## Vercel and Neon

The Neon HTTP adapter connects successfully to Postgres 18.6 in `eu-central-1` and shares the Postgres repository queries. The minimal Fumadocs preset avoids the Shiki path associated with the reported `Connection closed` failure. Only a real Vercel production deployment can close that finding; it remains pending the rollout confirmation.

## Runtime themes

Runtime themes may change values only within OPAS's predefined semantic color, font, and radius tokens. Adding a token or a Tailwind utility requires a rebuild. Font stacks may reference only fonts already available to the browser; changing a stack does not load a font file.

The root server layout validates and injects the active database row on every request. The authenticated editor writes one trusted workspace row through the shared repository, and public reloads observe the change immediately. [`theme-before.png`](theme-before.png) and [`theme-after.png`](theme-after.png) show OPAS Default and Ocean from the same production build and server process; both light and dark computed values were verified, then the local row was restored.

Admin sessions are signed, stateless, valid for eight hours, and limited to `/admin`. Production cookies are always Secure, so production admin access requires HTTPS. OpenNext labels Node.js Proxy support experimental during its Cloudflare build, but the deployed workerd boundary passed: an unauthenticated request redirected to `/admin/login`, authenticated Server Actions wrote D1, and rotating the signing secret invalidated the smoke session immediately.

## MDX threat model

Article rows are untrusted at render time even when they normally come from the authenticated editor: an import, a compromised database credential, or a future write path must not turn content into application code. Fumadocs compiles MDX to a JavaScript function body and executes it with a dynamic function on Node or in the browser on Cloudflare, where the renderer also requires `unsafe-eval`.

Every article therefore passes through the MDX parser before either execution path. The validator rejects module imports and exports, frontmatter, inline and block JavaScript expressions, expression-valued or spread component properties, unsafe link and image protocols, and every JSX element outside the registered component allowlist. Reference definitions use the narrower relative-or-HTTP(S) URL policy because Markdown shares definitions between links and images. The v0.1 component allowlist is empty because OPAS currently registers no custom article components; normal Markdown, including fenced and inline code examples that contain those strings, remains valid. A future component must be registered in the renderer and explicitly admitted here only after its properties and output are audited.

This boundary prevents stored content from intentionally reaching the MDX execution surface; it does not make `unsafe-eval` harmless or protect against a compiler/runtime vulnerability. The authenticated live preview also executes validated compiled MDX in the browser on every deployment target, while public browser execution is Cloudflare-specific. Responses still need a CSP that grants `unsafe-eval` only on routes where either renderer requires it and constrains every other script source.

## Docker content authoring

The Docker target passed the complete administrator lifecycle against PostgreSQL: executable MDX was rejected in both preview and save, a newly authored draft returned a real public 404, publishing made it appear on the home, category, and article routes, and an MDX edit appeared after refresh without rebuilding the image. Article and category deletion removed every temporary proof row, and restoring the final signing secret invalidated the temporary administrator session.

The Alpine dependency stage installs Python, Make, and a C++ compiler because the clean ARM build compiles the development-only `better-sqlite3` package from source. Those tools remain outside the non-root runtime image.

## Search runtime

Search uses Orama 3.1.18 in process rather than a database-specific full-text engine. Each request reads the current published articles and categories through the shared repository. The search module derives a deterministic signature from that snapshot, reuses the module-local index only while the signature matches, and rebuilds after a publish, unpublish, article edit, category edit, or isolate restart. The database snapshot is authoritative; isolate memory is only a latency optimization.

The index contains title, plain Markdown body text, and category name. Results expose only validated public slugs and a bounded plain-text excerpt. The route normalizes queries, limits them to 200 Unicode code points, disables response caching, and records normalized zero-result queries. Miss sampling has 1,024 conflict-safe slots per UTC day and opportunistically removes records beyond the 30-day cutoff when another miss arrives, bounding anonymous writes and stored row count while keeping a useful MVP sample. Docker/PostgreSQL and Cloudflare/D1 both returned the same typo-tolerant result, while exact canary checks proved miss persistence on both dialects.

## Feedback and readership signals

The article view beacon and helpfulness form send no cookies and set `credentials: omit`. OPAS does not persist an IP address, user agent, referrer, client ID, or salted requester key. On Cloudflare, where the platform supplies the authoritative `CF-Connecting-IP` header, the server derives a process-salted network key only in memory for a one-minute admission window and limits one requester to 5 feedback attempts and 30 view attempts. Other targets skip requester grouping rather than trusting client-controlled forwarding headers. Every running process still caps feedback and view database attempts at 120 and 600 per minute respectively. These portable counters are best-effort overload shedding, not a deployment-wide abuse firewall; production operators should also apply trusted platform edge limits.

Accepted events occupy one of 1,024 conflict-safe slots per article, event kind, and UTC day. Collisions are intentionally discarded, so the administrator report labels views, feedback, and helpfulness as directional samples rather than unique visitors or exact totals. The report includes only the last 30 days. Old event rows are removed opportunistically when the same article receives another event; an inactive or unpublished article can retain an older free-text comment beyond the reporting window, so this is not a guaranteed 30-day deletion policy.

Feedback accepts only a boolean helpful value and an optional trimmed comment of at most 1,000 Unicode code points. Request bodies are strict JSON, capped at 16 KiB, and never render comments back into public HTML. Draft, missing, and wrong-workspace articles reject both event types.

Cloudflare Worker version `40d90ba4-f530-423e-88d6-3072f93a1296` passed the complete D1-backed flow: workerd rendered the article and feedback controls, the browser wrote a view and a free-text no response without cookies or console errors, a sampled zero-result query appeared in the authenticated report, and direct requests rejected malformed and draft events. The proof rows were deleted afterward and all three analytics tables returned to zero rows.

## Public discovery surfaces

`OPAS_SITE_URL` is the authoritative origin for canonical URLs and absolute machine-readable links. Docker defaults it to `http://localhost:3000`; the Worker pins its exact workers.dev origin. A deployment with another public hostname must set that origin explicitly.

One request-time published-content projection supplies page metadata, `sitemap.xml`, Article and conditional FAQPage JSON-LD, `llms.txt`, `llms-full.txt`, and per-article Markdown. It rejects mismatched workspaces and categories, drafts, and unsafe slugs before any of those surfaces can expose a record. JSON-LD escapes literal `<` before entering a script element. The `.md` path is rewritten to an internal route, returns `text/markdown` without caching, and sends `X-Robots-Tag: noindex, nofollow`; global `Link` and `X-Llms-Txt` headers advertise the two llms documents.

Cloudflare Worker version `61d7ca6a-e7d7-406e-98ee-17512d4c1831` served exact workers.dev canonicals and D1-backed output on every surface. A temporary FAQ article appeared immediately after insertion and disappeared immediately after changing it to draft, without a rebuild; the proof row was then deleted.

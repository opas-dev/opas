# Runtime constraints

## Cloudflare Workers and D1

The Next.js application builds with `@opennextjs/cloudflare` 1.20.4 and runs against the D1 dialect through the same repository contract used by Postgres. Fresh local Wrangler migrations and the deployment seed complete successfully, and changing the D1 article row changes the next rendered response without rebuilding.

Workerd rejects request-time dynamic evaluation. OPAS therefore compiles MDX to a function body inside the Worker and executes that body in the browser. Public content rendering consequently needs `unsafe-eval` in `script-src`; the content must pass the MDX allowlist added in item 3.3 before compiling or editing ships.

Fumadocs uses its minimal runtime preset, with the unused documentation-plugin import excluded. This removed the Shiki initialization path and reduced the spike Worker from 3.126 MiB to about 1.27 MiB compressed. The Phase 1 bundle is about 1.44 MiB compressed after adding all database adapters.

The remote database is `opas-mvp` in Eastern Europe and the deployed Worker is [opas-mvp.timo-bejan.workers.dev](https://opas-mvp.timo-bejan.workers.dev). The first spike rendered the D1-backed MDX, then rendered a remote row edit on reload without changing Worker version `fd9ac205-1df9-4d57-af03-7868274f4026`; the deterministic seed restored the original article afterward. The current Phase 2 build was also deployed and verified through final secret-backed version `d55a1674-c016-48ed-bccb-8684c6dd479a`: the public MDX rendered, an authenticated Ocean preset write appeared in distinct light and dark public CSS on reload, and the OPAS preset was restored. The spike sends no Content-Security-Policy header, so hardening must add a policy that permits the renderer's `unsafe-eval` requirement while keeping other script sources constrained.

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

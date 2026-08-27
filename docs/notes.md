# Runtime constraints

## Cloudflare Workers and D1

The Next.js application builds with `@opennextjs/cloudflare` 1.20.4 and runs against the D1 dialect through the same repository contract used by Postgres. Fresh local Wrangler migrations and the deployment seed complete successfully, and changing the D1 article row changes the next rendered response without rebuilding.

Workerd rejects request-time dynamic evaluation. OPAS therefore compiles MDX to a function body inside the Worker and executes that body in the browser. Public content rendering consequently needs `unsafe-eval` in `script-src`; the content must pass the MDX allowlist added in item 3.3 before compiling or editing ships.

Fumadocs uses its minimal runtime preset, with the unused documentation-plugin import excluded. This removed the Shiki initialization path and reduced the spike Worker from 3.126 MiB to about 1.27 MiB compressed. The Phase 1 bundle is about 1.44 MiB compressed after adding all database adapters.

The remote database is `opas-mvp` in Eastern Europe and the deployed Worker is [opas-mvp.timo-bejan.workers.dev](https://opas-mvp.timo-bejan.workers.dev). Browser verification rendered the D1-backed MDX, then rendered a remote row edit on reload without changing Worker version `fd9ac205-1df9-4d57-af03-7868274f4026`; the deterministic seed restored the original article afterward. The spike sends no Content-Security-Policy header, so hardening must add a policy that permits the renderer's `unsafe-eval` requirement while keeping other script sources constrained.

## Vercel and Neon

The Neon HTTP adapter connects successfully to Postgres 18.6 in `eu-central-1` and shares the Postgres repository queries. The minimal Fumadocs preset avoids the Shiki path associated with the reported `Connection closed` failure. Only a real Vercel production deployment can close that finding; it remains pending the rollout confirmation.

## Runtime themes

Runtime themes may change values only within OPAS's predefined semantic color, font, and radius tokens. Adding a token or a Tailwind utility requires a rebuild. Font stacks may reference only fonts already available to the browser; changing a stack does not load a font file.

The root server layout validates and injects the active database row on every request. The authenticated editor writes one trusted workspace row through the shared repository, and public reloads observe the change immediately. [`theme-before.png`](theme-before.png) and [`theme-after.png`](theme-after.png) show OPAS Default and Ocean from the same production build and server process; both light and dark computed values were verified, then the local row was restored.

Admin sessions are signed, stateless, valid for eight hours, and limited to `/admin`. Production cookies are always Secure, so production admin access requires HTTPS. OpenNext currently labels Node.js Proxy support experimental during its Cloudflare build; the bundle compiles successfully, but the deployed Cloudflare admin boundary still needs a live smoke test before release.

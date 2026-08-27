# AGENTS.md — working rules for the OPAS repo

`progress.md` is the single source of truth for what to do next and when work counts as done. `PROMPT.md` holds the mission contract for autonomous runs.

## Commands
Keep this section current as the project grows.
- Install: `pnpm install`
- Dev: `pnpm dev`
- Build: `pnpm build`
- Tests: `pnpm test` (must pass against both DB dialects)
- Local stack: `docker compose up`

## Conventions
- Every code file starts with a 2-line comment header, each line beginning `ABOUTME: `, explaining what the file does.
- Names describe domain purpose, never implementation or history: `Tool` not `AbstractToolInterface`, no `New*`/`Legacy*`/`*Wrapper`/`Enhanced*`.
- Comments explain WHAT the code does or WHY it exists — never what it replaced or how it's "improved".
- YAGNI. Smallest reasonable change. No speculative abstractions, flexibility, or configurability beyond what the current item needs.
- No backward-compatibility shims.
- License: AGPL-3.0. Anything commercial goes in `/ee` only; core must never import from `/ee`.

## Verification
- Every `progress.md` item has a **Verify** line; it must actually be executed before the box is checked.
- Prefer test-first: turn each item into a failing test or check, then make it pass.

## Git
- Work directly on `main`. Small, frequent commits; push after every commit.
- The `progress.md` update ships in the same commit as the work it records.
- Never force-push. Never commit secrets — `.env` is gitignored.

## Cloudflare safety
Shared production account (DevPlant). Touch only `opas-*` resources. Never modify the `opas-landing` worker, the `opas.dev` root/`www` custom domains, or any other zone or worker.

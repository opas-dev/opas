# OPAS Team Authoring v0.3 — implementation plan

**Status:** active as `progress.md` Phase 16

**Decision date:** 2026-09-03

**Goal:** make OPAS safe for a real content team to draft, review, preview, publish,
and recover articles without exposing unfinished work or losing a prior version.

**Release gate:** CROFusion can operate one isolated deployment with multiple named
team members, keep its current public help content live while changes are reviewed,
share an exact draft privately, publish one reviewed revision atomically, and recover
from a bad edit or accidental archive on every supported runtime.

## Product outcome

The release is complete when:

1. A published article remains byte-for-byte unchanged while an editor saves newer
   drafts or submits them for review.
2. Every meaningful save creates an immutable, attributed article revision.
3. A stale browser tab cannot overwrite a newer revision.
4. Restoring an older revision creates a new draft; it never rewrites history or
   changes production immediately.
5. A signed preview always renders one exact saved revision, its exact retained OPAS
   assets, and its saved remote-image URLs; it can be revoked, expires automatically,
   and is absent from every discovery and analytics surface.
6. Named administrators, editors, and reviewers have a small fixed permission set
   enforced inside every page, route, and Server Action.
7. Review and publication decisions identify the exact actor and revision.
8. Archived articles can be restored with their history and assets intact.
9. Docker/Postgres, Cloudflare/D1, and Vercel/Neon retain one behavior contract.

## Why the persistence model must change first

Today, `articles` is both the editing record and the public record. The article save
action replaces that row and its active assets, and the evidence pipeline follows the
same mutation. This creates three problems that UI alone cannot solve:

- editing a published article either changes it immediately or takes it offline;
- two open editor tabs can silently overwrite one another;
- an image removed from the current article can be deleted even if an older version
  still references it.

The authenticated live preview also compiles unsaved form input for the current
administrator. It is intentionally not a stable or shareable review surface. The
current authentication token represents one environment-configured administrator,
so it cannot attribute changes or revoke one person's access independently.

Phase 16 therefore begins with separate working and published revisions. The existing
`articles` row remains the materialized public projection so public reads, search,
SEO, MCP, and RAG keep one small, proven boundary.

## Fixed invariants

- `article_revisions` rows are append-only. Application code never updates or deletes
  one while its parent article exists.
- Every article committed through migration or the domain repository has exactly one
  current working revision. It may independently have one published revision.
- `articles` and `article_assets` describe only the materialized public revision after
  first publication. For a never-published compatibility row, only its draft slug may
  track the working slug so the existing uniqueness constraint does not reserve stale
  URLs; the row remains excluded from every public read.
- A publish transaction selects one revision ID, copies that snapshot into the public
  projection, switches the published pointer, updates assets, and replaces evidence.
- A revision number is a persisted optimistic-concurrency token. Timestamps and the
  current MDX content hash are not concurrency tokens.
- Rollback is append-only: restoring revision 4 while revision 9 is current creates
  revision 10 with `restored_from_revision_id = revision_4`.
- A signed preview grant refers to a revision ID, never an article's moving head or
  unsaved browser state.
- Historical assets stay private. They are readable only by an authenticated team
  member or a valid preview grant for a revision that references the asset.
- Editing, review, publication, preview, team, theme, import, and quality mutations
  each perform an authoritative database-backed permission check.
- Every content-bearing mutation also checks a durable workspace authoring fence in
  the same atomic operation. A process restart or old-but-compatible deployment cannot
  bypass a production write freeze.
- Public routes never query working revisions, review records, member records, or
  preview grants.

## Data model

All tables and constraints are identical in the Postgres and SQLite schemas.

### `article_heads`

The existing `articles` schema stays as the public materialization. A separate
one-row-per-article head record carries authoring workflow state:

| Column | Contract |
| --- | --- |
| `article_id`, `workspace_id` | Composite primary identity and workspace-safe parent reference. |
| `working_revision_id` | Non-null pointer to this article's latest saved revision. |
| `working_revision_number` | Monotonic integer starting at 1; used for compare-and-swap writes. |
| `working_slug` | Current draft URL, coupled to this article's working slug claim. |
| `published_revision_id` | Nullable pointer to the materialized or last-published revision; live status remains in `articles`. |
| `published_revision_number` | Nullable number coupled to the published revision ID. |
| `review_state` | `editing`, `in_review`, `changes_requested`, `approved`, or `published`. |
| `submitted_by_member_id` | Same-workspace member attribution; non-null exactly while `review_state` is `in_review`. |
| `archived_at` | Nullable timestamp; archived articles are absent from all public and normal admin lists. |
| `archived_by_member_id` | Nullable member attribution for recovery history. |

For an article with no newer draft, the working and published pointers match and the
review state is `published`. Creating a revision from a published article advances
only the working pointer and changes the review state to `editing`; the materialized
public fields, public assets, and published pointer do not move. Keeping the pointers
outside `articles` avoids a circular backfill and lets a prior application version
continue reading the public projection after the expand-only migration.
Submitting stores the current member in `submitted_by_member_id`; withdraw,
request-changes, approval, publication, and every other exit from `in_review` clear it
in the same transaction.

A never-published article initially materializes revision 1 with public status `draft`
to satisfy the existing row contract, but subsequent admin reads come from its head.
Later private revisions update only that compatibility row's slug together with the
head and its slug claim; first publication replaces the complete row from the reviewed
revision. Final publication rechecks the claim inside its transaction.

The migration order is explicit: create the additive tables, copy each existing
`articles` row into baseline revision 1, copy its `article_assets` associations, then
insert its head record. New articles similarly insert the draft materialization,
revision 1, revision assets, and head in one transaction. No nullable revision pointer
is added to `articles`, so neither path has a circular foreign-key bootstrap.

Backfill is a fence-held application migration, not pure SQL. After additive DDL, the
shared canonical revision serializer reads articles with category snapshots and sorted
asset hashes in 25-row keyset chunks, computes the same Web Crypto SHA-256 revision
hash used at runtime, and derives each baseline revision ID from the versioned
workspace/article identity. Each chunk inserts idempotently; an existing deterministic
row must match byte-for-byte or the migration stops. Interruption leaves the fence
active, and retry resumes from the first missing/mismatched head. Only after full
count/hash/projection audits pass does the migration install the new-table guards and
record completion. PostgreSQL, Neon, better-sqlite3, and remote/local D1 run the same
serializer and interruption fixture.

The head primary key enforces at most one head. Portable SQLite/D1 constraints cannot
defer the inverse assertion while a new parent article and first revision are being
inserted, so exactly-one-head is a transaction-level repository invariant rather than
a claimed cross-table schema guarantee. Migration and health audits fail if any
committed article lacks its head; no route inserts an article outside that repository
transaction.

`article_revisions` exposes a unique composite key over workspace, article, revision
ID, and revision number. The working pointer and number reference that full key; the
published pointer and number are both null or reference a revision for the same
workspace and article. Database checks/triggers also require archive time and actor to
be null together, `review_state = published` to mean an unarchived live row with equal
heads, and every live public materialization to match the pointed revision's hash and
article-owned fields plus category ID. Application transactions assert the same
invariants and schema parity tests exercise them on both dialects.

### `article_slug_claims`

One table is the ownership boundary for both working and materialized URLs. Its key is
`(workspace_id, normalized_slug)` and each row names one article plus `working_claim`
and `article_row_claim` flags, with at least one flag true. A published article with a
newer renamed draft temporarily owns two rows; when both URLs match, one row carries
both flags. Unpublished and archived articles retain the article-row claim so old
public URLs and recovery cannot become ambiguous.

Save, restore, archive, unpublish, and publish lock and update claims with their head
transaction. A requested slug owned by any other article fails regardless of that
article's live/archive status. The existing `articles` unique index remains a defense
for materialized/compatibility rows, but application decisions never reconcile two
separate ownership systems. Backfill creates one dual claim per current article;
never-published compatibility rows continue moving with their working claim.

### `workspace_authoring_controls`

One row per workspace stores `writes_paused`, a monotonic fence generation, who changed
it when a database member is available, and the change time. A fence-aware v0.2 cutover
release creates this small table and database write guards on every existing authoring
table before the main migration. Its migration inserts an unpaused row for every
existing workspace; future workspace creation inserts its control row in the same
transaction. Guards fail closed when the row is missing. Every old and new article,
category, theme, import, asset-upload, preview-creation, and saved-quality
mutation must also assert `writes_paused = false` inside its transaction; seeds and
internal content helpers use the same guard. Identity, invitation, session, and member
management may continue under their normal capability checks because they cannot change
content or its public projection. Preview revocation is also allowed while paused;
preview creation is not.

Postgres/Neon mutations acquire the workspace control row before any product write;
the pause command acquires the conflicting row lock before changing the flag. D1 and
SQLite use serialized write transactions plus guard triggers. The pause commit is the
linearization point: after it commits, no guarded database write may commit. Asset
content is already a database BLOB, so upload acquires the same fence row before its
asset/manifest transaction and needs no distributed compensation. Rollout waits for
in-flight requests before comparing inventories.

The main Phase 16 migration begins with a hard precondition that every target workspace
has a paused control row. A missing or unpaused row aborts before any Phase 16 table or
data change, including on a direct migration command that skipped the operator CLI.
It never disables guards on existing tables: it backfills only newly created revision
tables, installs their guards after the backfill, and verifies them before returning.
The bootstrap/recovery commands are structurally limited to workspace/member/link rows
and cannot issue content SQL through their repository interface.

Only the operator fence command and schema migration path can bypass guards on protected
authoring tables; member bootstrap/recovery touches no such table. A paused authoring
write returns `503` with stable code `AUTHORING_PAUSED` before any authoring or asset row,
evidence generation, or index state changes. Anonymous feedback and answer analytics
may continue because they do not mutate authoring state.

### `article_revisions`

Each row stores a complete snapshot rather than a delta:

- ID, workspace ID, article ID, and monotonic revision number;
- category ID, slug, and display name at the time of the save;
- slug, title, canonical safe Markdown/MDX, FAQ flag, public author name, and position;
- deterministic revision hash covering every editable field and sorted asset hashes;
- `manual`, `import`, `rollback`, `migration`, or `seed` change kind;
- creating member ID, optional bounded change summary, and creation time;
- nullable `restored_from_revision_id` provenance.

Full snapshots keep rollback to one bounded read and one normal save, avoid a fragile
delta chain, and are well below D1's 2 MB row limit because article source is already
limited to 100 KB. History lists select summary columns only and use keyset pagination;
full MDX is fetched only for a selected comparison.

`created_by_member_id` is nullable only for `migration` snapshots, which carry a fixed
system actor label instead. Every interactive save, import, and clean-install seed
requires an active member ID. This permits baseline backfill before the first-member
bootstrap without fabricating a person while preserving attribution for all real
authoring.

The database enforces unique `(workspace_id, article_id, revision_number)` and
workspace-safe composite foreign keys. Revision category fields are an immutable
snapshot and deliberately have no foreign key to `categories`. Category deletion is
still blocked while any current working or published article uses it, including an
archived article. If a category referenced only by older history no longer exists,
restoration stops with a precise conflict instead of partially restoring the article.

Submission and publication compare the current category ID, slug, and name with the
revision snapshot while holding the category row. A category name or slug change
moves every affected `in_review` or `approved` working head to `changes_requested` and
records `category_changed`; the editor must save a new revision to capture the new
snapshot. A rename/delete racing publication therefore either completes before the
check and blocks publication or waits until the exact publication commits.

Category navigation remains workspace chrome rather than versioned article content.
A later authorized category-name change may therefore update the label around an
already published article without rewriting its article revision. Category-slug change
is blocked while any live article uses the category because it would move canonical
URLs and invalidate evidence outside publication; unpublish the affected articles
first. Category history and redirects remain outside this release. A revision preview
renders its saved category label while the rest of navigation remains current.

### `article_revision_assets`

This join table records the exact content-addressed images referenced by every
revision. Asset cleanup must consider active manifests, the public `article_assets`
projection, and revision assets before deleting a blob. An old image therefore remains
private and restorable without becoming publicly addressable.

OPAS-hosted `/api/assets/<hash>` references are byte-exact because the content-addressed
blob and revision association are retained. Allowed remote `https:` image references
store the exact URL but do not snapshot third-party bytes, so their external content
may change or disappear. Proxying remote media is outside this release.

### `article_review_events`

Append-only events record the article, exact revision, actor, action, bounded note,
and timestamp. Actions are `submitted`, `withdrawn`, `changes_requested`,
`category_changed`, `approved`, `published`, `unpublished`, `archived`, `restored`,
and `emergency_published`.

These events are product history, not a general compliance audit log. Credentials,
session tokens, request metadata, and preview bearer values are never stored in them.

### `workspace_members`

Each member has an ID, workspace, normalized email, display name, fixed role, active
or disabled status, password verifier fields, nullable creator for the sole bootstrap
administrator, and created/updated/last-login timestamps. Emails are unique within a
workspace. Members are disabled rather than deleted so revision and review attribution
remains intact.

Upgrade preflight refuses to proceed unless the current `ADMIN_PASSWORD` already meets
the new 15-code-point minimum; rotating a production credential is a separately
confirmed rollout action. Before v0.3 serves admin traffic, an operator command uses
the existing configured email and password to atomically create the first database
administrator. It refuses to bootstrap a workspace that already has a member, never
prints the password, and stores only its verifier. The application login path never
accepts environment credentials.

On an empty installation, that transaction creates the default workspace, its paused
authoring-control row, and the first administrator together. On an upgrade, it targets
one named existing workspace with a control row and zero members; ambiguous or partial
state fails without a write. Clean installations run the command between the complete
migration and application startup, then unpause and run the initial seed. Once the
first member can log in, `ADMIN_EMAIL` and `ADMIN_PASSWORD` are removed from runtime
secrets and the exact deployment allowlist while
`ADMIN_SESSION_SECRET` remains. Account recovery is another operator command with
direct database/platform authority that creates a normal expiring one-time reset or
administrator invitation; there is no hidden permanent environment superuser.

Passwords are single-factor credentials, so the implementation requires at least 15
Unicode code points, permits at least 128, permits paste and password managers, and
adds no character-class composition rules. The fixed
`opas-pbkdf2-hmac-sha256-chain-v1` scheme uses one unique 32-byte salt and six
sequential 100,000-iteration PBKDF2-HMAC-SHA-256 stages through Web Crypto. Stage one
takes the UTF-8 password and every later stage takes the prior 32-byte output. Each
stage salt is the UTF-8 scheme ID plus a NUL byte, the one-based stage number as a
big-endian 32-bit integer, and the member salt. The final output is an HMAC-SHA-256 key
that signs `opas-member-password-verifier-v1`; the stored iteration field is the total
600,000. Changing any of those values requires a distinct scheme and migration. This
preserves a sequential 600,000-round work factor while respecting deployed Workers'
100,000-iteration limit per PBKDF2 operation. The exact work factor must be benchmarked
on workerd and may only increase if the login latency and Worker CPU gates still pass.
These choices follow current
[NIST password guidance](https://pages.nist.gov/800-63-4/sp800-63b.html) and the
[OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

### `member_invitations`

An administrator creates a one-time invitation for an email and role. Each record is
typed as `invite` or `credential_reset`; resets also name the existing member. The
database stores only a digest of a cryptographically random unique 256-bit bearer
value, plus creator, expiry, accepted, and revoked timestamps. Invitations expire
after 48 hours and credential resets after one hour. Issuing a replacement atomically
revokes every outstanding link of the same kind for that email or member. The UI
displays the link once for out-of-band sharing; email delivery and self-service
password recovery are not required for this release.

Invitation and reset URLs carry the bearer in a fragment. A bounded same-origin
exchange validates `Origin` and Fetch Metadata, hashes the bearer, checks its exact
kind and active record, clears the fragment, and issues a 15-minute HttpOnly, Secure,
SameSite=Lax cookie scoped to the acceptance route. It has a deployment-specific name,
is host-only with no `Domain`, and clears on every invalid terminal response. Its
signed claims use a dedicated HKDF-derived subkey and strict workspace, record ID,
kind, audience, issued-at, and expiry values; cookie expiry cannot exceed database
expiry. Acceptance rechecks and consumes the record atomically. Raw or encoded bearers
never enter a URL request, referrer, database row, rendered HTML, error, or log.

Accepting an invitation sets the display name and password, activates the member, and
invalidates the invitation atomically. An administrator can issue a fresh one-time
reset link, which revokes the member's active sessions in the same transaction.

### `admin_sessions`

Each signed administrator cookie carries a random session ID. The database stores that
ID, workspace, member, creation and expiry times, and an optional revocation time, but
never the signed cookie. Logout revokes the current row. Disabling a member, changing
a role, or resetting credentials revokes every active row for that member atomically.
Expired rows are removed opportunistically in bounded batches.

### `admin_login_windows`

Login admission is durable across isolates and deployments. Rows use workspace,
dimension, keyed digest, fixed window start, count, and expiry. A daily rotating
HMAC-SHA-256 subkey derived from `ADMIN_SESSION_SECRET` hashes the canonical client
address and normalized submitted email; raw addresses and emails are neither stored
nor logged. Cloudflare uses its edge-provided `CF-Connecting-IP`, Vercel uses its
platform-provided `x-vercel-forwarded-for`, and the production Docker profile puts the
app on a private network behind a small proxy that strips and rebuilds the trusted
client-address header. Missing or malformed source identity fails closed outside
local development. The platform contracts are documented by
[Cloudflare](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip)
and [Vercel](https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for).

The fixed policy is 20 attempts per source per ten minutes, five failures per
source/principal pair per 15 minutes with a one-, two-, four-, eight-, then 15-minute
cooldown, a 30-failure-per-principal-per-hour risk counter, and a 600-attempt
workspace emergency ceiling that expires after one minute. Source and source/principal
limits reject requests; the principal counter never globally locks an account, so a
valid credential from an allowed source can recover immediately. The workspace ceiling
does not extend itself on rejected attempts. Rows expire within 24 hours and cleanup is
bounded.

Every path performs the same bounded verifier work and returns the same response for an
unknown, disabled, locked-source, or wrong-password identity. A valid login clears only
that source/principal failure state. Optional process-local duplicate suppression may
reduce bursts but is never an authorization or availability control.

### `article_preview_grants`

A grant stores a cryptographically random unique 256-bit ID, workspace, revision ID,
creator, fixed expiry, revoked metadata, and creation time. Collision causes a bounded
regeneration and then a fail-closed issuance error. It does not store the signed bearer
token. Only one active grant is needed per revision; rotating it revokes the prior
grant. Grants expire seven days after creation.

A cross-dialect partial unique index permits only one `revoked_at IS NULL` grant per
workspace/revision. Rotation locks the article head, marks any current or expired grant
revoked, then inserts the replacement in one transaction; the unique index is the
backstop. Concurrent rotations serialize, and after both return only the last committed
token remains valid.

Grant creation requires a non-archived head and an active creator. Archiving an article
or disabling the grant's creator revokes its active grants in the same transaction.
Every preview page and asset request rechecks both conditions, so a disable/archive
race cannot leave a usable response after the revocation transaction commits.

The signed token uses a separate deployment-specific `OPAS_PREVIEW_SIGNING_SECRET` and
strict issuer, audience, algorithm, grant ID, workspace ID, revision ID, issued-at, and
expiry claims. Token and cookie expiry may never exceed the database grant expiry.
Generic OPAS, CROFusion, Docker, and Vercel deployments use different secrets.
Preview-key rotation must not sign administrators out, and session-key rotation must
not implicitly publish or expose a preview.

## Permissions

The UI may hide unavailable controls, but this matrix is enforced again at the data
access boundary for every request.

| Capability | Administrator | Editor | Reviewer |
| --- | :---: | :---: | :---: |
| Read content, history, analytics, and quality data | Yes | Yes | Yes |
| Create and edit drafts | Yes | Yes | No |
| Import content as drafts | Yes | Yes | No |
| Submit or withdraw a revision | Yes | Yes | No |
| Create or revoke a preview for an exact revision | Yes | Yes | Yes |
| Request changes or approve a submitted revision | Yes | No | Yes |
| Publish an approved revision | Yes | No | Yes |
| Publish without another person's approval | Emergency action | No | No |
| Unpublish or archive an article | Yes | No | Yes |
| Restore a revision or archived article as a draft | Yes | Yes | No |
| Manage categories | Yes | Yes | No |
| Run and review saved quality evaluations | Yes | No | Yes |
| Change the runtime theme or topic policy | Yes | No | No |
| Invite, disable, reset, or change another member | Yes | No | No |

No member, including an administrator, can normally approve a revision they created
or submitted under any role. A reviewer or a different administrator may approve and
publish in one UI action, but the transaction first records approval for that exact
revision and publishes that same ID. When a second person is unavailable, an
administrator must use the clearly labeled emergency publish path; its distinct event
and required reason make the exception visible.

The last active administrator cannot be disabled or demoted. Disabling a member,
resetting credentials, or changing a role revokes all of their active sessions so the
next authoritative check fails.

## Session and authorization contract

The existing signed eight-hour cookie remains, but its subject becomes a member ID and
its claims include only workspace ID and a random session ID in addition to the strict
issuer, audience, issued-at, and expiry claims. It contains no email, display name,
password data, or role. The active session and current role are loaded from the
database on every protected operation, so logout, revocation, and role changes take
effect immediately.

Proxy performs only the existing optimistic redirect/signature check. Pages, Route
Handlers, Server Actions, preview management, imports, uploads, theme changes, and
quality mutations call one centralized authorization layer and request an explicit
capability. This follows Next.js guidance that Proxy is not the authoritative access
control boundary and protected resources must verify authorization at the data layer:
[Next.js authentication guidance](https://nextjs.org/docs/app/guides/authentication).

Login keeps one generic failure response, uses bounded request sizes and constant-time
verifier comparison, and applies the durable source, source/principal, principal, and
workspace windows. Logs contain only stable error codes, never addresses, emails,
password input, invitation values, or tokens.

## Revision and publication workflows

| Current state | Action | Actor | Result |
| --- | --- | --- | --- |
| New or `published` | Save changed content | Administrator/editor | New revision; `editing`; existing live revision stays live. |
| `editing` or `changes_requested` | Save changed content | Administrator/editor | New revision; `editing`; existing live revision stays live. |
| `in_review` | Save changed content | Any member | Rejected; submitter must withdraw first. |
| `editing` or `changes_requested` | Submit | Administrator/editor | Same revision becomes `in_review`. |
| `in_review` | Withdraw | Submitting administrator/editor | Returns to `editing`. |
| `in_review` | Request changes | Different active administrator/reviewer | Same revision becomes `changes_requested`; note recorded. |
| `in_review` | Approve | Different active administrator/reviewer | Same revision becomes `approved`. |
| `approved` | Edit | Administrator/editor | New revision becomes `editing`; approval is superseded. |
| `approved` | Publish | Administrator/reviewer | Exact approved revision becomes `published`. |
| Any non-archived private state | Emergency publish | Administrator | Exact working revision becomes `published`; reason recorded. |
| Any state with a live published revision | Unpublish | Administrator/reviewer | Public projection becomes private; pointer/history remain; working state is preserved or becomes `approved` when both heads match. |
| Any non-archived state | Archive | Administrator/reviewer | Public projection becomes private; history/assets remain; working state is preserved or becomes `approved` when both heads match. |
| Archived | Restore | Administrator/editor | Returns as an unpublished `editing` draft. |

Archive is orthogonal to the review state. While `archived_at` is set, only authorized
read/history and Restore are allowed; save, submit, review, publish, emergency publish,
unpublish, and new preview-grant creation fail without a write.

### Save a draft

1. Authenticate the member, require draft-edit permission, and reject archived or
   `in_review` heads.
2. Validate the submitted expected working revision number.
3. Validate the complete article through the current safe-MDX, title, category, URL,
   and asset contracts.
4. In one transaction, assert the expected working revision, reject an exact no-op,
   insert the next immutable snapshot and revision assets, advance the working pointer,
   and set the review state to `editing`.
5. Return the new persisted revision number so the editor can make another save.

The public materialization, published pointer, public assets, evidence chunks, index
generation, embedding jobs, sitemap, Markdown, MCP, and answer corpus do not change.

If another tab won the race, the save returns a typed conflict. OPAS preserves the
local form state and offers reload/compare; it never auto-merges or overwrites. A failed
save also preserves or explicitly resolves the existing staged-asset lifecycle.

### Submit and review

Submitting pins the exact current revision. While it is `in_review`, an editor cannot
alter it; the editor may withdraw it to continue editing. A review action names that
same revision and expected review state.

- Request changes records a bounded note and moves the article to
  `changes_requested`.
- Approve records the reviewer and moves the exact revision to `approved`.
- Any subsequent edit creates another revision and invalidates the approval.
- Publish requires the approved revision ID, not whichever revision is newest when the
  button is clicked.

### Publish and unpublish

Publishing performs one atomic operation:

1. Revalidate current MDX policy, exact category ID/slug/name snapshot, slug ownership,
   revision assets, actor permission, approval, and the expected working revision while
   locking the category and head rows.
2. Copy that revision into the existing `articles` public materialization.
3. Replace `article_assets` with the revision's exact assets.
4. Prepare and commit evidence for the exact public path and content hash.
5. Advance the published pointer, retain the first-published timestamp, set public
   status to published, set review state to published, and append the event.

Failure rolls back every step. Unpublishing leaves history and the last published
pointer intact but changes public status, invalidates evidence, and removes the article
from all public projections atomically.

### Compare and restore

The article editor exposes History with the newest 20 summaries and bounded keyset
pagination. A revision detail screen renders:

- actor, exact time, change kind, workflow/publication markers, and summary;
- metadata fields that changed from the preceding revision;
- an accessible line-oriented source diff with text and icons in addition to color;
- a read-only rendered snapshot using the existing safe compiler.

Diff content renders as React text, never raw HTML. A small maintained text-diff package
may be added after checking its exact current version and browser footprint; OPAS does
not need to invent a diff algorithm.

“Restore as draft” revalidates the selected snapshot against current rules and creates
a new working revision with the old fields and assets. It does not publish. Missing
categories or assets, a now-conflicting slug, unsafe historical syntax, or a stale head
produces a precise no-write result. The restored draft then follows normal review.

### Archive and restore

The current permanent-delete UI becomes Archive. Archiving makes the article private,
invalidates public evidence, revokes its active preview grants, and records the actor,
but retains revisions and assets. Restoring returns it as an unpublished working draft.
Archived heads retain their working and last-public slug claims so another article
cannot make restoration ambiguous. Physical purge, retention policy, and legal holds
wait for real storage and compliance requirements.

### Imports, migration, and installation seeds

Imports are always private authoring. The planner reports incoming `status: published`
as an explicit normalization to draft, and activation creates working revisions only;
it never calls publication, changes the public materialization, or queues evidence.
Publication still requires the normal review flow or a separately reasoned emergency
publish. A published-marked import fixture is a required negative test.

This release keeps imports create-only: they never match or update an existing article
or category by slug, path, title, or source metadata. Planning captures all current
public and working slug claims; atomic activation rechecks them before inserting. A
claim introduced by an editor save, rename, restore, review, or archive after planning
is a typed import conflict, and one conflict aborts the complete import without
superseding any working/reviewed revision or partially consuming staged assets.

Migration maps an existing published row to revision 1 with equal working/published
heads and `published` state; an existing draft gets revision 1, a working head, no
published pointer, and `editing` state. A clean-install seed runs only after the first
administrator bootstrap and only when the workspace has zero articles and revisions.
It attributes revision 1 to that administrator and publishes through the same emergency
publication transaction with reason `initial demo seed`. Once any article exists,
re-running seed is verification-only and cannot recreate, update, publish, or append
history. The complete category, theme, article, revision, asset-association, event,
public-evidence, job, and content-addressed asset BLOB seed is one database transaction
on both dialects. A failed commit leaves zero seed rows, so retry still observes an
empty workspace and can safely repeat. A committed seed is therefore complete, and an
interrupted pre-commit seed remains recoverable.

## Signed-preview flow

The shared link uses a URL fragment, for example `https://host/preview#<signed-token>`.
Fragments are not sent in the HTTP request. A small client exchange page reads the
fragment, posts it once to a bounded same-origin endpoint, clears the fragment from
history, and receives an HttpOnly, Secure, SameSite=Lax cookie scoped to `/preview`.
The cookie has a deployment-specific name, is host-only with no `Domain`, and sets
`Max-Age`/`Expires` no later than both token and database-grant expiry. Any expired,
revoked, archived, disabled-creator, workspace, or revision mismatch clears it.
This keeps the bearer value out of request paths, query strings, referrers, access logs,
database rows, rendered HTML, and error messages.

Every preview page and preview-asset request then:

1. verifies the cookie signature and strict claims with the preview-specific key;
2. loads the active, unexpired, unrevoked grant;
3. matches the grant's workspace and revision exactly and rechecks the non-archived
   article plus active creator;
4. renders only that revision and only assets joined to it.

Before compilation, the preview renderer rewrites only canonical stored
`/api/assets/<hash>` references to `/preview/assets/<hash>`. That scoped endpoint checks
the grant, exact revision, and `article_revision_assets` row before returning the blob.
Saved remote `https:` URLs remain unchanged and load under the existing image policy
and `no-referrer` response policy; OPAS does not promise byte stability for them. The
sharing dialog lists those external hosts and warns that loading the preview reveals
the viewer's IP address and timing to them. Browser acceptance proves no OPAS path,
grant, cookie, or referrer accompanies the remote request.

The preview resembles the public article but carries a persistent “Private preview”
banner with revision, saved time, and expiry. It has no search, assistant, feedback,
view beacon, support handoff, canonical metadata, JSON-LD, public page actions, or
links into other drafts. Internal article links resolve to the currently public site.

Responses set `Cache-Control: private, no-store`, `X-Robots-Tag:
noindex, nofollow, noarchive`, `Referrer-Policy: no-referrer`, and the normal
unframeable security policy. They never enter sitemap, llms documents, per-article
Markdown, search, MCP, RAG, analytics, or browser prefetch. Next.js Draft Mode is not
used: it enables a browser-wide build-specific cookie, while OPAS needs a revocable
grant bound to one immutable revision. See the current
[Next.js Draft Mode contract](https://nextjs.org/docs/app/api-reference/functions/draft-mode).

## Admin experience

The content list gains four task-oriented filters: Needs review, Drafts, Published,
and Archived. A row can independently say “Published revision 6” and “Draft revision
8,” making it clear that live content is safe while work continues.

The editor replaces the draft/published select with explicit actions:

- Save draft;
- Submit for review or Withdraw from review;
- Share preview / Revoke preview;
- Review changes, Request changes, and Approve and publish for reviewers;
- Emergency publish for administrators, behind a separate confirmation.

The sticky save bar shows the persisted revision and unsaved state. Conflicts retain
the user's full input, focus the conflict message, and offer “Compare with revision N”
and “Reload latest.” Review notes, history, and team management use semantic tables or
lists on wide screens and preserve a usable linear order on narrow screens.

The Team screen lets administrators create a one-time invitation, copy it, change a
role, disable/reactivate a member, and issue a credential reset. The current member's
name and role appear in the admin header. Every destructive or public action names its
effect before confirmation; ordinary draft saves do not use confirmation dialogs.

## Principal code paths

| Area | Existing paths that must change |
| --- | --- |
| Cross-dialect schema | `src/db/schema/postgres.ts`, `src/db/schema/sqlite.ts`, both Drizzle migration trees |
| Domain contract | `src/db/repository.ts`, a focused revision/workflow domain module |
| Atomic persistence | `src/db/postgres/repository.ts`, `src/db/sqlite/repository.ts` |
| Article validation and evidence | `src/content/mdx-safety.ts`, `src/content/article-evidence.ts`, existing evidence repository statements |
| Authoring actions | `src/app/admin/content/actions.ts`, `src/app/admin/content/validation.ts` |
| Authoring interface | `src/app/admin/content/article-editor.tsx`, article pages, content list, new History and Reviews routes |
| Identity and permissions | `src/auth/*`, `src/proxy.ts`, login actions, every current `requireAdmin` call site |
| Team interface | new `/admin/team` page and invitation/reset handlers |
| Preview | current unsaved preview remains; new `/preview` exchange, revision page, and scoped asset route |
| Import and seeds | `src/import/execute.ts`, import activation route, Postgres/SQLite seeds, both D1 SQL seeds |
| Deployment | environment template, Docker preparation, both Wrangler configs/bootstrap, Vercel environment allowlist, artifact scans, runbooks |
| Verification | repository/auth/content/import/security tests, native D1 checks, smoke script, browser acceptance |

The public publication loaders remain deliberately small. They continue to consume
the `articles` materialization and must not gain a fallback to working revisions.

## Dependency-ordered implementation

The numbered items below are tracked as active `progress.md` Phase 16 work.

### 16.1 Freeze contracts and fixtures

Specify the working/published state machine, capability matrix, immutable snapshot
format, revision hash, event vocabulary, preview claims, and migration fixtures before
changing persistence.

**Verify:** focused contract tests prove private edits cannot affect public output,
publish selects an exact revision, rollback always appends, stale writers cannot win,
preview grants cannot follow a moving head, self-approval is rejected, and every
mutation maps to one server-enforced capability.

### 16.2 Install the durable authoring fence

Add `workspace_authoring_controls` and database guards in a v0.2-compatible migration,
then make every existing mutation honor the fence before any other Phase 16 schema
change. Add an operator command to pause, inspect, and resume a named workspace. Build,
install, and verify the cutover release for both Cloudflare Workers, the maintained
Vercel deployment, and Docker before the corresponding database can accept any Phase
16 write.

Also create a distinct maintenance rollback artifact from the same public v0.2 code and
fence guards. It hard-disables every `/admin` and login route in code, contains no code
that reads environment-admin credentials, omits those bindings from its deployment
configuration, and exposes only public reads plus health. The code boundary remains
closed even if a platform snapshot or operator supplies historical credentials. Upload
and retain its exact Cloudflare version and Vercel deployment without routing
production traffic, and tag its Docker image. This maintenance artifact—not the active
cutover deployment—is the sole application rollback target after any Phase 16 write.
Cloudflare explicitly supports uploading a Worker version without deploying it:
[Workers versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/).

**Verify:** setting the fence blocks every existing v0.2
article/category/theme/import/asset/quality write across fresh processes with
`AUTHORING_PAUSED`, while public reads, login/session bookkeeping, feedback, and answer
analytics remain available; after the pause transaction commits, no guarded database
write commits; drained calls leave authoring, asset, evidence, and index tables
unchanged. The maintenance artifact returns an explicit maintenance response for
anonymous, stale-cookie, and forged-cookie admin requests on every target and cannot
execute an authoring repository method even when old environment credentials are
injected.

### 16.3 Add cross-dialect schema and backfill

Add matching members, login windows, sessions, invitations, revisions, revision
assets, review events, preview grants, slug claims, and article head records. Backfill
every existing article as revision 1, copy its asset associations, and set its pointers
from current state without altering public content, assets, evidence, timestamps, or IDs.
Make the migration expand-only, run its shared application hash/backfill while the
durable fence is active, and install final guards only after the audit passes.

**Verify:** fresh and populated databases migrate on Testcontainers PostgreSQL,
better-sqlite3, and native Wrangler local D1; schema parity and Drizzle no-drift checks
pass; a row-by-row before/after projection is identical; a second migration changes
nothing; published and draft rows receive the exact defined head state; head
ID/number, archive, review, and public-materialization constraints reject the portable
invalid states, while the post-transaction audit detects a missing head; all
foreign-key checks are empty. A missing or unpaused control row makes direct migration
fail before any Phase 16 schema or data delta. Forced interruption after each backfill
chunk resumes to the same deterministic IDs and hashes without duplicate history.

### 16.4 Introduce named membership and authorization

Bootstrap the current configured administrator through the operator command, add
fragment-exchanged invitation/reset acceptance, password verification, member
disable/reactivation/reset, database-revocable sessions, centralized capabilities,
and durable login admission. Replace generic `requireAdmin` calls with exact
capabilities rather than leaving an alias layer.

**Verify:** authentication and the complete route/action matrix run for each role;
direct requests cannot bypass hidden controls; disabled, forged, stale, wrong-workspace,
and role-changed sessions fail before reads or writes; last-administrator protection
holds under a race; multiple repository/process instances share every limit; source
flooding cannot lock a member from a different allowed source; the operator bootstrap
is one-time. Invitations and resets reject replay, expiry, revocation, wrong kind,
wrong audience, and cross-origin exchange without bearer leakage. Bootstrap and
last-administrator recovery run on Postgres, Neon, local D1, and isolated remote D1.

### 16.5 Add atomic revision saves

Make editor creation, ordinary saves, and imports create immutable snapshots and exact
revision assets. Require the expected working revision on updates, atomically maintain
the working-slug claim, return the new number, classify conflicts, and leave a prior
public materialization alone.

**Verify:** 12 simultaneous saves with one expected revision accept exactly one and
return 11 typed conflicts on both dialects; no-op, rejected, and failed writes leave
workflow, history, manifests, assets, evidence, and index generation unchanged;
removed images remain private but revision-readable; a second save from the successful
browser state succeeds. New-article, draft-rename, cross-article concurrent save,
restore, and publish tests cannot produce duplicate working or live slugs; a
never-published compatibility row releases its stale slug.

### 16.6 Separate review from publication

Implement submit, withdraw, request-changes, approve, emergency-publish, publish, and
unpublish transitions pinned to the expected revision and state. Make publication the
only operation that changes the materialized public article, public assets, and
evidence.

**Verify:** edit-after-submit, edit-after-approval, concurrent review, double-submit,
self-approval, stale publish, and member-disable races cannot publish an unreviewed
revision; the fixed public-response hash set is unchanged after ten private saves; one
publish changes every affected surface together and schedules evidence exactly once
on both dialects. Category name/slug/delete versus submit/publish races either preserve
the exact snapshot or invalidate/block it without a public delta; a live category slug
cannot change or stale its evidence. An import containing
`status: published` produces only private revisions and no evidence/public change;
import-versus-save/rename/restore activation races abort the entire create-only import
without touching an existing `editing`, `in_review`, `approved`, or archived head.

### 16.7 Add history, comparison, rollback, and archive recovery

Build bounded history/detail views, safe diffs, restore-as-draft, Archive, and restore
from Archive. Preserve history and old assets until a later explicit retention policy.

**Verify:** restoring revision N creates N+1 and keeps all prior rows immutable; the
former head can subsequently be restored; missing category/asset, unsafe historical
MDX, slug conflict, stale request, and double-click cases make no change; archive makes
all public surfaces 404/absent and restoration returns a private draft with intact
history and images.

### 16.8 Add revision-pinned signed previews

Add the preview key contract, grant lifecycle, fragment exchange, scoped cookie,
revision renderer, revision-scoped asset endpoint, and preview management UI.

**Verify:** unit and live HTTP tests reject wrong algorithms, claims, signature,
deployment, workspace, revision, token/grant expiry mismatch, revocation, grant-ID
collision exhaustion, archived article, disabled creator, and asset; archive/disable
races cannot serve a later page or asset response. Two simultaneous rotations leave
one active row and only the last committed token works. The host-only deployment cookie has
no `Domain`, never outlives token/grant expiry, and clears on rejection. The bearer
value is absent from request URLs, referrers, database, logs, HTML, and errors; headers
are no-store/noindex/no-referrer/unframeable; previewed text remains absent from search,
sitemap, llms, Markdown, MCP, analytics, RAG, and public assets. Canonical stored asset
URLs are rewritten to the scoped route; a remote URL is preserved, disclosed, and
sends no OPAS URL, token, cookie, or referrer.

### 16.9 Complete team-authoring UX and accessibility

Finish content filters, dual working/published status, review actions and notes,
conflict recovery, history/diff, preview sharing, Team management, responsive states,
and concise task copy.

**Verify:** browser checks at 1,440, 768, 390, and 320 pixels cover keyboard-only use,
focus placement/return, screen-reader labels and live regions, non-color-only state and
diffs, reduced motion, light/dark themes, two-tab conflicts, expired/revoked preview,
long history, empty/loading/error states, zero horizontal overflow, and clean browser
diagnostics except for the already documented Cloudflare Browser Insights beacon that
the intentional same-origin CSP rejects; no additional warning or error is accepted.

### 16.10 Integrate every bypass path and deployment target

Split migration-only, deployment-only, seed-reconciliation, and evidence-initialization
commands so a paused cutover never invokes a guarded content write. Update Postgres and
SQLite seeds, both D1 SQL seeds, imports, asset cleanup, Docker's trusted ingress,
Cloudflare bootstrap/config/type generation, Vercel's explicit environment allowlist,
artifact secret scans, environment template, smoke scripts, and deployment runbooks.
Make disposable Vercel target naming version-neutral.

**Verify:** a clean seed requires the bootstrap administrator, creates revision 1, and
uses the emergency-publication transaction; repeated seeds preserve changed content
and history without adding a row or event. Failure after each database statement leaves
either zero seed rows or the complete seed transaction, and retry succeeds.
Migration-only and deploy-only commands
succeed while paused and never run seed/evidence work. The fixed 100-article import
stays atomic and uses no more than 800 D1 statements/queries in one invocation; the
preview secret appears only in approved runtime-secret surfaces; every Phase 16 product
mutation has both the application fence check and database guard, including preview
creation, revision, review, and archive writes; identity/team writes and preview
revocation follow their explicit paused-state exception; complete lint, typecheck, tests,
Next, OpenNext, Docker, and Vercel builds pass.

### 16.11 Cross-target acceptance and release

Run clean install, upgrade, rollback, browser, and concurrency acceptance on Docker;
an isolated Cloudflare Worker/D1 pair; and a disposable Vercel/Neon pair. Freeze a
CROFusion team-authoring fixture with at least one administrator, editor, and reviewer.

**Verify:** all three targets pass draft/live isolation, concurrent saves, review,
publish, rollback, archive recovery, anonymous signed preview, historical images,
role revocation, accessibility, security headers, seed preservation, and application
rollback. After a separate production confirmation, record independent D1 Time Travel
bookmarks and Worker versions, deploy generic then CROFusion, smoke canonical and
workers.dev URLs, and publish the exact green release tag.

## Fixed acceptance fixture and measurements

The committed `team-authoring-standard` fixture removes subjective release calls. It
contains one administrator, one editor, one reviewer, two categories, one published
article with a table, internal article link, two stored images, and one remote `https:`
image; one near-100-KB draft; one archived article; and a deterministic 100-article
import. Secrets and bearer values are generated per test run and never committed.

The release records these exact measurements:

- **Concurrency:** 12 simultaneous saves submit the same expected revision; exactly
  one succeeds, 11 return the typed conflict, and the revision count increases by one.
- **Password cost:** local workerd and an isolated Workers deployment each run five
  warmups followed by 20 externally timed requests containing exactly one
  600,000-round staged PBKDF2 verification; end-to-end p95 is at most one second and
  no request reaches its Worker CPU limit.
- **Draft isolation:** request the baseline twice and prove the chosen payload is
  deterministic before hashing. Compare canonicalized semantic DOM for the public
  article/category/home `<main>` regions, stable serialized public result records,
  canonicalized search JSON, sorted sitemap URLs, canonicalized extracted JSON-LD,
  byte-exact llms and article Markdown output, canonicalized MCP resources, and sorted
  evidence/index rows. All hashes remain identical after ten private saves. Transport
  headers, CSP nonces, and request IDs are excluded; no other field may be normalized
  away.
- **D1 import budget:** instrumentation records at most 800 D1 statements/queries for
  the deterministic 100-article import, leaving headroom below the paid-Worker
  per-invocation limit documented in [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
  A preflight must confirm the selected isolated and production Workers use the paid
  limit by deployment metadata or a bounded 51-query live probe; the release stops on
  a Free-plan target rather than attempting the import.
- **Bearer hygiene:** use unique canary invitation, reset, and preview bearers; retain
  the test capture through ten minutes after expiry or revocation; and search the raw,
  URL-encoded, and base64url forms across application logs, Cloudflare Worker
  observability/tail, Vercel runtime logs, browser network URLs and referrers,
  deployment logs, and database query logs. Only the expected one-way database digest
  may remain.
- **Expiry:** token issue/verify and repository operations receive an injected clock in
  unit/integration tests. Live HTTP tests issue a normal artifact, use the operator
  acceptance-fixture command—which refuses a production host—to move its database
  expiry into the past, and separately submit a correctly signed canary whose token
  `exp` is already past. All cases finish without waiting for production lifetimes and
  reject both page and asset/acceptance requests.
- **Recovery:** bootstrap and last-administrator recovery commands complete on
  Testcontainers Postgres, Neon, local D1, and isolated remote D1. Their one-time links
  pass acceptance, replay, expiry, replacement-revocation, and log scans; noninteractive
  execution refuses to print a bearer into captured automation logs.
- **Application rollback:** record and restore the exact maintenance Worker version,
  Vercel deployment ID, and Docker image digest. Public smoke passes; `/admin` and login
  remain hard-disabled even with injected historical credentials; and every authoring
  write remains blocked by the durable fence.

## Production rollout and rollback

Migrations are expand-only because rolling a Worker or Vercel function back does not
roll its database back. The existing `articles` public projection lets the old public
application remain readable after schema expansion. The only valid rollback target is
the recorded fence-aware v0.2 maintenance artifact with admin code paths disabled; the
active cutover deployment and every pre-fence build are forbidden after a database has
accepted Phase 16 writes.

After a separate production confirmation, the production sequence is:

1. deploy the fence-aware v0.2 cutover release with `writes_paused = false` to generic
   OPAS and CROFusion, smoke every guarded mutation and the public site, then upload the
   separate admin-disabled maintenance Worker version without routing traffic to it;
2. record independent D1 Time Travel bookmarks, exact active and maintenance Worker
   version IDs, configuration digests, and current secret-name sets for both deployments;
3. set `writes_paused = true` for one workspace, wait for in-flight writes to drain,
   and prove each guarded mutation returns `AUTHORING_PAUSED` with no state delta;
4. run the migration-only command and verify that workspace's additive backfill, then
   run the one-time administrator bootstrap command, add
   `OPAS_PREVIEW_SIGNING_SECRET`, remove `ADMIN_EMAIL`/`ADMIN_PASSWORD` from runtime and
   its exact secret allowlist, and run the deployment-only v0.3 command; complete
   public-projection equality plus administrator login/read smoke while authoring
   remains paused—no seed or evidence reconciliation runs in this step;
5. resume authoring only after current heads, public projections, revision counts,
   asset joins, evidence generations, and secret bindings match, run the guarded
   seed/evidence reconciliation, then create the editor and reviewer through normal
   one-time invitations and run one controlled all-role draft/review/publish/restore
   acceptance cycle;
6. repeat steps 3–5 independently for the other deployment and publish the exact green
   tag only after both canonical and workers.dev URLs pass.

Cloudflare documents that D1 `batch()` executes as a transaction and rolls the whole
batch back if one statement fails, which supports atomic revision/publication changes:
[D1 batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
D1 Time Travel remains the disaster-recovery boundary for an independently confirmed
database restore, not the ordinary migration strategy:
[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

For application rollback, activate the durable fence first, restore the exact recorded
admin-disabled maintenance Worker version, Vercel deployment, or Docker image, and
smoke the public site plus the hard-disabled admin/login routes. The operator command
remains the only control path. Keep all authoring writes paused until v0.3 is repaired
and redeployed; leave the additive schema in place. A database Time Travel restore is
destructive and therefore always requires a new, exact confirmation even when the
release rollout was already approved.

## Explicit non-goals

- Real-time co-editing, presence, CRDT/OT, or automatic conflict merging.
- GitHub sync; it consumes these revision/conflict semantics in the following release.
- Inline discussion threads, arbitrary custom roles, or generalized compliance audit
  exports.
- Category and theme revision history.
- Scheduled publishing, content branching, or multilingual variants.
- SAML, SCIM, MFA, passkeys, private reader accounts, or permission-scoped RAG.
- Email-based invitation delivery or self-service password recovery.
- Physical article purge, automatic revision pruning, legal holds, or retention policy.
- Multi-tenancy, ticketing, inboxes, or live-agent chat.

These boundaries keep the release focused on safe article ownership. Revision counts
and retained asset bytes should be observable, but pruning rules should wait for real
pilot storage data rather than guess at a destructive policy.

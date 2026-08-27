-- ABOUTME: Seeds Cloudflare D1 with the deterministic OPAS demo workspace and article.
-- ABOUTME: Uses conflict-safe statements so local and remote preparation can repeat safely.
INSERT INTO workspaces (id, slug, name)
VALUES ('workspace_demo', 'demo', 'OPAS Demo')
ON CONFLICT (id) DO UPDATE SET
  slug = excluded.slug,
  name = excluded.name,
  updated_at = unixepoch() * 1000;

INSERT INTO categories (id, workspace_id, slug, name, description, position)
VALUES (
  'category_getting_started',
  'workspace_demo',
  'getting-started',
  'Getting started',
  'The essentials for running and shaping OPAS.',
  0
)
ON CONFLICT (id) DO UPDATE SET
  workspace_id = excluded.workspace_id,
  slug = excluded.slug,
  name = excluded.name,
  description = excluded.description,
  position = excluded.position,
  updated_at = unixepoch() * 1000;

INSERT INTO articles (
  id,
  workspace_id,
  category_id,
  slug,
  title,
  mdx,
  status,
  is_faq,
  author_name,
  published_at
)
VALUES (
  'article_runtime_mdx',
  'workspace_demo',
  'category_getting_started',
  'runtime-mdx',
  'Runtime MDX from D1',
  '# Runtime MDX from D1' || char(10) || char(10) ||
  'This article was read through **Drizzle ORM** from Cloudflare D1.' || char(10) || char(10) ||
  '> Change the D1 row, refresh this page, and OPAS renders the new answer without rebuilding.' || char(10) || char(10) ||
  'The browser executes the sanitized compiled module because workerd forbids request-time dynamic evaluation.',
  'published',
  0,
  'OPAS',
  unixepoch() * 1000
)
ON CONFLICT (id) DO UPDATE SET
  workspace_id = excluded.workspace_id,
  category_id = excluded.category_id,
  slug = excluded.slug,
  title = excluded.title,
  mdx = excluded.mdx,
  status = excluded.status,
  is_faq = excluded.is_faq,
  author_name = excluded.author_name,
  published_at = excluded.published_at,
  updated_at = unixepoch() * 1000;

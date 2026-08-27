-- ABOUTME: Seeds Cloudflare D1 with the deterministic OPAS demo workspace, content, and theme.
-- ABOUTME: Upserts complete records so repeated local and remote preparation converges after edits.
INSERT INTO workspaces (id, slug, name, created_at, updated_at)
VALUES ('workspace_demo', 'demo', 'OPAS Demo', 1767225600000, 1767225600000)
ON CONFLICT (id) DO UPDATE SET
  slug = excluded.slug,
  name = excluded.name,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at;

INSERT INTO categories (
  id,
  workspace_id,
  slug,
  name,
  description,
  position,
  created_at,
  updated_at
)
VALUES
  (
    'category_getting_started',
    'workspace_demo',
    'getting-started',
    'Getting started',
    'The essentials for running and shaping OPAS.',
    0,
    1767225600000,
    1767225600000
  ),
  (
    'category_customization',
    'workspace_demo',
    'customization',
    'Customization',
    'Make the help center match your product and voice.',
    1,
    1767225600000,
    1767225600000
  )
ON CONFLICT (id) DO UPDATE SET
  workspace_id = excluded.workspace_id,
  slug = excluded.slug,
  name = excluded.name,
  description = excluded.description,
  position = excluded.position,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at;

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
  published_at,
  created_at,
  updated_at
)
VALUES
  (
    'article_runtime_mdx',
    'workspace_demo',
    'category_getting_started',
    'runtime-mdx',
    'Runtime MDX in OPAS',
    '# Runtime MDX in OPAS' || char(10) || char(10) ||
    'This article is loaded from the deployment database through **Drizzle ORM** and compiled when the request arrives.' || char(10) || char(10) ||
    '> Edit this article, reload the page, and OPAS renders the updated answer without rebuilding.' || char(10) || char(10) ||
    'The same content model runs on Docker, Vercel, and Cloudflare Workers.',
    'published',
    0,
    'OPAS',
    1767225600000,
    1767225600000,
    1767225600000
  ),
  (
    'article_customize_help_center',
    'workspace_demo',
    'category_customization',
    'customize-your-help-center',
    'Customize your help center',
    '# Customize your help center' || char(10) || char(10) ||
    'This draft explains how runtime themes let OPAS match your product without rebuilding the application.',
    'draft',
    0,
    'OPAS',
    NULL,
    1767225600000,
    1767225600000
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
  created_at = excluded.created_at,
  updated_at = excluded.updated_at;

INSERT INTO themes (
  id,
  workspace_id,
  name,
  config,
  created_at,
  updated_at
)
VALUES (
  'theme_default',
  'workspace_demo',
  'OPAS Default',
  json(
    '{"logoUrl":null,' ||
    '"fonts":{' ||
      '"sans":"Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",' ||
      '"mono":"\"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace"' ||
    '},' ||
    '"radius":{"xs":"0.25rem","sm":"0.375rem","md":"0.75rem","lg":"1rem","xl":"1.5rem"},' ||
    '"light":{' ||
      '"background":"oklch(1 0 0)",' ||
      '"foreground":"oklch(0.2 0.018 27)",' ||
      '"surface":"oklch(0.975 0 0)",' ||
      '"surfaceStrong":"oklch(0.94 0.005 27)",' ||
      '"surfaceElevated":"oklch(0.995 0 0)",' ||
      '"muted":"oklch(0.46 0.014 27)",' ||
      '"border":"oklch(0.88 0.009 27)",' ||
      '"borderStrong":"oklch(0.72 0.018 27)",' ||
      '"primary":"oklch(0.464 0.169 26.9)",' ||
      '"primaryForeground":"oklch(1 0 0)",' ||
      '"secondary":"oklch(0.92 0.018 27)",' ||
      '"secondaryForeground":"oklch(0.25 0.025 27)",' ||
      '"accent":"oklch(0.91 0.06 72)",' ||
      '"accentForeground":"oklch(0.29 0.055 50)",' ||
      '"success":"oklch(0.52 0.14 150)",' ||
      '"successForeground":"oklch(1 0 0)",' ||
      '"warning":"oklch(0.78 0.16 78)",' ||
      '"warningForeground":"oklch(0.26 0.045 55)",' ||
      '"danger":"oklch(0.55 0.2 25)",' ||
      '"dangerForeground":"oklch(1 0 0)",' ||
      '"focus":"oklch(0.62 0.18 27)",' ||
      '"codeBackground":"oklch(0.95 0.008 27)",' ||
      '"codeForeground":"oklch(0.24 0.025 27)"' ||
    '},' ||
    '"dark":{' ||
      '"background":"oklch(0.17 0.014 27)",' ||
      '"foreground":"oklch(0.95 0.006 27)",' ||
      '"surface":"oklch(0.21 0.014 27)",' ||
      '"surfaceStrong":"oklch(0.26 0.016 27)",' ||
      '"surfaceElevated":"oklch(0.235 0.016 27)",' ||
      '"muted":"oklch(0.72 0.012 27)",' ||
      '"border":"oklch(0.34 0.016 27)",' ||
      '"borderStrong":"oklch(0.46 0.02 27)",' ||
      '"primary":"oklch(0.69 0.2 27)",' ||
      '"primaryForeground":"oklch(0.16 0.014 27)",' ||
      '"secondary":"oklch(0.3 0.022 27)",' ||
      '"secondaryForeground":"oklch(0.94 0.008 27)",' ||
      '"accent":"oklch(0.42 0.09 68)",' ||
      '"accentForeground":"oklch(0.94 0.035 82)",' ||
      '"success":"oklch(0.7 0.16 150)",' ||
      '"successForeground":"oklch(0.17 0.025 150)",' ||
      '"warning":"oklch(0.82 0.16 82)",' ||
      '"warningForeground":"oklch(0.2 0.04 65)",' ||
      '"danger":"oklch(0.68 0.2 25)",' ||
      '"dangerForeground":"oklch(0.16 0.02 25)",' ||
      '"focus":"oklch(0.75 0.18 27)",' ||
      '"codeBackground":"oklch(0.135 0.012 27)",' ||
      '"codeForeground":"oklch(0.9 0.012 27)"' ||
    '}' ||
    '}'
  ),
  1767225600000,
  1767225600000
)
ON CONFLICT (id) DO UPDATE SET
  workspace_id = excluded.workspace_id,
  name = excluded.name,
  config = excluded.config,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at;

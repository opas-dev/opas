-- ABOUTME: Seeds Cloudflare D1 with the deterministic OPAS demo workspace, content, and theme.
-- ABOUTME: Restores missing seed records without replacing administrator edits on redeploy.
INSERT INTO workspaces (id, slug, name, created_at, updated_at)
VALUES ('workspace_demo', 'demo', 'OPAS Demo', 1767225600000, 1767225600000)
ON CONFLICT DO NOTHING;

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
SELECT
    'category_getting_started',
    'workspace_demo',
    'getting-started',
    'Getting started',
    'The essentials for running and shaping OPAS.',
    0,
    1767225600000,
    1767225600000
WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'workspace_demo')
ON CONFLICT DO NOTHING;

INSERT INTO categories (
  id, workspace_id, slug, name, description, position, created_at, updated_at
)
SELECT
    'category_customization',
    'workspace_demo',
    'customization',
    'Customization',
    'Make the help center match your product and voice.',
    1,
    1767225600000,
    1767225600000
WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'workspace_demo')
ON CONFLICT DO NOTHING;

INSERT INTO categories (
  id, workspace_id, slug, name, description, position, created_at, updated_at
)
SELECT
    'category_answers',
    'workspace_demo',
    'answers',
    'Answers',
    'How OPAS finds evidence, cites sources, and handles uncertainty.',
    2,
    1767225600000,
    1767225600000
WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'workspace_demo')
ON CONFLICT DO NOTHING;

INSERT INTO categories (
  id, workspace_id, slug, name, description, position, created_at, updated_at
)
SELECT
    'category_deployment',
    'workspace_demo',
    'deployment',
    'Deployment and agents',
    'Run OPAS where you choose and publish content for people and agents.',
    3,
    1767225600000,
    1767225600000
WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'workspace_demo')
ON CONFLICT DO NOTHING;

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
  position,
  published_at,
  created_at,
  updated_at
)
SELECT
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
    0,
    1767225600000,
    1767225600000,
    1767225600000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_getting_started' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
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
    0,
    NULL,
    1767225600000,
    1767225600000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_customization' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
    'article_what_is_opas',
    'workspace_demo',
    'category_getting_started',
    'what-is-opas',
    'What is OPAS?',
    '# What is OPAS?' || char(10) || char(10) ||
    'OPAS is an open-source help center for publishing support content and answering reader questions from that content.' || char(10) || char(10) ||
    'Teams can write in a visual editor or Markdown, publish without rebuilding the application, apply a complete runtime theme, and keep control of their infrastructure and data.',
    'published',
    1,
    'OPAS',
    1,
    1767225600000,
    1767225600000,
    1767225600000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_getting_started' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
    'article_content_ownership',
    'workspace_demo',
    'category_getting_started',
    'who-owns-opas-content',
    'Who owns the content in OPAS?',
    '# Who owns the content in OPAS?' || char(10) || char(10) ||
    'The team operating OPAS owns its help content, database, deployment, and theme. The core product is licensed under AGPL-3.0 and can be run on infrastructure the team controls.' || char(10) || char(10) ||
    'Published articles remain available as normal web pages and portable Markdown rather than being locked inside a proprietary editor.',
    'published',
    1,
    'OPAS',
    2,
    1767225600000,
    1767225600000,
    1767225600000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_getting_started' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
    'article_visual_authoring',
    'workspace_demo',
    'category_customization',
    'can-i-edit-visually-and-in-markdown',
    'Can I edit visually and in Markdown?',
    '# Can I edit visually and in Markdown?' || char(10) || char(10) ||
    'Yes. The article editor supports visual authoring and direct Markdown source editing, with live preview, draft and published states, image assets, and validation before content is saved.' || char(10) || char(10) ||
    'Both modes write the same portable article source, so authors can use the workflow that fits the change.',
    'published',
    1,
    'OPAS',
    0,
    1767225600000,
    1767225600000,
    1767225600000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_customization' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
    'article_runtime_themes',
    'workspace_demo',
    'category_customization',
    'can-opas-match-my-brand',
    'Can OPAS match my brand?',
    '# Can OPAS match my brand?' || char(10) || char(10) ||
    'Yes. OPAS stores a complete semantic theme in the deployment database, including light and dark colors, typography, radii, and a logo.' || char(10) || char(10) ||
    'Theme changes take effect at request time without rebuilding the application. The CROFusion demo is the same OPAS product with a separate theme and content set.',
    'published',
    1,
    'OPAS',
    1,
    1767225600000,
    1767225600000,
    1767225600000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_customization' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
    'article_grounded_answers',
    'workspace_demo',
    'category_answers',
    'how-do-grounded-answers-work',
    'How do source-grounded answers work?',
    '# How do source-grounded answers work?' || char(10) || char(10) ||
    'OPAS searches the published knowledge base, retrieves relevant evidence, and asks the configured model to answer only from those sources.' || char(10) || char(10) ||
    'Every accepted answer links back to the supporting article. Conversation outcomes and feedback can be retained for quality review under the configured deployment privacy policy.',
    'published',
    1,
    'OPAS',
    0,
    1767225600000,
    1767225600000,
    1767225600000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_answers' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
    'article_answer_uncertainty',
    'workspace_demo',
    'category_answers',
    'what-if-opas-is-not-sure',
    'What happens when OPAS is not sure?',
    '# What happens when OPAS is not sure?' || char(10) || char(10) ||
    'OPAS abstains when the published evidence is missing, conflicting, unsafe, or too weak to support an answer. It does not turn an unsupported guess into help-center policy.' || char(10) || char(10) ||
    'The reader can continue with search or send a bounded support handoff, while the unanswered question becomes useful input for improving the knowledge base.',
    'published',
    1,
    'OPAS',
    1,
    1767225600000,
    1767225600000,
    1767225600000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_answers' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
    'article_deployment_targets',
    'workspace_demo',
    'category_deployment',
    'where-can-i-deploy-opas',
    'Where can I deploy OPAS?',
    '# Where can I deploy OPAS?' || char(10) || char(10) ||
    'OPAS runs as a Docker deployment with PostgreSQL, on Vercel with Neon, or on Cloudflare Workers with D1.' || char(10) || char(10) ||
    'The same repository contract and database-backed content model are verified across those targets, so a help center is not tied to one hosting vendor.',
    'published',
    1,
    'OPAS',
    0,
    1767225600000,
    1767225600000,
    1767225600000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_deployment' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
    'article_agent_access',
    'workspace_demo',
    'category_deployment',
    'how-can-agents-read-opas',
    'How can AI agents read OPAS?',
    '# How can AI agents read OPAS?' || char(10) || char(10) ||
    'Every deployment can publish compact and full `llms.txt` indexes, a Markdown version of each article, and a read-only MCP endpoint for search and article retrieval.' || char(10) || char(10) ||
    'Those machine-readable surfaces come from the same published records readers see in the browser, so there is one source of truth.',
    'published',
    1,
    'OPAS',
    1,
    1767225600000,
    1767225600000,
    1767225600000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_deployment' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO themes (
  id,
  workspace_id,
  name,
  config,
  created_at,
  updated_at
)
SELECT
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
WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'workspace_demo')
ON CONFLICT DO NOTHING;

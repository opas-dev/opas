-- ABOUTME: Seeds the isolated CROFusion OPAS demo with public-safe product guidance.
-- ABOUTME: Applies identity without private source or evaluation canaries and requires authoring control.
INSERT INTO workspaces (id, slug, name, created_at, updated_at)
VALUES ('workspace_demo', 'demo', 'CROFusion Help Center', 1788152400000, 1788152400000)
ON CONFLICT DO NOTHING;

INSERT INTO workspace_authoring_assertions (workspace_id)
VALUES ('workspace_demo');

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
    'category_crofusion_getting_started',
    'workspace_demo',
    'getting-started',
    'Getting started',
    'Start creating with a clear brief and the right brand inputs.',
    0,
    1788152400000,
    1788152400000
WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'workspace_demo')
ON CONFLICT DO NOTHING;

INSERT INTO categories (
  id, workspace_id, slug, name, description, position, created_at, updated_at
)
SELECT
    'category_crofusion_landing_pages',
    'workspace_demo',
    'landing-pages',
    'Landing pages',
    'Generate and improve conversion-focused landing pages in the browser.',
    1,
    1788152400000,
    1788152400000
WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'workspace_demo')
ON CONFLICT DO NOTHING;

INSERT INTO categories (
  id, workspace_id, slug, name, description, position, created_at, updated_at
)
SELECT
    'category_crofusion_services',
    'workspace_demo',
    'managed-services',
    'Managed services',
    'Choose the delivery model and specialist support that fit your team.',
    2,
    1788152400000,
    1788152400000
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
    'article_crofusion_platform_access',
    'workspace_demo',
    'category_crofusion_getting_started',
    'is-crofusion-browser-based',
    'Is CROFusion browser-based?',
    '# Is CROFusion browser-based?' || char(10) || char(10) ||
    'Yes. CROFusion is fully cloud-based, so there is no software to download, install, maintain, or support with a separate IT setup.' || char(10) || char(10) ||
    'Use CROFusion from a desktop device in Chrome, Safari, Firefox, or Edge. Updates arrive automatically through the platform.',
    'published',
    1,
    'CROFusion',
    0,
    1788152400000,
    1788152400000,
    1788152400000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_crofusion_getting_started' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
    'article_crofusion_generation_prompt',
    'workspace_demo',
    'category_crofusion_getting_started',
    'what-should-i-include-in-my-brief',
    'What should I include in my landing page brief?',
    '# What should I include in my landing page brief?' || char(10) || char(10) ||
    'Describe the brand, the intended audience, and the conversion goal. Those three details give CROFusion useful direction for the page structure and copy.' || char(10) || char(10) ||
    'The public generator currently accepts a prompt of up to 2,000 characters.',
    'published',
    1,
    'CROFusion',
    1,
    1788152400000,
    1788152400000,
    1788152400000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_crofusion_getting_started' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
    'article_crofusion_brand_inputs',
    'workspace_demo',
    'category_crofusion_getting_started',
    'which-brand-inputs-can-i-add',
    'Which brand inputs can I add?',
    '# Which brand inputs can I add?' || char(10) || char(10) ||
    'You can optionally provide colors, a logo, a heading font, and a page font during generation.' || char(10) || char(10) ||
    'These inputs help the result match the visual brand, while the audience and conversion goal guide the content.',
    'published',
    1,
    'CROFusion',
    2,
    1788152400000,
    1788152400000,
    1788152400000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_crofusion_getting_started' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
    'article_crofusion_conversion_optimization',
    'workspace_demo',
    'category_crofusion_landing_pages',
    'what-does-crofusion-generate-and-optimize',
    'What does CROFusion generate and optimize?',
    '# What does CROFusion generate and optimize?' || char(10) || char(10) ||
    'CROFusion generates and optimizes conversion-focused landing pages. Its AI-assisted workflow can support behavioral analysis, experimentation, and iterative page improvement.' || char(10) || char(10) ||
    'Optimization can improve the evidence behind a decision, but it does not guarantee a specific conversion result.',
    'published',
    1,
    'CROFusion',
    0,
    1788152400000,
    1788152400000,
    1788152400000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_crofusion_landing_pages' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
    'article_crofusion_self_service',
    'workspace_demo',
    'category_crofusion_landing_pages',
    'can-i-use-crofusion-without-a-developer',
    'Can I use CROFusion without a developer?',
    '# Can I use CROFusion without a developer?' || char(10) || char(10) ||
    'Yes. The self-service platform is browser-based and is designed for businesses that want to generate and optimize landing pages directly.' || char(10) || char(10) ||
    'It does not require a software download or a developer dependency for normal use.',
    'published',
    1,
    'CROFusion',
    1,
    1788152400000,
    1788152400000,
    1788152400000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_crofusion_landing_pages' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
    'article_crofusion_managed_services',
    'workspace_demo',
    'category_crofusion_services',
    'what-is-included-in-managed-services',
    'What is included in managed marketing services?',
    '# What is included in managed marketing services?' || char(10) || char(10) ||
    'The managed option includes digital marketing consulting, online advertising management, demand generation, and lead generation.' || char(10) || char(10) ||
    'The team works alongside the business to plan, launch, and optimize campaigns.',
    'published',
    1,
    'CROFusion',
    0,
    1788152400000,
    1788152400000,
    1788152400000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_crofusion_services' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
    'article_crofusion_managed_team',
    'workspace_demo',
    'category_crofusion_services',
    'who-works-on-a-managed-campaign',
    'Who works on a managed campaign?',
    '# Who works on a managed campaign?' || char(10) || char(10) ||
    'The fully managed offer names a conversion strategist, a paid media analyst, and a copywriter.' || char(10) || char(10) ||
    'Their work covers campaign strategy, audience setup, landing page generation, ongoing A/B testing, optimization, performance tracking, and weekly reporting.',
    'published',
    1,
    'CROFusion',
    1,
    1788152400000,
    1788152400000,
    1788152400000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_crofusion_services' AND workspace_id = 'workspace_demo'
)
ON CONFLICT DO NOTHING;

INSERT INTO articles (
  id, workspace_id, category_id, slug, title, mdx, status, is_faq,
  author_name, position, published_at, created_at, updated_at
)
SELECT
    'article_crofusion_delivery_choice',
    'workspace_demo',
    'category_crofusion_services',
    'should-i-choose-self-service-or-managed',
    'Should I choose self-service or managed?',
    '# Should I choose self-service or managed?' || char(10) || char(10) ||
    'Choose self-service when your team wants to operate the software directly. Choose managed service when the business wants campaign specialists working alongside the platform.' || char(10) || char(10) ||
    'Both paths use CROFusion; the difference is how much operational support the team wants.',
    'published',
    1,
    'CROFusion',
    2,
    1788152400000,
    1788152400000,
    1788152400000
WHERE EXISTS (
  SELECT 1 FROM categories
  WHERE id = 'category_crofusion_services' AND workspace_id = 'workspace_demo'
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
  'CROFusion',
  json(
    '{"logoUrl":"/crofusion-mark.svg",' ||
    '"fonts":{' ||
      '"sans":"\"DM Sans\", \"Avenir Next\", Avenir, Inter, ui-sans-serif, system-ui, sans-serif",' ||
      '"mono":"\"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace"' ||
    '},' ||
    '"radius":{"xs":"0.25rem","sm":"0.5rem","md":"0.75rem","lg":"1rem","xl":"1rem"},' ||
    '"light":{' ||
      '"background":"oklch(0.9846 0.0017 247.84)",' ||
      '"foreground":"oklch(0.179 0.0261 266.47)",' ||
      '"surface":"oklch(1 0 0)",' ||
      '"surfaceStrong":"oklch(0.9603 0.0241 306.97)",' ||
      '"surfaceElevated":"oklch(1 0 0)",' ||
      '"muted":"oklch(0.4422 0.0355 257.79)",' ||
      '"border":"oklch(0.9427 0.0058 264.53)",' ||
      '"borderStrong":"oklch(0.8715 0.0123 259.82)",' ||
      '"primary":"oklch(0.3887 0.1944 297.6)",' ||
      '"primaryForeground":"oklch(1 0 0)",' ||
      '"secondary":"oklch(0.9631 0.0173 264.49)",' ||
      '"secondaryForeground":"oklch(0.3168 0.1663 296.12)",' ||
      '"accent":"oklch(0.7067 0.1852 15.69)",' ||
      '"accentForeground":"oklch(0.179 0.0261 266.47)",' ||
      '"success":"oklch(0.7585 0.1527 157.18)",' ||
      '"successForeground":"oklch(0.179 0.0261 266.47)",' ||
      '"warning":"oklch(0.7469 0.1701 62.11)",' ||
      '"warningForeground":"oklch(0.179 0.0261 266.47)",' ||
      '"danger":"oklch(0.5758 0.2088 29.48)",' ||
      '"dangerForeground":"oklch(1 0 0)",' ||
      '"focus":"oklch(0.4658 0.217 299.38)",' ||
      '"codeBackground":"oklch(0.9603 0.0241 306.97)",' ||
      '"codeForeground":"oklch(0.3168 0.1663 296.12)"' ||
    '},' ||
    '"dark":{' ||
      '"background":"oklch(0.165 0.0148 297.85)",' ||
      '"foreground":"oklch(0.9714 0.0098 305.41)",' ||
      '"surface":"oklch(0.2382 0.0563 304.78)",' ||
      '"surfaceStrong":"oklch(0.2984 0.0296 301.78)",' ||
      '"surfaceElevated":"oklch(0.205 0.035 303)",' ||
      '"muted":"oklch(0.8232 0.0276 304.77)",' ||
      '"border":"oklch(0.2984 0.0296 301.78)",' ||
      '"borderStrong":"oklch(0.4422 0.0355 257.79)",' ||
      '"primary":"oklch(0.7615 0.1348 306.17)",' ||
      '"primaryForeground":"oklch(0.165 0.0148 297.85)",' ||
      '"secondary":"oklch(0.3168 0.1663 296.12)",' ||
      '"secondaryForeground":"oklch(0.9714 0.0098 305.41)",' ||
      '"accent":"oklch(0.7067 0.1852 15.69)",' ||
      '"accentForeground":"oklch(0.165 0.0148 297.85)",' ||
      '"success":"oklch(0.7585 0.1527 157.18)",' ||
      '"successForeground":"oklch(0.165 0.0148 297.85)",' ||
      '"warning":"oklch(0.7469 0.1701 62.11)",' ||
      '"warningForeground":"oklch(0.165 0.0148 297.85)",' ||
      '"danger":"oklch(0.7067 0.1852 15.69)",' ||
      '"dangerForeground":"oklch(0.165 0.0148 297.85)",' ||
      '"focus":"oklch(0.6206 0.1988 305.05)",' ||
      '"codeBackground":"oklch(0.2382 0.0563 304.78)",' ||
      '"codeForeground":"oklch(0.9714 0.0098 305.41)"' ||
    '}' ||
    '}'
  ),
  1788152400000,
  1788152400000
WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = 'workspace_demo')
ON CONFLICT DO NOTHING;

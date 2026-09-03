// ABOUTME: Defines the frozen portable acceptance fixture for team-safe article authoring.
// ABOUTME: Covers roles, revisions, retained media, archive recovery, and bounded bulk import.

import type { ArticleRevisionSnapshot } from "@/content/article-revision";

const workspaceId = "workspace_demo";
const firstAssetHash = "1".repeat(64);
const secondAssetHash = "2".repeat(64);
const largeHeading = "# Large authoring guide\n\n";
const largeParagraph = "A deterministic paragraph for revision capacity testing.\n\n";
const nearMaximumMdx = `${largeHeading}${largeParagraph.repeat(
  Math.floor((99_000 - largeHeading.length) / largeParagraph.length),
)}`;

const members = Object.freeze([
  Object.freeze({
    id: "member_team_admin",
    email: "admin@team-authoring.invalid",
    displayName: "Avery Admin",
    role: "administrator" as const,
  }),
  Object.freeze({
    id: "member_team_editor",
    email: "editor@team-authoring.invalid",
    displayName: "Emery Editor",
    role: "editor" as const,
  }),
  Object.freeze({
    id: "member_team_reviewer",
    email: "reviewer@team-authoring.invalid",
    displayName: "Riley Reviewer",
    role: "reviewer" as const,
  }),
]);

const categories = Object.freeze([
  Object.freeze({ id: "category_team_start", slug: "start", name: "Start here" }),
  Object.freeze({ id: "category_team_manage", slug: "manage", name: "Manage OPAS" }),
]);

const publishedArticle: ArticleRevisionSnapshot = Object.freeze({
  workspaceId,
  articleId: "article_team_published",
  categoryId: categories[0].id,
  categorySlug: categories[0].slug,
  categoryName: categories[0].name,
  slug: "team-authoring",
  title: "Team authoring",
  mdx: [
    "# Team authoring",
    "",
    "| Step | Owner |",
    "| --- | --- |",
    "| Draft | Editor |",
    "| Review | Reviewer |",
    "",
    "Continue with [reviewing changes](/manage/reviewing-changes).",
    "",
    `![Draft screen](/api/assets/${firstAssetHash})`,
    "",
    `![Review screen](/api/assets/${secondAssetHash})`,
    "",
    "![Remote status](https://media.example.invalid/status.png)",
  ].join("\n"),
  isFaq: false,
  authorName: "OPAS",
  position: 0,
  assetHashes: Object.freeze([firstAssetHash, secondAssetHash]),
});

const largeDraft: ArticleRevisionSnapshot = Object.freeze({
  ...publishedArticle,
  articleId: "article_team_large_draft",
  slug: "large-authoring-guide",
  title: "Large authoring guide",
  mdx: nearMaximumMdx,
  position: 1,
  assetHashes: Object.freeze([]),
});

const archivedArticle: ArticleRevisionSnapshot = Object.freeze({
  ...publishedArticle,
  articleId: "article_team_archived",
  categoryId: categories[1].id,
  categorySlug: categories[1].slug,
  categoryName: categories[1].name,
  slug: "retired-workflow",
  title: "Retired workflow",
  mdx: "# Retired workflow\n\nThis article is retained for archive recovery tests.",
  position: 0,
  assetHashes: Object.freeze([firstAssetHash]),
});

const migrationDraftArticle: ArticleRevisionSnapshot = Object.freeze({
  workspaceId,
  articleId: "article_team_migration_draft",
  categoryId: categories[1].id,
  categorySlug: categories[1].slug,
  categoryName: categories[1].name,
  slug: "migration-draft",
  title: "Migration draft",
  mdx: "# Migration draft\n\nUnpublished baseline content.",
  isFaq: true,
  authorName: "OPAS",
  position: 2,
  assetHashes: Object.freeze([firstAssetHash]),
});

const importedArticles = Object.freeze(
  Array.from({ length: 100 }, (_, index) => {
    const number = String(index + 1).padStart(3, "0");
    return Object.freeze({
      id: `article_team_import_${number}`,
      categoryId: categories[index % categories.length].id,
      slug: `imported-article-${number}`,
      title: `Imported article ${number}`,
      mdx: `# Imported article ${number}\n\nDeterministic import fixture ${number}.`,
      status: index % 2 === 0 ? ("published" as const) : ("draft" as const),
    });
  }),
);

const teamAuthoringStandardContract = Object.freeze({
  id: "team-authoring-standard",
  version: 1,
  workspaceId,
  members,
  categories,
  assets: Object.freeze([
    Object.freeze({ hash: firstAssetHash, mediaType: "image/png" as const }),
    Object.freeze({ hash: secondAssetHash, mediaType: "image/webp" as const }),
  ]),
  publishedArticle,
  largeDraft,
  archivedArticle,
  importedArticles,
  migrationCases: Object.freeze([
    Object.freeze({
      article: publishedArticle,
      status: "published" as const,
      expectedSerialization:
        '["opas.article-revision.v1","workspace_demo","article_team_published","category_team_start","start","Start here","team-authoring","Team authoring","# Team authoring\\n\\n| Step | Owner |\\n| --- | --- |\\n| Draft | Editor |\\n| Review | Reviewer |\\n\\nContinue with [reviewing changes](/manage/reviewing-changes).\\n\\n![Draft screen](/api/assets/1111111111111111111111111111111111111111111111111111111111111111)\\n\\n![Review screen](/api/assets/2222222222222222222222222222222222222222222222222222222222222222)\\n\\n![Remote status](https://media.example.invalid/status.png)",false,"OPAS",0,["1111111111111111111111111111111111111111111111111111111111111111","2222222222222222222222222222222222222222222222222222222222222222"]]',
      expectedHash: "0620d4c467052453fd04506dcf168b09ddd612c6dd8be78be608805352df4881",
      expectedRevisionId:
        "revision_ed7a005886cf36f0a1f88eeb6882f9d453c8f8ab6af63601035fa1d74c92bc18",
      expectedHead: Object.freeze({
        workingRevisionNumber: 1,
        publishedRevisionNumber: 1,
        reviewState: "published" as const,
      }),
    }),
    Object.freeze({
      article: migrationDraftArticle,
      status: "draft" as const,
      expectedSerialization:
        '["opas.article-revision.v1","workspace_demo","article_team_migration_draft","category_team_manage","manage","Manage OPAS","migration-draft","Migration draft","# Migration draft\\n\\nUnpublished baseline content.",true,"OPAS",2,["1111111111111111111111111111111111111111111111111111111111111111"]]',
      expectedHash: "52db125912755362e6c6dea5134bc239c39a906be20771089a0d3ad43ba09b7e",
      expectedRevisionId:
        "revision_2d83889b964009e0728750770e54ef4900434262f28b9ec790467a056e8654f3",
      expectedHead: Object.freeze({
        workingRevisionNumber: 1,
        publishedRevisionNumber: null,
        reviewState: "editing" as const,
      }),
    }),
  ]),
});

export const teamAuthoringStandardHashInputV1 = JSON.stringify(
  teamAuthoringStandardContract,
);

export const teamAuthoringStandard = Object.freeze({
  ...teamAuthoringStandardContract,
  contentHash: "d0a6ae9bf97a365457f395303438f353931012c66e5aad153f00e63b64a62d0b",
});

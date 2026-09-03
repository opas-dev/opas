// ABOUTME: Builds and validates the frozen public-safe CROFusion import archive without writing data.
// ABOUTME: Reports the exact private-draft import plan for a named member to upload in the admin UI.
import { createHash } from "node:crypto";

import { crofusionLaunchPartnerFixtureV1 } from "@/evaluation/fixtures/crofusion-launch-partner-v1";
import { extractArchiveFiles } from "@/import/archive";
import { planKnowledgeImport } from "@/import/planner";
import { strToU8, zipSync } from "fflate";

function selectedCommand(value: string | undefined) {
  if (value !== undefined && value !== "verify") {
    throw new Error("Usage: tsx scripts/import-crofusion-launch-partner.ts [verify]");
  }
  return "verify" as const;
}

function articleSlug(sourceId: string) {
  return `crofusion-${sourceId.slice("source_".length).replaceAll("_", "-")}`;
}

function archive() {
  return zipSync(
    Object.fromEntries(
      crofusionLaunchPartnerFixtureV1.sources.map((source) => [
        `crofusion/${articleSlug(source.id)}.md`,
        strToU8(
          [
            "---",
            `title: ${JSON.stringify(source.title)}`,
            `slug: ${articleSlug(source.id)}`,
            "status: published",
            "isFaq: false",
            "authorName: OPAS",
            "---",
            `# ${source.title}`,
            "",
            source.evidenceText,
            "",
          ].join("\n"),
        ),
      ]),
    ),
    { level: 9, mtime: new Date(2000, 0, 1) },
  );
}

export async function verifyCrofusionLaunchPartnerArchive() {
  const bytes = archive();
  const files = extractArchiveFiles(bytes);
  const plan = await planKnowledgeImport(files);
  if (!plan.ready) {
    throw new Error("The CROFusion launch-partner archive did not produce a ready import plan");
  }
  if (
    plan.articles.length !== crofusionLaunchPartnerFixtureV1.sources.length ||
    plan.articles.some((article) => article.status !== "draft")
  ) {
    throw new Error("The CROFusion launch-partner archive did not normalize to exact private drafts");
  }
  return Object.freeze({
    archiveSha256: createHash("sha256").update(bytes).digest("hex"),
    articles: plan.articles.length,
    assets: plan.assets.length,
    categories: plan.categories.length,
    command: "verify" as const,
    errors: plan.report.conflicts.filter(({ severity }) => severity === "error")
      .length,
    normalizations: plan.report.changes.length,
    privateDrafts: plan.articles.length,
    redirects: plan.redirects.length,
    sourceFiles: files.length,
    status: "ready" as const,
    warnings: plan.report.conflicts.filter(({ severity }) => severity === "warning")
      .length,
  });
}

async function main() {
  selectedCommand(process.argv[2]);
  process.stdout.write(
    `${JSON.stringify(await verifyCrofusionLaunchPartnerArchive(), null, 2)}\n`,
  );
}

void main();

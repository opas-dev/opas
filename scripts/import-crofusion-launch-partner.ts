// ABOUTME: Reviews or activates the frozen public-safe CROFusion launch-partner corpus through the admin import contract.
// ABOUTME: Builds the archive in memory and authenticates without logging administrator credentials or session tokens.
import { adminSessionCookie, createAdminSessionToken } from "@/auth/session";
import { crofusionLaunchPartnerFixtureV1 } from "@/evaluation/fixtures/crofusion-launch-partner-v1";
import { strToU8, zipSync } from "fflate";

const productionOrigin = "https://demo.opas.dev";

function selectedMode(value: string | undefined) {
  if (value !== "dry-run" && value !== "activate") {
    throw new Error(
      "Usage: node --env-file=.env --import tsx scripts/import-crofusion-launch-partner.ts [dry-run|activate]",
    );
  }
  return value;
}

function requiredSecret(value: string | undefined) {
  if (!value || value.length < 32 || /[\r\n]/u.test(value)) {
    throw new Error("ADMIN_SESSION_SECRET is unavailable or invalid");
  }
  return value;
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
    { level: 9 },
  );
}

async function main() {
  const mode = selectedMode(process.argv[2]);
  const secret = requiredSecret(process.env.ADMIN_SESSION_SECRET);
  const session = await createAdminSessionToken(secret);
  const form = new FormData();
  form.set("mode", mode);
  form.set(
    "file",
    new File([archive()], "crofusion-launch-partner-v1.zip", {
      type: "application/zip",
    }),
  );
  const response = await fetch(`${productionOrigin}/admin/content/import/run`, {
    method: "POST",
    headers: {
      Cookie: `${adminSessionCookie}=${session.token}`,
      Origin: productionOrigin,
    },
    body: form,
    redirect: "error",
  });
  const body = (await response.json()) as unknown;
  process.stdout.write(
    `${JSON.stringify({ httpStatus: response.status, mode, response: body }, null, 2)}\n`,
  );
  if (!response.ok) {
    throw new Error(`CROFusion import ${mode} failed with HTTP ${response.status}`);
  }
}

void main();

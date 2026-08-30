// ABOUTME: Stages authenticated article images under one expiring workspace asset manifest.
// ABOUTME: Discards abandoned manifests explicitly so their unreferenced content is removed.
import {
  assetManifestLifetimeMilliseconds,
  AssetRequestError,
  readAssetDiscardRequest,
  readAssetStageRequest,
} from "@/assets/requests";
import { requireAdmin } from "@/auth/admin";
import { AssetValidationError } from "@/db/assets";
import { getRepository } from "@/db";
import { demoIds } from "@/db/demo";

export const runtime = "nodejs";

function errorDetails(error: unknown) {
  return { type: error instanceof Error ? error.name : "UnknownError" };
}

export async function POST(request: Request) {
  await requireAdmin();

  let stageRequest: Awaited<ReturnType<typeof readAssetStageRequest>>;
  try {
    stageRequest = await readAssetStageRequest(request);
  } catch (error) {
    if (error instanceof AssetRequestError) {
      return Response.json({ message: error.message }, { status: error.status });
    }
    return Response.json({ message: "The image upload request is invalid." }, { status: 400 });
  }

  const repository = await getRepository();
  const now = new Date();
  let createdManifestId: string | undefined;

  try {
    await repository.cleanupExpiredAssets(demoIds.workspace, now);
    const manifest = stageRequest.manifestId
      ? null
      : await repository.createAssetManifest(
          demoIds.workspace,
          new Date(now.getTime() + assetManifestLifetimeMilliseconds),
        );
    createdManifestId = manifest?.id;
    const manifestId = stageRequest.manifestId ?? manifest?.id;
    if (!manifestId) {
      throw new Error("An asset manifest was not created.");
    }

    const asset = await repository.stageAsset(
      demoIds.workspace,
      manifestId,
      stageRequest.upload,
    );

    return Response.json(
      {
        manifestId,
        hash: asset.hash,
        url: `/api/assets/${asset.hash}`,
        mediaType: asset.mediaType,
        byteSize: asset.byteSize,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (createdManifestId) {
      try {
        await repository.discardAssetManifest(demoIds.workspace, createdManifestId);
      } catch (cleanupError) {
        console.error("Failed image staging cleanup.", {
          upload: errorDetails(error),
          cleanup: errorDetails(cleanupError),
        });
        return Response.json(
          { message: "The image could not be staged or cleaned up safely." },
          { status: 500 },
        );
      }
    }

    if (error instanceof AssetValidationError) {
      return Response.json({ message: error.message }, { status: 422 });
    }

    if (stageRequest.manifestId) {
      return Response.json(
        { message: "The image staging session expired. Upload the image again." },
        { status: 409 },
      );
    }

    console.error("Image staging failed.", errorDetails(error));
    return Response.json({ message: "The image could not be staged." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  await requireAdmin();

  let manifestId: string;
  try {
    manifestId = await readAssetDiscardRequest(request);
  } catch (error) {
    if (error instanceof AssetRequestError) {
      return Response.json({ message: error.message }, { status: error.status });
    }
    return Response.json({ message: "The asset discard request is invalid." }, { status: 400 });
  }

  try {
    await (await getRepository()).discardAssetManifest(demoIds.workspace, manifestId);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Asset manifest discard failed.", errorDetails(error));
    return Response.json({ message: "The staged images could not be discarded." }, { status: 500 });
  }
}

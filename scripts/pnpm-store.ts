// ABOUTME: Resolves the exact pnpm content store used by an installed deployment workspace.
// ABOUTME: Keeps isolated offline builds bound to validated package-manager state.
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

export function pnpmStoreDirectory(
  workspace: string,
  artifact: "Cloudflare" | "Vercel",
) {
  const metadataPath = join(workspace, "node_modules", ".modules.yaml");
  let metadataStatus;
  try {
    metadataStatus = lstatSync(metadataPath);
  } catch {
    throw new Error(`Run pnpm install before building the ${artifact} artifact.`);
  }
  if (metadataStatus.isSymbolicLink() || !metadataStatus.isFile()) {
    throw new Error(`Run pnpm install before building the ${artifact} artifact.`);
  }

  const match = /^storeDir:\s*([^'"\r\n][^\r\n]*)$/mu.exec(
    readFileSync(metadataPath, "utf8"),
  );
  if (!match) {
    throw new Error("The pnpm store metadata is unavailable.");
  }
  const requested = match[1]!.trim();
  if (!isAbsolute(requested)) {
    throw new Error("The pnpm store metadata must contain an absolute path.");
  }

  let resolved: string;
  try {
    resolved = realpathSync(requested);
  } catch {
    throw new Error("The pnpm store path must contain a directory.");
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error("The pnpm store path must contain a directory.");
  }
  return resolved;
}

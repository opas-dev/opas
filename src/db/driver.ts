// ABOUTME: Resolves the active database target and enforces artifact-owned deployment identity.
// ABOUTME: Prevents project environment drift from selecting an unintended storage backend.
import { artifactDatabaseDriver } from "@/db/deployment-identity";

export type DatabaseDriver = "d1" | "neon" | "postgres";

type DatabaseEnvironment = Readonly<
  Record<string, string | undefined> & {
    OPAS_DATABASE_DRIVER?: string;
  }
>;

export function resolveDatabaseDriver(
  environment: DatabaseEnvironment = process.env,
  selectedArtifactDriver: "neon" | undefined = artifactDatabaseDriver,
): DatabaseDriver {
  const driver = environment.OPAS_DATABASE_DRIVER ?? "postgres";
  if (driver !== "d1" && driver !== "neon" && driver !== "postgres") {
    throw new Error(`Unsupported OPAS_DATABASE_DRIVER: ${driver}`);
  }
  if (selectedArtifactDriver !== undefined && selectedArtifactDriver !== driver) {
    throw new Error(
      "OPAS_DATABASE_DRIVER does not match the database selected by this artifact",
    );
  }
  return driver;
}

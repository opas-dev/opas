// ABOUTME: Exposes the database readiness probe to orchestration routes.
// ABOUTME: Delegates health checks through the deployment-neutral repository.
import { getRepository } from "@/db";

export async function checkDatabase() {
  return (await getRepository()).checkHealth();
}

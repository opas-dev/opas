// ABOUTME: Confirms that the D1 deployment can execute a database round trip.
// ABOUTME: Keeps the binding-specific probe inside the SQLite data layer.
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function checkD1() {
  await getCloudflareContext().env.DB.prepare("select 1").first();
}

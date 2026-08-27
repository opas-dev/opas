// ABOUTME: Reports whether the OPAS server and its selected database are ready for traffic.
// ABOUTME: Supplies container orchestration with a small database-aware health endpoint.
import { checkPostgres } from "@/db/postgres/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await checkPostgres();
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}

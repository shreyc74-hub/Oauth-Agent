import { getRun } from "@/lib/provision/runs";
import { publicRun } from "@/lib/provision/http";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(publicRun(run), { headers: { "cache-control": "no-store" } });
}

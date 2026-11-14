import { reveal } from "@/lib/provision/engine";
import { mockEnabled } from "@/lib/provision/mock";

export const runtime = "nodejs";

/**
 * POST { label }. Returns one secret; every reveal is logged on the run and in provision_reveals.
 * Open by default, like the rest of the agent. Setting PROVISION_ADMIN_TOKEN requires the
 * x-admin-token header.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = process.env.PROVISION_ADMIN_TOKEN;
  if (!mockEnabled()) {
    if (admin && req.headers.get("x-admin-token") !== admin) return Response.json({ error: "Admin token required.", needsToken: true }, { status: 401 });
  }
  const { id } = await params;
  const { label } = (await req.json().catch(() => ({}))) as { label?: string };
  try {
    return Response.json({ value: await reveal(id, String(label || "")) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}

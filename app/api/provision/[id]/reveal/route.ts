import { reveal } from "@/lib/provision/engine";
import { mockEnabled } from "@/lib/provision/mock";

export const runtime = "nodejs";

/** POST { label } with header x-admin-token. Returns one secret; the reveal is logged on the run. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = process.env.PROVISION_ADMIN_TOKEN;
  if (!mockEnabled()) {
    if (!admin) return Response.json({ error: "Revealing secrets is off (PROVISION_ADMIN_TOKEN is not set)." }, { status: 503 });
    if (req.headers.get("x-admin-token") !== admin) return Response.json({ error: "Admin token required." }, { status: 401 });
  }
  const { id } = await params;
  const { label } = (await req.json().catch(() => ({}))) as { label?: string };
  try {
    return Response.json({ value: await reveal(id, String(label || "")) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}

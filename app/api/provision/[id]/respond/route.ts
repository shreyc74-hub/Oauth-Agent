import { respond } from "@/lib/provision/engine";
import { gate, publicRun } from "@/lib/provision/http";

export const runtime = "nodejs";

/** POST { action: "continue" | "approve" | "skip" | "cancel", value? } — a person's answer to a pause. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = gate(req);
  if (denied) return denied;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: string; value?: string };
  const action = ["continue", "approve", "skip", "cancel"].includes(String(body.action)) ? (body.action as "continue") : null;
  if (!action) return Response.json({ error: "Unknown action." }, { status: 400 });
  try {
    return Response.json(publicRun(await respond(id, action, body.value ? String(body.value).slice(0, 4000) : undefined)));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

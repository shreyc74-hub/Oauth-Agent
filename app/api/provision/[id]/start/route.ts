import { startRun } from "@/lib/provision/engine";
import { gate, publicRun } from "@/lib/provision/http";

export const runtime = "nodejs";

/** POST { mode: "human" | "auto" } — the person's choice after reading the agent's assessment. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = gate(req);
  if (denied) return denied;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { mode?: string };
  if (body.mode !== "human" && body.mode !== "auto") return Response.json({ error: "Choose human or auto." }, { status: 400 });
  try {
    return Response.json(publicRun(await startRun(id, body.mode)));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 422 });
  }
}

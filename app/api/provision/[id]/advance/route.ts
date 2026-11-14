import { advance } from "@/lib/provision/engine";
import { gate, publicRun } from "@/lib/provision/http";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Runs steps until the run pauses, finishes or nearly hits the function time limit. The page calls it again. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = gate(req);
  if (denied) return denied;
  const { id } = await params;
  try {
    const run = await advance(id, undefined, 250_000);
    return Response.json(publicRun(run));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

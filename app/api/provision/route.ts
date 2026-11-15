import { createRun, NoGuideError, SandboxGatedError } from "@/lib/provision/engine";
import { listRuns } from "@/lib/provision/runs";
import { gate, baseUrl, publicRun } from "@/lib/provision/http";
import { limited } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 300; // the sandbox check and planning can each take a minute

/** POST { app, mode: "human" | "auto" } -> a new run (plan only; nothing has happened yet). */
export async function POST(req: Request) {
  const denied = gate(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { app?: string; mode?: string; simulateChange?: boolean; guideSlug?: string; useCase?: string };
  const app = String(body.app || "").trim().slice(0, 80);
  const mode = body.mode === "auto" ? "auto" : "human";
  if (!app) return Response.json({ error: "Name an app." }, { status: 400 });
  if (limited(req, "provision", 20)) return Response.json({ error: "Too many runs from this network. Try later." }, { status: 429 });
  try {
    const run = await createRun({ app, mode, baseUrl: baseUrl(req), simulateChange: Boolean(body.simulateChange), guideSlug: body.guideSlug ? String(body.guideSlug).slice(0, 120) : undefined, useCase: body.useCase ? String(body.useCase).slice(0, 600) : undefined });
    return Response.json(publicRun(run));
  } catch (e) {
    if (e instanceof SandboxGatedError) return Response.json({ error: e.message, gated: e.check }, { status: 409 });
    if (e instanceof NoGuideError) return Response.json({ error: e.message, noGuide: true, research: `/research?name=${encodeURIComponent(app)}` }, { status: 404 });
    return Response.json({ error: (e as Error).message }, { status: 422 });
  }
}

export async function GET() {
  const runs = await listRuns(30);
  return Response.json(runs.map((r) => ({ id: r.id, app: r.app, mode: r.mode, status: r.status, strategy: r.strategy, createdAt: r.createdAt, who: r.verify?.who })));
}

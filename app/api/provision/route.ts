import { createRun, defaultDeps, NoGuideError, SandboxGatedError } from "@/lib/provision/engine";
import { listRuns } from "@/lib/provision/runs";
import { gate, baseUrl, publicRun } from "@/lib/provision/http";
import { limited } from "@/lib/ratelimit";
import { signInOnly } from "@/lib/provision/labels";

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
  const input = { app, mode: mode as "human" | "auto", baseUrl: baseUrl(req), simulateChange: Boolean(body.simulateChange), guideSlug: body.guideSlug ? String(body.guideSlug).slice(0, 120) : undefined, useCase: body.useCase ? String(body.useCase).slice(0, 600) : undefined };

  // The start page asks for a stream so it can show each backend step as it happens.
  if ((req.headers.get("accept") || "").includes("application/x-ndjson")) {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
        const t0 = Date.now();
        try {
          const run = await createRun(input, defaultDeps(), (e) => send({ type: "progress", ms: Date.now() - t0, ...e }));
          send({ type: "result", status: 200, body: publicRun(run) });
        } catch (e) {
          const { status, body: b } = failure(e, app);
          send({ type: "result", status, body: b });
        } finally { controller.close(); }
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
  }

  try {
    const run = await createRun(input);
    return Response.json(publicRun(run));
  } catch (e) {
    const { status, body: b } = failure(e, app);
    return Response.json(b, { status });
  }
}

function failure(e: unknown, app: string): { status: number; body: Record<string, unknown> } {
  if (e instanceof SandboxGatedError) return { status: 409, body: { error: e.message, gated: e.check } };
  if (e instanceof NoGuideError) return { status: 404, body: { error: e.message, noGuide: true, research: `/research?name=${encodeURIComponent(app)}` } };
  return { status: 422, body: { error: (e as Error).message } };
}

export async function GET() {
  const runs = await listRuns(30);
  return Response.json(runs.map((r) => ({ id: r.id, app: r.app, mode: r.mode, status: r.status, strategy: r.strategy, createdAt: r.createdAt, who: r.verify?.who, signInOnly: signInOnly(r) })));
}

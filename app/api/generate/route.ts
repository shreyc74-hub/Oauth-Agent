import { researchGuide, type AgentEvent } from "@/lib/agent/research";
import { limited } from "@/lib/ratelimit";
import { notify } from "@/lib/notify";

export const runtime = "nodejs";
export const maxDuration = 300; // research takes 1 to 4 minutes

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { name?: string; website?: string };
  const name = String(body.name || "").trim().slice(0, 120);
  const website = String(body.website || "").trim().slice(0, 200);
  if (!name) return new Response("Missing vendor name.", { status: 400 });
  if (!process.env.ANTHROPIC_API_KEY && process.env.AGENT_MOCK !== "1") return new Response("The research agent isn't configured (no ANTHROPIC_API_KEY).", { status: 503 });
  if (limited(req, "generate", Number(process.env.GENERATE_LIMIT_PER_HOUR || 6))) {
    return new Response("Guide generation limit reached for this network. Try again later.", { status: 429 });
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        const started = Date.now();
        await notify("research_started", `Research started: ${name}${website ? ` (${website})` : ""}`, req);
        await researchGuide({ name, website }, emit, req.signal);
        emit({ type: "done" });
        await notify("research_finished", `Research finished: ${name} in ${Math.round((Date.now() - started) / 1000)}s`, req);
      } catch (e) {
        if (!req.signal.aborted) {
          emit({ type: "error", message: (e as Error).message });
          await notify("research_failed", `Research failed: ${name}: ${(e as Error).message.slice(0, 160)}`, req);
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}

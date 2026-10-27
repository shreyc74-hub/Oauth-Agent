import { researchGuide, type AgentEvent } from "@/lib/agent/research";
import { limited } from "@/lib/ratelimit";

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
        await researchGuide({ name, website }, emit, req.signal);
        emit({ type: "done" });
      } catch (e) {
        if (!req.signal.aborted) emit({ type: "error", message: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}

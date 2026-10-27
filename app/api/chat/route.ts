import { runChat, cleanMessages, type ChatEvent } from "@/lib/agent/chat";
import { limited } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { messages?: unknown; slug?: string };
  const messages = cleanMessages(body.messages);
  if (!messages) return new Response("Send at least one question.", { status: 400 });
  if (!process.env.ANTHROPIC_API_KEY && process.env.AGENT_MOCK !== "1") return new Response("The agent isn't configured on this deployment (no ANTHROPIC_API_KEY).", { status: 503 });
  if (limited(req, "chat", Number(process.env.CHAT_LIMIT_PER_HOUR || 40))) return new Response("Too many questions from this network. Try again later.", { status: 429 });
  const slug = typeof body.slug === "string" ? body.slug.slice(0, 60) : undefined;

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: ChatEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        await runChat({ messages, slug }, emit, req.signal);
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

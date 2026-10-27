// Test helpers: a fake Claude Messages API (server-sent events) installed over global fetch.
type Ev = Record<string, unknown>;

export function sse(events: Ev[]): Response {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  // Split into small chunks to exercise buffering across reads.
  const enc = new TextEncoder().encode(body);
  let i = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (i >= enc.length) { c.close(); return; }
      c.enqueue(enc.slice(i, i + 37)); i += 37;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Builds the event list for one assistant message. */
export function message(blocks: ({ text: string } | { tool: string; input: unknown; server?: boolean; id?: string } | { raw: Ev })[], stop = "end_turn"): Ev[] {
  const ev: Ev[] = [{ type: "message_start", message: { id: "m", role: "assistant", content: [] } }];
  blocks.forEach((b, index) => {
    if ("text" in b) {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      // stream text in 2 deltas
      const half = Math.ceil(b.text.length / 2);
      if (b.text.slice(0, half)) ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text.slice(0, half) } });
      if (b.text.slice(half)) ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text.slice(half) } });
      ev.push({ type: "content_block_stop", index });
    } else if ("tool" in b) {
      ev.push({ type: "content_block_start", index, content_block: { type: b.server ? "server_tool_use" : "tool_use", id: b.id || `tu_${index}`, name: b.tool, input: {} } });
      const j = JSON.stringify(b.input);
      ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: j.slice(0, 5) } });
      ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: j.slice(5) } });
      ev.push({ type: "content_block_stop", index });
    } else {
      ev.push({ type: "content_block_start", index, content_block: b.raw });
      ev.push({ type: "content_block_stop", index });
    }
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop } });
  ev.push({ type: "message_stop" });
  return ev;
}

export interface FakeCall { url: string; body: any; headers: Record<string, string> }

/**
 * Replaces global fetch. Requests to the Claude API get the next scripted response.
 * Other URLs go to `other` (or fail), so tests can stub page fetches and renderers too.
 */
export function installFake(script: (Ev[] | Response | ((body: any) => Ev[] | Response))[], other?: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: FakeCall[] = [];
  const otherCalls: string[] = [];
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/v1/messages")) {
      const body = JSON.parse(String(init?.body || "{}"));
      calls.push({ url, body, headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) || {})) });
      const step = script[n++];
      if (!step) throw new Error(`Fake Claude: no scripted response for call ${n}`);
      const r = typeof step === "function" ? step(body) : step;
      return r instanceof Response ? r : sse(r);
    }
    otherCalls.push(url);
    if (other) return other(url, init);
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;
  return { calls, otherCalls, restore: () => { globalThis.fetch = original; } };
}

/** Collects NDJSON lines from a Response body. */
export async function readNdjson(res: Response): Promise<any[]> {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export const req = (url: string, body?: unknown, ip = "1.1.1.1", method = body === undefined ? "GET" : "POST") =>
  new Request(url, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: body === undefined ? undefined : JSON.stringify(body) });

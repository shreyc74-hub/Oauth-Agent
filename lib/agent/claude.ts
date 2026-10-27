// Minimal streaming client for the Claude Messages API with server tools (web search, web fetch).
// Handles pause_turn by continuing the turn, and reports tool activity as it happens.

const API = `${process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"}/v1/messages`;

export const MODEL = process.env.GUIDE_MODEL || "claude-sonnet-5-5";
export const RESOLVE_MODEL = process.env.RESOLVE_MODEL || MODEL;

export const webTools = (searches: number, fetches: number) => [
  { type: "web_search_20260318", name: "web_search", max_uses: searches },
  { type: "web_fetch_20260318", name: "web_fetch", max_uses: fetches },
];

type Block = { type: string; [k: string]: unknown };
type Msg = { role: "user" | "assistant"; content: string | Block[] };

export interface StreamHooks {
  onText?: (delta: string) => void;
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
  signal?: AbortSignal;
}

/** Runs one request (continuing through pause_turn) and returns the text of the final message. */
export async function runClaude(
  opts: { system: string; messages: Msg[]; tools?: unknown[]; maxTokens?: number; model?: string },
  hooks: StreamHooks = {},
): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set.");
  const messages = [...opts.messages];
  let finalText = "";

  for (let round = 0; round < 4; round++) {
    const res = await fetch(API, {
      method: "POST",
      signal: hooks.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: opts.model || MODEL, max_tokens: opts.maxTokens ?? 16000, stream: true, system: opts.system, tools: opts.tools, messages }),
    });
    if (!res.ok || !res.body) throw new Error(`Claude API error ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const blocks: Block[] = [];
    const json: Record<number, string> = {};
    let stopReason = "";
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = raw.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let e: any;
        try { e = JSON.parse(line.slice(6)); } catch { continue; }
        if (e.type === "content_block_start") {
          blocks[e.index] = { ...e.content_block };
          if (e.content_block.type === "text") blocks[e.index].text = "";
          if (e.content_block.type === "server_tool_use") json[e.index] = "";
        } else if (e.type === "content_block_delta") {
          const b = blocks[e.index];
          if (e.delta.type === "text_delta") { b.text = (b.text as string) + e.delta.text; hooks.onText?.(e.delta.text); }
          if (e.delta.type === "input_json_delta") json[e.index] += e.delta.partial_json;
        } else if (e.type === "content_block_stop") {
          const b = blocks[e.index];
          if (b?.type === "server_tool_use") {
            try { b.input = JSON.parse(json[e.index] || "{}"); } catch { b.input = {}; }
            hooks.onToolUse?.(String(b.name), b.input as Record<string, unknown>);
          }
        } else if (e.type === "message_delta") {
          stopReason = e.delta?.stop_reason || stopReason;
        } else if (e.type === "error") {
          throw new Error(`Claude API stream error: ${e.error?.message || "unknown"}`);
        }
      }
    }

    const texts = blocks.filter((b) => b?.type === "text").map((b) => String(b.text));
    finalText = texts.join("\n");
    if (stopReason !== "pause_turn") return finalText;
    // Long research turns pause; send the partial turn back to continue it.
    messages.push({ role: "assistant", content: blocks.filter(Boolean).map((b) => (b.type === "text" ? { type: "text", text: b.text } : b)) });
  }
  return finalText;
}

/** Pulls the first JSON object out of a model reply. */
export function extractJson<T>(text: string): T {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(body) as T;
}

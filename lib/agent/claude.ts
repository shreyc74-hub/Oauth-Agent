// Minimal streaming client for the Claude Messages API with server tools (web search, web fetch).
// Handles pause_turn by continuing the turn, and reports tool activity as it happens.
import "../env";

// Read at call time so tests and deployments can change them without a rebuild.
const apiUrl = () => `${process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"}/v1/messages`;

export const MODEL = process.env.GUIDE_MODEL || "claude-sonnet-5-5";
export const RESOLVE_MODEL = process.env.RESOLVE_MODEL || MODEL;

// web_fetch cannot render JavaScript pages; research.ts adds a render_page client tool for those.
export const webTools = (searches: number, fetches: number) => [
  { type: "web_search_20260318", name: "web_search", max_uses: searches },
  ...(fetches > 0 ? [{ type: "web_fetch_20260318", name: "web_fetch", max_uses: fetches, max_content_tokens: 30000 }] : []),
];

type Block = { type: string; [k: string]: unknown };
type Msg = { role: "user" | "assistant"; content: string | Block[] };

/** A tool that runs in our server (not Anthropic's), e.g. rendering a JavaScript-heavy page. */
export interface ClientTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<string>;
}

export interface StreamHooks {
  onText?: (delta: string) => void;
  onToolUse?: (name: string, input: Record<string, unknown>) => void;
  signal?: AbortSignal;
}

export const MAX_ROUNDS = 12;

/** Runs one request (continuing through pause_turn) and returns the text of the final message. */
export async function runClaude(
  opts: { system: string; messages: Msg[]; tools?: unknown[]; clientTools?: ClientTool[]; maxTokens?: number; model?: string },
  hooks: StreamHooks = {},
): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set.");
  const messages = [...opts.messages];
  let finalText = "";

  const clientTools = opts.clientTools || [];
  const tools = [...(opts.tools || []), ...clientTools.map(({ name, description, input_schema }) => ({ name, description, input_schema }))];
  let textBlocksSeen = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch(apiUrl(), {
      method: "POST",
      signal: hooks.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: opts.model || MODEL, max_tokens: opts.maxTokens ?? 16000, stream: true, system: opts.system, tools: tools.length ? tools : undefined, messages }),
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
          if (e.content_block.type === "text") { blocks[e.index].text = ""; if (textBlocksSeen++ > 0) hooks.onText?.("\n"); }
          if (e.content_block.type === "server_tool_use" || e.content_block.type === "tool_use") json[e.index] = "";
        } else if (e.type === "content_block_delta") {
          const b = blocks[e.index];
          if (e.delta.type === "text_delta") { b.text = (b.text as string) + e.delta.text; hooks.onText?.(e.delta.text); }
          if (e.delta.type === "input_json_delta") json[e.index] += e.delta.partial_json;
        } else if (e.type === "content_block_stop") {
          const b = blocks[e.index];
          if (b?.type === "server_tool_use" || b?.type === "tool_use") {
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
    // Empty text blocks are rejected by the API when sent back, so drop them.
    const assistant = blocks
      .filter((b) => b && !(b.type === "text" && !String(b.text).length))
      .map((b) => (b.type === "text" ? { type: "text", text: b.text } : b));
    if (stopReason === "pause_turn") {
      // Long research turns pause; send the partial turn back to continue it.
      messages.push({ role: "assistant", content: assistant });
      continue;
    }
    if (stopReason === "tool_use") {
      // Run our own tools and send the results back.
      const calls = blocks.filter((b) => b?.type === "tool_use");
      const results: Block[] = [];
      for (const c of calls) {
        const tool = clientTools.find((t) => t.name === c.name);
        let content: string;
        try { content = tool ? await tool.run(c.input as Record<string, unknown>) : `Unknown tool ${String(c.name)}`; }
        catch (err) { content = `Error: ${(err as Error).message}`; }
        results.push({ type: "tool_result", tool_use_id: c.id, content: content.slice(0, 60_000) });
      }
      messages.push({ role: "assistant", content: assistant }, { role: "user", content: results });
      continue;
    }
    return finalText;
  }
  return finalText;
}

/** Pulls the first JSON object out of a model reply. */
export function extractJson<T>(text: string): T {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fence ? fence[1] : text;
  const start = src.indexOf("{");
  const end = src.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return JSON.");
  return JSON.parse(src.slice(start, end + 1)) as T;
}

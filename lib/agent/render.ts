// Reads pages that only show content after JavaScript runs.
// Claude's web_fetch tool does not run JavaScript, and neither does a plain server fetch, so
// both fall back to a rendering service:
//   RENDER_PROVIDER=jina        (default) r.jina.ai reader, works without a key; JINA_API_KEY raises limits
//   RENDER_PROVIDER=browserless BROWSERLESS_TOKEN required (headless Chrome /content endpoint)
//   RENDER_PROVIDER=off         never render
// Only public URLs are sent, never user data.

export type RenderProvider = "jina" | "browserless" | "off";

export function renderProvider(): RenderProvider {
  const p = (process.env.RENDER_PROVIDER || "jina").toLowerCase();
  if (p === "off") return "off";
  if (p === "browserless") return process.env.BROWSERLESS_TOKEN ? "browserless" : "off";
  return "jina";
}

/** Rejects anything that is not a public http(s) URL, so the tool can't be pointed at internal hosts. */
export function publicUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h.endsWith(".local") || h.endsWith(".internal") || h === "localhost") return null;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.startsWith("[")) return null;
  return u;
}

/** Strips tags and collapses whitespace. Good enough to tell if a page has real text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** A page is "thin" when the HTML has almost no readable text, which usually means a JavaScript app shell. */
export function isThin(html: string): boolean {
  return htmlToText(html).length < 400;
}

export async function renderPage(raw: string, opts: { timeoutMs?: number; maxChars?: number } = {}): Promise<{ url: string; text: string; provider: RenderProvider }> {
  const u = publicUrl(raw);
  if (!u) throw new Error("Only public http(s) links can be read.");
  const provider = renderProvider();
  if (provider === "off") throw new Error("Page rendering is turned off on this deployment.");
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20000);
  const max = opts.maxChars ?? 40000;
  let text: string;
  if (provider === "browserless") {
    const base = process.env.BROWSERLESS_URL || "https://production-sfo.browserless.io";
    const res = await fetch(`${base}/content?token=${encodeURIComponent(process.env.BROWSERLESS_TOKEN || "")}`, {
      method: "POST", signal: timeout, headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: u.toString(), gotoOptions: { waitUntil: "networkidle2", timeout: 15000 } }),
    });
    if (!res.ok) throw new Error(`Renderer returned ${res.status}`);
    text = htmlToText(await res.text());
  } else {
    const headers: Record<string, string> = { accept: "text/plain", "x-return-format": "markdown" };
    if (process.env.JINA_API_KEY) headers.authorization = `Bearer ${process.env.JINA_API_KEY}`;
    const res = await fetch(`https://r.jina.ai/${u.toString()}`, { signal: timeout, headers });
    if (!res.ok) throw new Error(`Renderer returned ${res.status}`);
    text = (await res.text()).trim();
  }
  if (!text) throw new Error("The page rendered with no readable text.");
  return { url: u.toString(), text: text.slice(0, max), provider };
}

/** Client tool for the research agent. */
export const renderTool = {
  name: "render_page",
  description: "Opens a public web page in a real browser, runs its JavaScript, and returns the readable text. Use it only when web_fetch returns an empty page, a JavaScript app shell, or a 'please enable JavaScript' message. Costs more time than web_fetch.",
  input_schema: { type: "object", properties: { url: { type: "string", description: "Full https URL" } }, required: ["url"] },
  run: async (input: Record<string, unknown>) => {
    const r = await renderPage(String(input.url || ""));
    return `Rendered ${r.url}\n\n${r.text}`;
  },
};

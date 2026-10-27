// Step 1 of the agent: work out which vendor the developer means.
// Rules agreed with the product owner (also in skills/vendor-identification):
// - an exact, unambiguous product name (Confluence, Slack) goes straight through
// - a rough or partial name (monday, teams) is always confirmed ("Did you mean monday.com?")
// - a pasted link is investigated server-side; a JavaScript-only page never stops us: we render it,
//   and fall back to the domain, the page title and a web search.
import { runClaude, extractJson, RESOLVE_MODEL, webTools } from "./claude";
import { getSkill } from "./skills";
import { isThin, renderPage, publicUrl } from "./render";

export type Candidate = { name: string; website: string; description?: string };
export type Identified =
  | { status: "unique"; vendor: Candidate }
  | { status: "ambiguous"; candidates: Candidate[]; reason: string }
  | { status: "unknown"; message: string };

export const looksLikeUrl = (q: string) => /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(q.trim());

export const cleanDomain = (w: string) => String(w || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");

export interface Peek { url: string; host: string; finalHost: string; title?: string; siteName?: string; description?: string; text?: string; rendered?: boolean }

export function readMeta(html: string) {
  const pick = (re: RegExp) => html.match(re)?.[1]?.trim();
  return {
    title: pick(/<title[^>]*>([^<]{1,200})<\/title>/i),
    siteName: pick(/property=["']og:site_name["'][^>]*content=["']([^"']{1,120})/i) || pick(/content=["']([^"']{1,120})["'][^>]*property=["']og:site_name/i),
    description: pick(/name=["']description["'][^>]*content=["']([^"']{1,300})/i) || pick(/property=["']og:description["'][^>]*content=["']([^"']{1,300})/i),
  };
}

export async function peekPage(q: string): Promise<Peek> {
  const u = publicUrl(q);
  const url = u ? u.toString() : `https://${cleanDomain(q)}`;
  const host = cleanDomain(url);
  let out: Peek = { url, host, finalHost: host };
  if (!u) return out;
  let html = "";
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "user-agent": "Mozilla/5.0 (compatible; OAuthReadinessBot/1.0)" } });
    html = (await res.text()).slice(0, 200_000);
    out = { ...out, finalHost: cleanDomain(res.url || url), ...readMeta(html) };
  } catch { /* blocked or offline: fall through to rendering and the model's own search */ }
  if (!html || isThin(html)) {
    try {
      const r = await renderPage(url, { timeoutMs: 12000, maxChars: 3000 });
      out = { ...out, text: r.text, rendered: true };
    } catch { /* rendering off or failed */ }
  }
  return out;
}

export function identifySystem(): string {
  const s = getSkill("vendor-identification");
  return `You identify which software vendor a developer means, so we can look up its OAuth app setup.
Reply with only one JSON object, no other text:
{"status":"unique"|"ambiguous"|"unknown","candidates":[{"name":"Product name","website":"domain.com","description":"one line"}],"reason":"one short sentence"}

"unique" = exactly one candidate and no need to confirm. "ambiguous" = 1 to 4 candidates, best first, and the developer must confirm. "unknown" = no software product found.

${s ? s.body : ""}

Use web search only if you are unsure.`;
}

export function parseIdentified(text: string, query: string): Identified {
  let r: { status?: string; candidates?: Candidate[]; reason?: string };
  try { r = extractJson(text); } catch { return { status: "unknown", message: `We couldn't identify "${query}". Try its website.` }; }
  const seen = new Set<string>();
  const cands = (Array.isArray(r.candidates) ? r.candidates : [])
    .filter((c) => c && typeof c.name === "string" && c.name.trim())
    .map((c) => ({ name: c.name.trim(), website: cleanDomain(c.website), description: c.description }))
    .filter((c) => { const k = (c.website || c.name).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  if (r.status === "unique" && cands[0]) return { status: "unique", vendor: cands[0] };
  if ((r.status === "ambiguous" || r.status === "unique") && cands.length) return { status: "ambiguous", candidates: cands.slice(0, 4), reason: r.reason || "" };
  return { status: "unknown", message: r.reason || `We couldn't find a software product called "${query}". Try its website.` };
}

export async function identify(query: string): Promise<Identified> {
  let context = `Developer typed: ${JSON.stringify(query)}`;
  if (looksLikeUrl(query)) {
    const p = await peekPage(query);
    context += `\nIt is a link. Server fetch result: host=${p.host}; final host after redirects=${p.finalHost}; <title>=${JSON.stringify(p.title ?? null)}; og:site_name=${JSON.stringify(p.siteName ?? null)}; meta description=${JSON.stringify(p.description ?? null)}.`;
    if (p.text) context += `\nThe page needed JavaScript, so it was rendered in a browser. First part of its text:\n${p.text.slice(0, 2000)}`;
  }
  const text = await runClaude({ model: RESOLVE_MODEL, system: identifySystem(), maxTokens: 1500, tools: webTools(3, 0), messages: [{ role: "user", content: context }] });
  return parseIdentified(text, query);
}

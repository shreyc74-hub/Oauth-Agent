// Step 1 of the agent: work out which vendor the developer means.
// Rules agreed with the product owner:
// - an exact, unambiguous product name (Confluence, Slack) goes straight through
// - a rough or partial name (monday, teams) is always confirmed ("Did you mean monday.com?")
// - a pasted link is investigated server-side; a JavaScript-only page never stops us, we fall back
//   to the domain, the page title and a web search.
import { runClaude, extractJson, RESOLVE_MODEL, webTools } from "./claude";

export type Candidate = { name: string; website: string; description?: string };
export type Identified =
  | { status: "unique"; vendor: Candidate }
  | { status: "ambiguous"; candidates: Candidate[]; reason: string }
  | { status: "unknown"; message: string };

const looksLikeUrl = (q: string) => /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(q.trim());

async function peekPage(q: string) {
  const url = /^https?:\/\//i.test(q) ? q : `https://${q}`;
  const host = new URL(url).host.replace(/^www\./, "");
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "user-agent": "Mozilla/5.0 (compatible; OAuthReadinessBot/1.0)" } });
    const html = (await res.text()).slice(0, 200_000);
    const pick = (re: RegExp) => html.match(re)?.[1]?.trim();
    return {
      url, host, finalHost: new URL(res.url || url).host.replace(/^www\./, ""),
      title: pick(/<title[^>]*>([^<]{1,200})<\/title>/i),
      siteName: pick(/property=["']og:site_name["'][^>]*content=["']([^"']{1,120})/i) || pick(/content=["']([^"']{1,120})["'][^>]*property=["']og:site_name/i),
      description: pick(/name=["']description["'][^>]*content=["']([^"']{1,300})/i) || pick(/property=["']og:description["'][^>]*content=["']([^"']{1,300})/i),
    };
  } catch {
    return { url, host, finalHost: host, title: undefined, siteName: undefined, description: undefined };
  }
}

const SYSTEM = `You identify which software vendor a developer means, so we can look up its OAuth app setup.
Reply with only one JSON object, no other text:
{"status":"unique"|"ambiguous"|"unknown","candidates":[{"name":"Product name","website":"domain.com","description":"one line"}],"reason":"one short sentence"}

Rules:
- "unique": the input is the exact, commonly used name of one product (e.g. "Confluence", "Slack", "HubSpot", "Zoom"), or a link/domain that clearly belongs to one vendor. Return exactly one candidate.
- "ambiguous": the input is a rough, partial or generic name (e.g. "monday" -> monday.com, "teams" -> Microsoft Teams, "box", "front"), or could mean several products. Return 1 to 4 candidates, best first. Even with one obvious candidate, a rough name is "ambiguous" so the developer confirms.
- "unknown": you cannot find a software product that matches.
- For links: identify the vendor that owns the domain or the product shown on the page, never describe the page technology. A page that only loads JavaScript still has a domain and a title: use them, and search if needed.
- website is the vendor's main domain without https:// or paths.
Use web search only if you are unsure.`;

export async function identify(query: string): Promise<Identified> {
  let context = `Developer typed: ${JSON.stringify(query)}`;
  if (looksLikeUrl(query)) {
    const p = await peekPage(query);
    context += `\nIt is a link. Server fetch result: host=${p.host}; final host after redirects=${p.finalHost}; <title>=${JSON.stringify(p.title ?? null)}; og:site_name=${JSON.stringify(p.siteName ?? null)}; meta description=${JSON.stringify(p.description ?? null)}.`;
  }
  const text = await runClaude({ model: RESOLVE_MODEL, system: SYSTEM, maxTokens: 1500, tools: webTools(3, 1), messages: [{ role: "user", content: context }] });
  const r = extractJson<{ status: string; candidates?: Candidate[]; reason?: string }>(text);
  const cands = (r.candidates || []).filter((c) => c && c.name).map((c) => ({ ...c, website: String(c.website || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") }));
  if (r.status === "unique" && cands[0]) return { status: "unique", vendor: cands[0] };
  if (r.status === "ambiguous" && cands.length) return { status: "ambiguous", candidates: cands.slice(0, 4), reason: r.reason || "" };
  return { status: "unknown", message: r.reason || `We couldn't find a software product called "${query}". Try its website.` };
}

// Turns each evidence line into "where it comes from": a label (Official docs, Secondary source,
// Tested in our setup) linked to the page that supports it. Conflicts are not shown on the page
// (product decision); they stay in the data for the chat and the self-check.
import type { Guide, Status } from "./schema";

export const REPO_URL = "https://github.com/shreyc74-hub/Oauth-Agent";

export const SOURCE_LABEL: Record<Status, string> = {
  tested: "Tested in our setup",
  docs: "Official docs",
  secondary: "Secondary source",
  conflict: "Sources disagree",
  unverified: "Not verified",
};

const THIRD_PARTY = /zapier|n8n|nango|pipedream|merge\.dev|make\.com|paragon|workato|tray\.io|stackoverflow|stackexchange|reddit|medium\.com|dev\.to|github\.com|community\.|forum|discourse|composio/;
const STOP = new Set(["with", "that", "this", "from", "page", "says", "the", "and", "for", "our", "docs", "official", "shown", "states", "guide", "your", "into", "about", "when", "after", "before", "have", "were", "their", "they"]);
const words = (s: string) => new Set(String(s || "").toLowerCase().replace(/https?:\/\//g, " ").split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)));

const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };
const isUrl = (u: unknown) => typeof u === "string" && /^https?:\/\//i.test(u) && Boolean(hostOf(u));

export interface ClaimSource { claim: string; status: Status; label: string; url?: string; title?: string }

/** Finds the source a claim rests on. Only links when there's a real match, never a guess. */
export function sourceForClaim(e: { claim: string; status: Status; basis: string; url?: string }, sources: { title: string; url: string }[], slug?: string): ClaimSource {
  const base: ClaimSource = { claim: e.claim, status: e.status, label: SOURCE_LABEL[e.status] ?? e.status };
  if (isUrl(e.url)) return { ...base, url: e.url, title: sources.find((s) => s.url === e.url)?.title };
  if (e.status === "tested" && slug) return { ...base, url: `${REPO_URL}/blob/main/attempts/${slug}.md`, title: "Our setup attempt log" };
  if (e.status === "unverified") return base;
  const want = e.status === "secondary" ? "third" : "official";
  const pool = (sources || []).filter((s) => isUrl(s.url) && (want === "third" ? THIRD_PARTY.test(hostOf(s.url)) : !THIRD_PARTY.test(hostOf(s.url))));
  const b = words(`${e.basis} ${e.claim}`);
  let best: { s: { title: string; url: string }; score: number } | null = null;
  for (const s of pool) {
    const w = words(`${s.title} ${s.url}`);
    let score = 0;
    for (const x of b) if (w.has(x)) score++;
    if (!best || score > best.score) best = { s, score };
  }
  if (best && best.score > 0) return { ...base, url: best.s.url, title: best.s.title };
  if (pool.length === 1) return { ...base, url: pool[0].url, title: pool[0].title };
  return base;
}

/** The claim table shown under Sources: no conflict rows. */
export function claimSources(g: Partial<Guide>): ClaimSource[] {
  return (g.evidence || []).filter((e) => e && e.status !== "conflict").map((e) => sourceForClaim(e as never, g.sources || [], g.slug));
}

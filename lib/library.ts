// Library guides shipped with the repo (data/guides/*.json, bundled into lib/generated/content.ts
// at build time). Used to seed Supabase and as the fallback store when Supabase is not configured.
import type { Guide } from "./schema";
import { GUIDES } from "./generated/content";

let cache: Guide[] | null = null;

export function libraryGuides(): Guide[] {
  if (cache) return cache;
  cache = (GUIDES as Guide[]).slice().sort((a, b) => a.name.localeCompare(b.name));
  return cache;
}

/** Other names people type for library apps. Keeps lookups instant without calling the model. */
export const ALIASES: Record<string, string[]> = {
  slack: ["slack", "slack.com", "slack api"],
  linear: ["linear", "linear.app"],
  notion: ["notion", "notion.so", "notion.com"],
  gmail: ["gmail", "google mail", "gmail.com", "mail.google.com", "gmail api"],
  confluence: ["confluence", "atlassian confluence", "confluence cloud", "atlassian.com/software/confluence"],
  hubspot: ["hubspot", "hubspot.com", "hubspot crm"],
  salesforce: ["salesforce", "salesforce.com", "sfdc", "salesforce crm"],
  linkedin: ["linkedin", "linkedin.com", "linkedin api"],
};

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/\.(com|io|app|ai|dev|co|net|org|so)$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export function matchLibrary(query: string, guides: Guide[]): Guide | null {
  const q = query.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  const host = q.split("/")[0];
  for (const g of guides) {
    const names = [g.slug, g.name.toLowerCase(), g.website.toLowerCase(), ...(ALIASES[g.slug] || [])];
    if (names.includes(q) || names.includes(host)) return g;
  }
  return null;
}

// Library guides shipped with the repo (data/guides/*.json). Used to seed Supabase and as the
// fallback store when Supabase is not configured.
import fs from "node:fs";
import path from "node:path";
import type { Guide } from "./schema";

let cache: Guide[] | null = null;

export function libraryGuides(): Guide[] {
  if (cache) return cache;
  const dir = path.join(process.cwd(), "data", "guides");
  cache = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Guide)
    .sort((a, b) => a.name.localeCompare(b.name));
  return cache;
}

/** Other names people type for library apps. Keeps lookups instant without calling the model. */
export const ALIASES: Record<string, string[]> = {
  slack: ["slack", "slack.com", "slack api"],
  linear: ["linear", "linear.app"],
  notion: ["notion", "notion.so", "notion.com"],
  gmail: ["gmail", "google mail", "gmail.com", "mail.google.com"],
  confluence: ["confluence", "atlassian confluence", "confluence cloud"],
  hubspot: ["hubspot", "hubspot.com", "hubspot crm"],
  salesforce: ["salesforce", "salesforce.com", "sfdc", "salesforce crm"],
  linkedin: ["linkedin", "linkedin.com"],
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

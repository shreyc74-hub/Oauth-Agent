// Guide storage. Supabase when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set,
// otherwise an in-memory store seeded from the library files (fine for local dev).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Guide } from "./schema";
import { libraryGuides } from "./library";

export interface GuideSummary {
  slug: string;
  name: string;
  website: string;
  category: string;
  evidenceLevel: Guide["evidenceLevel"];
  checkedOn: string;
  verdict: string;
  creation: number;
  approval: number;
  waiting: string;
}

const summarize = (g: Guide): GuideSummary => ({
  slug: g.slug,
  name: g.name,
  website: g.website,
  category: g.category,
  evidenceLevel: g.evidenceLevel,
  checkedOn: g.checkedOn,
  verdict: g.verdict,
  creation: g.glance?.creation?.rating ?? 0,
  approval: g.glance?.approval?.rating ?? 0,
  waiting: g.glance?.waiting?.value ?? "",
});

let sb: SupabaseClient | null | undefined;
function supabase(): SupabaseClient | null {
  if (sb !== undefined) return sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  sb = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return sb;
}

const memory = new Map<string, Guide>();
function mem(): Map<string, Guide> {
  if (memory.size === 0) for (const g of libraryGuides()) memory.set(g.slug, g);
  return memory;
}

export const storeMode = () => (supabase() ? "supabase" : "memory");

export async function listGuides(): Promise<GuideSummary[]> {
  const db = supabase();
  if (!db) return [...mem().values()].map(summarize);
  const { data, error } = await db.from("guides").select("data").order("name");
  if (error) throw new Error(error.message);
  const rows = (data || []).map((r: { data: Guide }) => r.data);
  // Library files are always present even before seeding.
  const seen = new Set(rows.map((g) => g.slug));
  for (const g of libraryGuides()) if (!seen.has(g.slug)) rows.push(g);
  return rows.map(summarize).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getGuide(slug: string): Promise<Guide | null> {
  const db = supabase();
  if (!db) return mem().get(slug) ?? null;
  const { data, error } = await db.from("guides").select("data").eq("slug", slug).maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return (data as { data: Guide }).data;
  return libraryGuides().find((g) => g.slug === slug) ?? null;
}

export async function saveGuide(g: Guide): Promise<void> {
  const db = supabase();
  if (!db) { mem().set(g.slug, g); return; }
  const { error } = await db.from("guides").upsert({
    slug: g.slug,
    name: g.name,
    website: g.website,
    evidence_level: g.evidenceLevel,
    checked_on: g.checkedOn,
    data: g,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

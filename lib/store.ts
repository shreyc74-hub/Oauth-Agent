// Guide storage. Supabase when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set,
// otherwise an in-memory store seeded from the library files (fine for local dev).
import "./env";
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
  /** The first "decision you can't undo": the one thing to know before starting. */
  trap: string;
  oauthSupported: boolean;
}

export const summarize = (g: Guide): GuideSummary => ({
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
  trap: (g.oneWayDoors?.[0]?.title ?? g.oauth?.note ?? "").replace(/`/g, ""),
  oauthSupported: g.oauth?.supported !== false,
});

let sb: SupabaseClient | null | undefined;
/** Last Supabase problem, shown on /status (never includes secrets). */
export let lastStoreError = "";
const note = (where: string, e: unknown) => {
  lastStoreError = `${where}: ${e instanceof Error ? e.message : String(e)}`;
  console.error(`[store] ${lastStoreError}`);
};

/**
 * Accepts the forms people paste: the API URL, the URL with /rest/v1, a dashboard link, or just the
 * project ref. Returns https://<ref>.supabase.co (or a custom domain as given), or "" if unusable.
 */
export function cleanSupabaseUrl(raw: string | undefined): string {
  let v = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (!v) return "";
  const dash = v.match(/supabase\.com\/dashboard\/project\/([a-z0-9]{15,})/i);
  if (dash) return `https://${dash[1].toLowerCase()}.supabase.co`;
  if (/^[a-z0-9]{15,40}$/i.test(v)) return `https://${v.toLowerCase()}.supabase.co`;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    return `${u.protocol}//${u.host}`;
  } catch { return ""; }
}

function supabase(): SupabaseClient | null {
  if (sb !== undefined) return sb;
  const url = cleanSupabaseUrl(process.env.SUPABASE_URL);
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (!url || !key) {
    if (process.env.SUPABASE_URL && !url) note("config", "SUPABASE_URL is not a usable URL");
    sb = null;
    return sb;
  }
  try {
    sb = createClient(url, key, { auth: { persistSession: false } });
  } catch (e) {
    note("connect", e);
    sb = null;
  }
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
  // A database problem must never take the site down: fall back to the built-in library.
  let data: { data: Guide }[] | null = null;
  try {
    const r = await db.from("guides").select("data").order("name");
    if (r.error) throw new Error(r.error.message);
    data = r.data as { data: Guide }[];
  } catch (e) {
    note("read guides", e);
    return [...mem().values()].map(summarize);
  }
  const rows = (data || []).map((r: { data: Guide }) => r.data);
  // Library files are always present even before seeding.
  const seen = new Set(rows.map((g) => g.slug));
  for (const g of libraryGuides()) if (!seen.has(g.slug)) rows.push(g);
  return rows.map(summarize).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getGuide(slug: string): Promise<Guide | null> {
  const db = supabase();
  if (!db) return mem().get(slug) ?? null;
  try {
    const { data, error } = await db.from("guides").select("data").eq("slug", slug).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return (data as { data: Guide }).data;
  } catch (e) {
    note("read guide", e);
    return mem().get(slug) ?? null;
  }
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
  if (error) { note("save guide", error.message); throw new Error(`Could not save to the database: ${error.message}`); }
}

// ---------- Corrections proposed in chat and approved by the developer ----------
export interface Correction { id?: string; slug: string; section: string; claim: string; correction: string; source: string; createdAt?: string }
const corrections: Correction[] = [];

export async function saveCorrection(c: Correction): Promise<void> {
  const db = supabase();
  const row = { ...c, createdAt: new Date().toISOString() };
  if (!db) { corrections.push(row); return; }
  const { error } = await db.from("corrections").insert({ slug: c.slug, section: c.section, claim: c.claim, correction: c.correction, source: c.source });
  if (error) { note("save correction", error.message); throw new Error(`Could not save the correction: ${error.message}`); }
}

export async function listCorrections(slug: string): Promise<Correction[]> {
  const db = supabase();
  if (!db) return corrections.filter((c) => c.slug === slug);
  const { data, error } = await db.from("corrections").select("*").eq("slug", slug).order("created_at", { ascending: false }).limit(50);
  if (error) { note("read corrections", error.message); return []; }
  return (data || []) as Correction[];
}

/** For tests: forget the in-memory state. */
export function _resetMemoryStore() { memory.clear(); corrections.length = 0; sb = undefined; lastStoreError = ""; }

/** What /status shows: which store is in use and whether a read works. No secrets. */
export async function storeHealth(): Promise<{ mode: "supabase" | "memory"; url: string; ok: boolean; guides: number; error: string }> {
  const db = supabase();
  const url = cleanSupabaseUrl(process.env.SUPABASE_URL);
  if (!db) return { mode: "memory", url, ok: !process.env.SUPABASE_URL, guides: mem().size, error: lastStoreError || (process.env.SUPABASE_URL ? "" : "Supabase isn't configured; saved guides are kept in memory only.") };
  try {
    const r = await db.from("guides").select("slug", { count: "exact", head: true });
    if (r.error) throw new Error(r.error.message || `HTTP ${r.status}`);
    return { mode: "supabase", url, ok: true, guides: r.count ?? 0, error: "" };
  } catch (e) {
    note("health", e);
    return { mode: "supabase", url, ok: false, guides: 0, error: lastStoreError };
  }
}

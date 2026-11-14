// Run storage. Supabase table `provision_runs` when configured, memory otherwise (local only).
// A run holds vault names and masked values, never a secret.
import "../env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cleanSupabaseUrl } from "../store";
import type { Run } from "./types";

let db: SupabaseClient | null | undefined;
function supabase(): SupabaseClient | null {
  if (db !== undefined) return db;
  const url = cleanSupabaseUrl(process.env.SUPABASE_URL);
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  db = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return db;
}

const mem = new Map<string, Run>();

export async function saveRun(run: Run): Promise<void> {
  run.updatedAt = new Date().toISOString();
  const s = supabase();
  if (!s) { mem.set(run.id, structuredClone(run)); return; }
  const { error } = await s.from("provision_runs").upsert({ id: run.id, app: run.app, slug: run.slug, mode: run.mode, status: run.status, data: run, updated_at: run.updatedAt });
  if (error) throw new Error(`Saving run failed: ${error.message}`);
}

export async function getRun(id: string): Promise<Run | null> {
  const s = supabase();
  if (!s) { const r = mem.get(id); return r ? structuredClone(r) : null; }
  const { data, error } = await s.from("provision_runs").select("data").eq("id", id).maybeSingle();
  if (error) throw new Error(`Reading run failed: ${error.message}`);
  return data ? ((data as { data: Run }).data) : null;
}

export async function listRuns(limit = 30): Promise<Run[]> {
  const s = supabase();
  if (!s) return [...mem.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  const { data, error } = await s.from("provision_runs").select("data").order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`Listing runs failed: ${error.message}`);
  return ((data || []) as { data: Run }[]).map((r) => r.data);
}

/** The OAuth callback stores the code on the run whose verify.state matches. */
export async function attachCode(state: string, code: string): Promise<Run | null> {
  const s = supabase();
  let run: Run | null = null;
  if (!s) run = [...mem.values()].find((r) => r.verify?.state === state) ?? null;
  else {
    const { data } = await s.from("provision_runs").select("data").filter("data->verify->>state", "eq", state).maybeSingle();
    run = data ? (data as { data: Run }).data : null;
  }
  if (!run || !run.verify) return null;
  run.verify.code = code;
  await saveRun(run);
  return run;
}

export function _resetRuns() { mem.clear(); db = undefined; }

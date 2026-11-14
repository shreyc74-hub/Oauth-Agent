// Secret storage. Supabase Vault when Supabase is configured (encrypted at rest, readable only by
// the service role through two SQL functions), otherwise an in-process store encrypted with AES-GCM
// (local development only: it does not survive a restart or reach other server instances).
// Nothing in here logs a value. Runs and the tracker sheet only ever hold vault names.
import "../env";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cleanSupabaseUrl } from "../store";

let db: SupabaseClient | null | undefined;
function supabase(): SupabaseClient | null {
  if (db !== undefined) return db;
  const url = cleanSupabaseUrl(process.env.SUPABASE_URL);
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  db = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return db;
}

const mem = new Map<string, Buffer>();
const memKey = () => createHash("sha256").update(process.env.PROVISION_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "local-dev-only").digest();

function seal(value: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", memKey(), iv);
  const body = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function open(b: Buffer): string {
  const d = createDecipheriv("aes-256-gcm", memKey(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

export const vaultMode = () => (supabase() ? "supabase-vault" : "memory");

/**
 * Vault names: per-run secrets live under `<slug>/<runId>/<label>`. Labels starting with "shared:"
 * are bootstrap credentials reused across runs (e.g. Slack's config token): `<slug>/shared/<label>`.
 */
export function vaultName(slug: string, runId: string, label: string): string {
  return label.startsWith("shared:") ? `${slug}/shared/${label.slice(7)}` : `${slug}/${runId}/${label}`;
}

export async function putSecret(name: string, value: string, description = ""): Promise<string> {
  if (!value) throw new Error(`Refusing to store an empty secret (${name}).`);
  const s = supabase();
  if (!s) { mem.set(name, seal(value)); return name; }
  const { error } = await s.rpc("provision_store_secret", { p_name: name, p_secret: value, p_description: description });
  if (error) throw new Error(`Vault write failed for ${name}: ${error.message}`);
  return name;
}

export async function getSecret(name: string): Promise<string | null> {
  const s = supabase();
  if (!s) { const b = mem.get(name); return b ? open(b) : null; }
  const { data, error } = await s.rpc("provision_read_secret", { p_name: name });
  if (error) throw new Error(`Vault read failed for ${name}: ${error.message}`);
  return (data as string | null) ?? null;
}

/** Append-only record of a reveal (Supabase only). Throws if the record cannot be written. */
export async function recordReveal(runId: string, name: string): Promise<void> {
  const s = supabase();
  if (!s) return;
  const { error } = await s.from("provision_reveals").insert({ run_id: runId, secret_name: name });
  if (error) throw new Error(`Could not record the reveal, so it was refused: ${error.message}`);
}

export async function hasSecret(name: string): Promise<boolean> {
  return (await getSecret(name)) !== null;
}

/** For the sheet and the UI: first 4 and last 2 characters. */
export function mask(v: string | undefined): string {
  if (!v) return "";
  return v.length <= 8 ? "••••" : `${v.slice(0, 4)}••••${v.slice(-2)}`;
}

/** Removes any known secret value from text before it is logged or shown. */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  return out;
}

export function _resetVault() { mem.clear(); db = undefined; }

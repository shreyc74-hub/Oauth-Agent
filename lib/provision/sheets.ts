// The tracker: one Google Sheet row per run. Status, sandbox, masked client ID and vault names,
// never a secret. Uses a Google service account (share the sheet with its email as Editor).
import "../env";
import { createSign } from "node:crypto";
import type { Run } from "./types";

export const HEADER = ["Run", "App", "Mode", "Strategy", "Status", "Sandbox", "Client ID", "Secrets in vault", "Verified as", "Refresh token", "Go-live needs", "Human steps", "Updated"];

export function sheetConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_SHEET_ID);
}

let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}") as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key.replace(/\\n/g, "\n")).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  if (!res.ok) throw new Error(`Google token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

const tab = () => process.env.GOOGLE_SHEET_TAB || "Credentials";
const api = (path: string) => `https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}${path}`;

async function sheetsFetch(path: string, init: RequestInit) {
  const res = await fetch(api(path), { ...init, headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" } });
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export function rowFor(run: Run, baseUrl: string): string[] {
  const human = run.events.filter((e) => e.kind === "handoff").map((e) => e.text.split(":")[0]).join("; ");
  return [
    `${baseUrl}/provision/${run.id}`,
    run.app,
    run.mode === "auto" ? "Full automation" : "Human in the loop",
    run.strategy,
    run.status,
    run.public.sandboxUrl || "",
    run.public.clientId ? `${run.public.clientId.slice(0, 6)}…${run.public.clientId.slice(-4)}` : "",
    Object.values(run.vault).filter((n) => !n.includes("/shared/")).join("\n"),
    run.verify?.who || "",
    run.verify?.refresh || "",
    run.goLive ? (run.goLive.needed ? run.goLive.summary : "Nothing") : "",
    human,
    run.updatedAt,
  ];
}

/** Adds the run's row the first time, then updates the same row. Returns the row number. */
export async function upsertRow(run: Run, baseUrl: string): Promise<number | undefined> {
  if (!sheetConfigured()) return undefined;
  const values = [rowFor(run, baseUrl)];
  if (run.sheetRow) {
    await sheetsFetch(`/values/${encodeURIComponent(`${tab()}!A${run.sheetRow}`)}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values }) });
    return run.sheetRow;
  }
  // Header on first use.
  const head = await sheetsFetch(`/values/${encodeURIComponent(`${tab()}!A1:A1`)}`, { method: "GET" }).catch(() => ({}));
  if (!(head as { values?: unknown[] }).values) {
    await sheetsFetch(`/values/${encodeURIComponent(`${tab()}!A1`)}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values: [HEADER] }) });
  }
  const r = await sheetsFetch(`/values/${encodeURIComponent(`${tab()}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: "POST", body: JSON.stringify({ values }) });
  const m = String((r as { updates?: { updatedRange?: string } }).updates?.updatedRange || "").match(/!A(\d+)/);
  return m ? Number(m[1]) : undefined;
}

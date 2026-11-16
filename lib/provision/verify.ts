// Proof that the credentials work: a real authorization against the sandbox, a token exchange,
// one identity call, and a refresh. A run is only "verified" if all of that succeeds.
import { randomBytes } from "node:crypto";
import type { OAuthSpec } from "./types";

export type Http = (url: string, init?: RequestInit) => Promise<Response>;

export function newState(): string { return randomBytes(18).toString("base64url"); }

export function authorizeUrl(o: OAuthSpec, clientId: string, redirectUri: string, state: string): string {
  const u = new URL(o.authorizeUrl);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", o.scopes.join(o.scopeSeparator ?? " "));
  u.searchParams.set("state", state);
  for (const [k, v] of Object.entries(o.extraAuthorizeParams || {})) u.searchParams.set(k, v);
  return u.toString();
}

/** Pulls the code out of the URL the browser landed on after consent, checking the state. */
export function codeFromUrl(url: string, state: string): string | null {
  try {
    const u = new URL(url);
    if (u.searchParams.get("state") !== state) return null;
    return u.searchParams.get("code");
  } catch { return null; }
}

export interface Tokens { access: string; refresh?: string; raw: Record<string, unknown> }

async function tokenCall(http: Http, o: OAuthSpec, params: Record<string, string>, clientId: string, secret: string): Promise<Tokens> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (o.clientAuth === "basic") headers.authorization = `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
  else { body.set("client_id", clientId); body.set("client_secret", secret); }
  const res = await http(o.tokenUrl, { method: "POST", headers, body });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // Slack answers 200 with ok:false.
  if (!res.ok || j.ok === false || j.error) throw new Error(`Token endpoint said ${res.status} ${String(j.error || j.error_description || j.message || "").slice(0, 120)}`);
  const access = String(j.access_token || (j.authed_user as { access_token?: string } | undefined)?.access_token || "");
  if (!access) throw new Error("Token endpoint returned no access token.");
  return { access, refresh: j.refresh_token ? String(j.refresh_token) : undefined, raw: j };
}

export const exchangeCode = (http: Http, o: OAuthSpec, code: string, redirectUri: string, clientId: string, secret: string) =>
  tokenCall(http, o, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, clientId, secret);

export const refreshTokens = (http: Http, o: OAuthSpec, refresh: string, clientId: string, secret: string) =>
  tokenCall(http, o, { grant_type: "refresh_token", refresh_token: refresh }, clientId, secret);

const pick = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), obj);

/** Calls the identity endpoint and returns a short human-readable answer ("Toolkit Sandbox"). */
export async function whoami(http: Http, o: OAuthSpec, access: string): Promise<string> {
  const w = o.whoami;
  const res = await http(w.url, {
    method: w.method || "GET",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json", accept: "application/json" },
    body: w.body ? JSON.stringify(w.body) : undefined,
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || j.ok === false || j.errors) throw new Error(`Identity call failed: ${res.status} ${JSON.stringify(j.error || j.errors || "").slice(0, 120)}`);
  return identityFrom(j, w.pick) ?? `account (identity call answered HTTP ${res.status})`;
}

const NAME_KEYS = ["login", "email", "username", "user_name", "name", "account_name", "accountname", "display_name", "full_name", "user_id", "id"];

/**
 * Pure: a short label for who the token belongs to. The planned path first; else a common identity field,
 * at the top level or one level down (data, user, login, account, viewer). A successful identity call is
 * proof enough that the token works even when no label is found, so callers fall back to a generic one.
 */
export function identityFrom(j: unknown, path: string): string | undefined {
  const ok = (v: unknown) => (typeof v === "string" && v.trim()) || typeof v === "number" ? String(v) : undefined;
  const direct = ok(pick(j, path));
  if (direct) return direct;
  const scopes = [j, ...["data", "user", "login", "account", "viewer", "me"].map((k) => pick(j, k))].filter((x) => x && typeof x === "object");
  for (const key of NAME_KEYS) for (const o of scopes) { const v = ok((o as Record<string, unknown>)[key]); if (v) return v; }
  return undefined;
}

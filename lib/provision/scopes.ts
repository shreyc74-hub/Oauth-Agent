// Use case in, scopes out. The person says what the app will do ("read invoices and create
// customers"); the agent maps that to the vendor's scopes, using the guide's scope table, and picks
// one read-only API call from the use case. Verification makes that call with the new token, so
// "verified" means the scopes work for the use case, not only that login works.
//
// Guardrails in code: the test call must be GET and must go to the vendor's own domain (the same
// base domain as the OAuth endpoints), so the token can't be sent anywhere else.
import { runClaude, RESOLVE_MODEL, jsonFromModel } from "../agent/claude";
import type { Guide } from "../schema";
import type { Playbook, ScopePlan } from "./types";

const baseDomain = (u: string) => { try { return new URL(u).hostname.split(".").slice(-2).join("."); } catch { return ""; } };

/** Pure: keeps a test call only if it is a GET to the vendor's own domain. */
export function safeTestCall(p: Playbook, call: unknown): ScopePlan["testCall"] | undefined {
  const c = call as { method?: string; url?: string; label?: string } | undefined;
  if (!c?.url || (c.method && c.method.toUpperCase() !== "GET")) return undefined;
  let u: URL;
  try { u = new URL(c.url); } catch { return undefined; }
  if (u.protocol !== "https:" || /[{}<>]/.test(c.url)) return undefined;
  const own = new Set([p.oauth.authorizeUrl, p.oauth.tokenUrl, p.oauth.whoami.url].map(baseDomain).filter(Boolean));
  if (!own.has(baseDomain(u.toString()))) return undefined;
  return { method: "GET", url: u.toString(), label: String(c.label || u.pathname).slice(0, 120) };
}

const SYSTEM = `You choose OAuth scopes for one app from a use case.
Return ONLY this JSON:
{"scopes":[string],"mapping":[{"need":"one thing the use case needs","scopes":[string],"why":"short"}],"testCall":{"method":"GET","url":"https://... a real read-only endpoint that needs these scopes, no placeholders","label":"what it reads"},"notes":[string]}
Rules: use the vendor's exact scope strings. Choose the smallest set that covers the use case. Always keep scopes the identity call needs. Prefer scopes that don't trigger app review; if the use case needs one that does, keep it and say so in notes. The test call must be GET, on the vendor's API, with no IDs or placeholders in the URL (list endpoints are ideal). If you are not sure of a real endpoint, omit testCall.`;

export async function planScopes(input: { useCase: string; guide?: Guide | null; playbook: Playbook; mock?: boolean }): Promise<ScopePlan> {
  const { useCase, guide, playbook: p } = input;
  if (input.mock) {
    return { useCase, scopes: p.oauth.scopes, mapping: [{ need: useCase, scopes: p.oauth.scopes, why: "Demo mode keeps the playbook's scopes." }], testCall: safeTestCall(p, { method: "GET", url: p.oauth.whoami.url, label: "identity" }), notes: [] };
  }
  const brief = {
    vendor: p.name,
    useCase,
    defaultScopes: p.oauth.scopes,
    identityCall: p.oauth.whoami,
    oauth: { authorizeUrl: p.oauth.authorizeUrl, tokenUrl: p.oauth.tokenUrl },
    guideScopes: guide?.scopes ? { rows: guide.scopes.rows, minimalSets: guide.scopes.minimalSets } : undefined,
  };
  const text = await runClaude({ model: RESOLVE_MODEL, system: SYSTEM, maxTokens: 2000, messages: [{ role: "user", content: JSON.stringify(brief) }] });
  const j = await jsonFromModel<{ scopes?: string[]; mapping?: ScopePlan["mapping"]; testCall?: unknown; notes?: string[] }>(text);
  let scopes = [...new Set((j.scopes || []).map(String).map((s) => s.trim()).filter((s) => s && !/\s/.test(s)))];
  const notes = (j.notes || []).map(String).slice(0, 5);
  if (!scopes.length) {
    // Some vendors have no scopes at all (ClickUp: a token can do whatever the user can). Keep the plan's
    // scopes, which the server ignores, and still use the test call to check the use case.
    scopes = p.oauth.scopes;
    notes.unshift(`No ${p.name} scopes were found for this use case (the vendor may not use scopes); keeping the plan's: ${scopes.join(", ")}.`);
  }
  const testCall = safeTestCall(p, j.testCall);
  if (j.testCall && !testCall) notes.push("The suggested test call was dropped: it was not a GET to the vendor's own API.");
  return { useCase, scopes, mapping: (j.mapping || []).slice(0, 10), testCall, notes };
}

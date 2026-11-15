// Dynamic Client Registration (RFC 7591) probe: can this vendor's OAuth app be created with one
// API call instead of a console? Vendors that support it publish a `registration_endpoint` in their
// authorization server metadata (RFC 8414 or OpenID Connect discovery). MCP servers publish
// protected-resource metadata (RFC 9728) that points at their authorization server, and the MCP
// authorization spec builds on DCR, so many SaaS MCP servers accept self-registered clients.
//
// Read-only and model-free: code fetches public .well-known documents and parses them. Nothing
// is registered here; using the endpoint would be a write, done in a run with approval.
import { publicUrl } from "../agent/render";
import type { Playbook } from "./types";

export interface DcrResult {
  available: boolean;
  /** "api": the vendor's main OAuth server. "mcp": the authorization server behind its MCP server
   * (tokens may only work for the MCP server, not the full REST API). */
  kind?: "api" | "mcp";
  registrationEndpoint?: string;
  issuer?: string;
  metadataUrl?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  scopesSupported?: string[];
  authMethods?: string[];
  /** Every document that was found, for the run page. */
  found: { url: string; kind: "api" | "mcp"; registration: boolean }[];
  checked: number;
  checkedOn: string;
}

export type Fetcher = (url: string) => Promise<unknown | null>;

/** Default fetcher: JSON only, short timeout, public URLs only, no redirects to other hosts. */
export const fetchJson: Fetcher = async (raw) => {
  const u = publicUrl(raw);
  if (!u) return null;
  try {
    const res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(6000), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    if (new URL(res.url).hostname !== u.hostname) return null;
    return await res.json();
  } catch { return null; }
};

const baseDomain = (h: string) => h.split(".").slice(-2).join(".");

/** Pure: which origins to look at, from the plan's OAuth URLs and the vendor's website. */
export function candidateOrigins(p: Pick<Playbook, "oauth">, website?: string): string[] {
  const hosts = new Set<string>();
  for (const u of [p.oauth.authorizeUrl, p.oauth.tokenUrl, p.oauth.whoami.url]) {
    try { hosts.add(new URL(u).hostname); } catch { /* not a URL */ }
  }
  const site = (website || "").replace(/^https?:\/\//, "").split("/")[0];
  const domains = new Set([...hosts].map(baseDomain));
  if (site) domains.add(baseDomain(site));
  for (const d of domains) { hosts.add(d); hosts.add(`api.${d}`); hosts.add(`auth.${d}`); hosts.add(`mcp.${d}`); }
  return [...hosts].filter((h) => publicUrl(`https://${h}`)).slice(0, 12).map((h) => `https://${h}`);
}

type Meta = { issuer?: string; registration_endpoint?: string; authorization_endpoint?: string; token_endpoint?: string; scopes_supported?: string[]; token_endpoint_auth_methods_supported?: string[] };
const isMeta = (j: unknown): j is Meta => Boolean(j && typeof j === "object" && ((j as Meta).authorization_endpoint || (j as Meta).token_endpoint || (j as Meta).issuer));

/** Pure: a registration endpoint is only trusted on https, on the same base domain as the document. */
export function registrationFrom(meta: Meta, docUrl: string): string | undefined {
  const r = meta.registration_endpoint;
  if (!r) return undefined;
  try {
    const ru = new URL(r), du = new URL(docUrl);
    if (ru.protocol !== "https:" || baseDomain(ru.hostname) !== baseDomain(du.hostname)) return undefined;
    return ru.toString();
  } catch { return undefined; }
}

export async function probeDcr(p: Pick<Playbook, "oauth">, website?: string, get: Fetcher = fetchJson): Promise<DcrResult> {
  const origins = candidateOrigins(p, website);
  const docs: { url: string; kind: "api" | "mcp" }[] = [];
  for (const o of origins) {
    const kind = new URL(o).hostname.startsWith("mcp.") ? "mcp" : "api";
    docs.push({ url: `${o}/.well-known/oauth-authorization-server`, kind }, { url: `${o}/.well-known/openid-configuration`, kind });
  }
  // MCP servers point to their authorization server through protected-resource metadata.
  const mcp = origins.filter((o) => new URL(o).hostname.startsWith("mcp."));
  const pointed = await Promise.all(mcp.map(async (o) => {
    const j = (await get(`${o}/.well-known/oauth-protected-resource`)) as { authorization_servers?: string[] } | null;
    return (j?.authorization_servers || []).filter((s) => { try { return baseDomain(new URL(s).hostname) === baseDomain(new URL(o).hostname); } catch { return false; } });
  }));
  for (const s of pointed.flat().slice(0, 4)) {
    const base = s.replace(/\/$/, "");
    docs.push({ url: `${base}/.well-known/oauth-authorization-server`, kind: "mcp" });
    // RFC 8414 path form, for issuers with a path.
    try { const u = new URL(base); if (u.pathname !== "/") docs.push({ url: `${u.origin}/.well-known/oauth-authorization-server${u.pathname}`, kind: "mcp" }); } catch { /* skip */ }
  }
  const unique = [...new Map(docs.map((d) => [d.url, d])).values()];
  const results = await Promise.all(unique.map(async (d) => ({ ...d, meta: await get(d.url) })));
  const found = results.filter((r) => isMeta(r.meta)).map((r) => ({ url: r.url, kind: r.kind, meta: r.meta as Meta, registration: registrationFrom(r.meta as Meta, r.url) }));
  // Prefer the vendor's main OAuth server over an MCP one.
  const best = found.find((f) => f.registration && f.kind === "api") || found.find((f) => f.registration);
  const today = new Date().toISOString().slice(0, 10);
  const out: DcrResult = {
    available: Boolean(best), found: found.map((f) => ({ url: f.url, kind: f.kind, registration: Boolean(f.registration) })),
    checked: unique.length + mcp.length, checkedOn: today,
  };
  if (best) {
    Object.assign(out, {
      kind: best.kind, registrationEndpoint: best.registration, issuer: best.meta.issuer, metadataUrl: best.url,
      authorizationEndpoint: best.meta.authorization_endpoint, tokenEndpoint: best.meta.token_endpoint,
      scopesSupported: (best.meta.scopes_supported || []).slice(0, 40), authMethods: best.meta.token_endpoint_auth_methods_supported,
    });
  }
  return out;
}

/** One line for the log and the run page. */
export function describeDcr(d: DcrResult | undefined): string {
  if (!d) return "Not checked.";
  if (!d.available) return `Not offered: no registration_endpoint in ${d.found.length ? `the ${d.found.length} OAuth metadata document(s) found` : "any OAuth metadata document"} (${d.checked} addresses checked).`;
  return `Offered${d.kind === "mcp" ? " by the vendor's MCP server (tokens may only work for MCP, not the full API)" : ""}: ${d.registrationEndpoint}. An app could be registered with one API call instead of the console.`;
}

// Step one of provisioning: can a stranger get a working test account for this vendor at all,
// without sales, a partner programme or an existing paid subscription?
//
// The model only gathers evidence. Code decides:
//   1. The research agent searches the vendor's docs and returns a sign-up URL plus verbatim quotes
//      that say yes (free developer account, sandbox, trial) or no (contact sales, partners only).
//   2. Code fetches every cited page and keeps a quote only if it is really on that page.
//   3. Code probes the sign-up URL: a form with email/password or "Sign up with Google" looks
//      self-serve; "Request a demo" or "Contact sales" looks gated.
//   4. combine() turns found quotes + probe into a verdict. Only quoted evidence can block a run.
// Results are cached per vendor; a verified run upgrades the vendor to source "run".
import "../env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cleanSupabaseUrl } from "../store";
import { runClaude, webTools, RESOLVE_MODEL, jsonFromModel } from "../agent/claude";
import { htmlToText, isThin, publicUrl, renderPage, renderProvider } from "../agent/render";
import { noProgress, type Playbook, type Progress, type ProvisionBrief, type SandboxCheck, type SetupPart } from "./types";

const TTL_MS = 14 * 24 * 3600_000;
const today = () => new Date().toISOString().slice(0, 10);

// ---------- Deciding ----------

type Probe = NonNullable<SandboxCheck["probe"]>;

/** Pure: found quotes and the sign-up page probe -> verdict. */
export function combine(quotes: SandboxCheck["quotes"], probe: Probe | undefined): { verdict: SandboxCheck["verdict"]; why: string } {
  const yes = quotes.filter((q) => q.found && q.says === "yes").length;
  const no = quotes.filter((q) => q.found && q.says === "no").length;
  const looks = probe?.looks;
  if (no && !yes) return { verdict: "gated", why: "The vendor's own pages say a test account needs sales, a partner programme or an existing subscription." };
  if (yes && no) return { verdict: "unknown", why: `The vendor's pages point both ways: ${yes} quote${yes > 1 ? "s" : ""} support${yes > 1 ? "" : "s"} self-serve access and ${no} say${no > 1 ? "" : "s"} access is limited or gated.` };
  if (yes && looks === "signup_form") return { verdict: "self_serve", why: "The docs offer a free account and the sign-up page is a self-serve form." };
  if (yes && looks === "sales_gate") return { verdict: "unknown", why: "The docs mention a free account, but the sign-up page leads to sales or a demo request." };
  if (yes) return { verdict: "likely_self_serve", why: "The docs offer a free account; the sign-up page could not be confirmed." };
  if (looks === "signup_form") return { verdict: "likely_self_serve", why: "No quote was confirmed, but the sign-up page is a self-serve form." };
  return { verdict: "unknown", why: "No confirmed evidence either way." };
}

const norm = (t: string) => t.toLowerCase().replace(/[‘’“”"'`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** A quote counts if the page contains it, or any 8 consecutive words of it (quotes get trimmed or joined). */
export function quoteOnPage(quote: string, pageText: string): boolean {
  const q = norm(quote), p = norm(pageText);
  if (!q || !p) return false;
  if (p.includes(q)) return true;
  const w = q.split(" ");
  if (w.length < 8) return false;
  for (let i = 0; i + 8 <= w.length; i++) if (p.includes(w.slice(i, i + 8).join(" "))) return true;
  return false;
}

/** Pure: what a sign-up page's HTML (or rendered text) looks like. */
export function classifyPage(content: string, isHtml: boolean): { signals: string[]; looks: Probe["looks"] } {
  const t = content.toLowerCase();
  const text = isHtml ? htmlToText(content).toLowerCase() : t;
  const signals: string[] = [];
  if (isHtml ? /type\s*=\s*["']?password/.test(t) : /\bpassword\b/.test(t)) signals.push("password field");
  if (isHtml ? /type\s*=\s*["']?email|name\s*=\s*["']?(email|login|username)/.test(t) : /\b(work )?email\b/.test(t)) signals.push("email field");
  if (/(sign (up|in)|continue|register) with google/.test(text)) signals.push("sign up with Google");
  if (/\b(create (an |your )?(free )?account|sign up free|start (for )?free|get started free|free developer account|create a developer account)\b/.test(text)) signals.push("free sign-up wording");
  if (/\b(contact sales|talk to sales|talk to an expert|request a demo|book a demo|schedule a demo|get a demo)\b/.test(text)) signals.push("sales or demo request");
  if (/\b(partner program|partner programme|become a partner|apply to (join|become)|partner application)\b/.test(text)) signals.push("partner programme");
  if (/\b(request access|join the waitlist|waitlist|invitation only|invite only)\b/.test(text)) signals.push("access by request");
  const self = signals.some((s) => s === "password field" || s === "sign up with Google" || s === "free sign-up wording");
  const gate = signals.some((s) => s === "sales or demo request" || s === "partner programme" || s === "access by request");
  // Marketing pages often have a "Contact sales" link next to a real sign-up form; a form wins.
  const looks = self ? "signup_form" : gate ? "sales_gate" : "unclear";
  return { signals, looks };
}

// ---------- Fetching ----------

async function fetchPage(raw: string): Promise<{ text: string; html?: string; finalUrl?: string; status?: number } | null> {
  const u = publicUrl(raw);
  if (!u) return null;
  try {
    const res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(12_000), headers: { "user-agent": "Mozilla/5.0 (compatible; ToolkitProvisioningAgent/1.0)", accept: "text/html,*/*" } });
    const html = await res.text();
    if (!isThin(html) || renderProvider() === "off") return { text: htmlToText(html), html, finalUrl: res.url, status: res.status };
    // A JavaScript app shell: read it rendered instead.
    const r = await renderPage(u.toString(), { timeoutMs: 20_000 }).catch(() => null);
    return { text: r?.text || htmlToText(html), html: r ? undefined : html, finalUrl: res.url, status: res.status };
  } catch {
    const r = await renderPage(u.toString(), { timeoutMs: 20_000 }).catch(() => null);
    return r ? { text: r.text } : null;
  }
}

export async function probeSignup(url: string): Promise<Probe> {
  const page = await fetchPage(url);
  if (!page) return { url, signals: [], looks: "unreachable" };
  const { signals, looks } = page.html ? classifyPage(page.html, true) : classifyPage(page.text, false);
  return { url, finalUrl: page.finalUrl, status: page.status, signals, looks };
}

const pageText = (u: string) => fetchPage(u).then((p) => p?.text || "");

export async function checkQuotes(quotes: { quote: string; url: string; says: "yes" | "no" }[], read = pageText): Promise<SandboxCheck["quotes"]> {
  const pages = new Map<string, Promise<string>>();
  const text = (u: string) => { if (!pages.has(u)) pages.set(u, read(u).catch(() => "")); return pages.get(u)!; };
  return Promise.all(quotes.slice(0, 6).map(async (q) => ({ ...q, found: quoteOnPage(q.quote, await text(q.url)) })));
}

// ---------- Research ----------

const SYSTEM = `You map how a stranger gets set up to build and test an OAuth integration with one software vendor.
There are three separate questions. Answer each with evidence from the vendor's own pages.

1. developerAccount: where is the OAuth app created and managed? (Slack: api.slack.com/apps with a Slack login. Zoho: the API Console. HubSpot: a developer account. Linear: the workspace's settings.) Can anyone sign up for it themselves?
2. sandbox: the working environment the app is installed in and tested against, with real data. (Slack: a workspace, e.g. a Developer Program sandbox. HubSpot: a developer test account. Zoho Invoice: an Invoice organization. Salesforce: a Developer Edition org.) Is it the SAME account as the developer side, or a SEPARATE one? Can anyone create it themselves, and does it expire (e.g. a 14-day trial)?
3. oauthApp: can anyone create an OAuth app, or is OAuth only for approved partners or marketplace members? Can anyone get an API key instead? (BambooHR: API key from the dashboard, OAuth for marketplace partners.)

"yes" (self-serve): a free account, free plan, free trial, developer sandbox or developer programme that anyone can join today.
"no" (gated or limited): contact sales, book a demo, partner programme application, approval, invitation, a waitlist or limited availability, or existing paying customers only.
Only quotes about access TODAY count. History ("used to require an invitation") is not evidence, and neither are policies that say nothing about who may get access (deletion after inactivity, rate limits, pricing of paid tiers).

Use web_search and web_fetch on official pages (developer docs, partner pages, pricing, sign-up). Return ONLY this JSON:
{"summary":"one plain sentence a busy product manager understands, e.g. 'Free developer account for anyone; test tenants come from a limited beta and are approved only when capacity allows.'",
 "relation":"same"|"separate",
 "developerAccount":{"name":string,"signupUrl":string,"selfServe":"yes"|"no"|"unclear","reason":string,"humanPath":string,"quotes":[Quote]},
 "sandbox":{"name":string,"signupUrl":string,"selfServe":"yes"|"no"|"unclear","expires":string,"reason":string,"humanPath":string,"quotes":[Quote]},
 "oauthApp":{"available":"self_serve"|"partner_only"|"none"|"unclear","apiKeySelfServe":boolean,"reason":string,"humanPath":string,"quotes":[Quote]},
 "credentials":[{"type":"oauth2"|"oauth1"|"client_credentials"|"api_key"|"jwt"|"service_account"|"basic"|"bearer","where":"where in the product it is created, e.g. Settings > API > Generate key","selfServe":"yes"|"no"|"unclear","quote":Quote}]}
credentials: every way the vendor's API can be authenticated, one entry per type, each with one quote from the vendor's docs.
Also add "resources", collected from the vendor's OFFICIAL pages, so a provisioning plan can be written from it without a separate guide:
"resources":{"website":"vendor.com","docs":[{"label":"Sign up / developer account","url":string},{"label":"Create an OAuth app","url":string},{"label":"OAuth endpoints","url":string},{"label":"Scopes","url":string}],
 "steps":[{"title":"imperative, under 9 words","detail":"what to click or fill, from the docs","owner":"agent"|"you"}],   // in order: create the developer account (and the separate sandbox, if any), then create the OAuth app (or API key) and read its credentials. "you" only for payment, phone, identity or legal steps.
 "oauth":{"authorizeUrl":"https://...","tokenUrl":"https://...","identity":{"url":"https://... an endpoint that returns the signed-in user or account","method":"GET"|"POST","pick":"JSON path to a name or id"},"scopes":["the smallest set that lets the identity call work"],"clientAuth":"body"|"basic"},
 "apiKey":{"header":"Authorization or the vendor's header","prefix":"Bearer, or omit","testUrl":"https://... a read-only GET that needs the key"},   // only when an API key is the self-serve credential
 "goLive":"one sentence: what review or approval going to production needs, or 'none'"}
Use exact URLs and scope names from the docs. Omit anything you could not find rather than guessing.
Also add "appCreation":{"kind":"management_api"|"cli"|"manifest"|"none","detail":"the documented API endpoint, CLI command or manifest flow that creates an OAuth app without the web console","quote":Quote}. Use "none" unless the vendor's own docs describe one.
Quote is {"quote":"a sentence copied word for word from the page","url":"the exact page URL","says":"yes"|"no"} where "yes" supports self-serve and "no" supports gated.
When relation is "same", the sandbox may repeat the developer account's name and URL with no quotes of its own.
humanPath: what a person must do when it is gated or unclear (e.g. "apply to the partner programme at <url>"). Empty when self-serve.
Give 1 to 3 quotes per question. Copy quotes exactly: each is checked against its page, and paraphrases are thrown away.
The answer must be valid JSON: inside a string, write any double quote from the page as a single quote (').`;

type RawQuote = { quote: string; url: string; says: "yes" | "no" };
type RawPart = { name?: string; signupUrl?: string; selfServe?: string; reason?: string; humanPath?: string; expires?: string; quotes?: RawQuote[] };
export type Found = {
  summary?: string;
  relation?: string;
  developerAccount?: RawPart;
  sandbox?: RawPart;
  oauthApp?: { available?: string; apiKeySelfServe?: boolean; reason?: string; humanPath?: string; quotes?: RawQuote[] };
  credentials?: { type?: string; where?: string; selfServe?: string; quote?: RawQuote }[];
  appCreation?: { kind?: string; detail?: string; quote?: RawQuote };
  resources?: Partial<ProvisionBrief> & { oauth?: Partial<NonNullable<ProvisionBrief["oauth"]>>; apiKey?: Partial<NonNullable<ProvisionBrief["apiKey"]>> };
};

const https = (u: unknown) => typeof u === "string" && /^https:\/\/[^/\s]+\.[^/\s]+/.test(u) && !/[{}<>]/.test(u);

/** Pure: keeps only well-formed parts of the brief (https URLs, non-empty steps). */
export function cleanBrief(r: Found["resources"]): ProvisionBrief | undefined {
  if (!r) return undefined;
  const docs = (r.docs || []).filter((d) => d && https(d.url)).slice(0, 8).map((d) => ({ label: String(d.label || "Docs").slice(0, 60), url: String(d.url) }));
  const steps = (r.steps || []).filter((s) => s && s.title).slice(0, 14).map((s) => ({ title: String(s.title).slice(0, 80), detail: String(s.detail || "").slice(0, 400), owner: s.owner === "you" ? "you" as const : "agent" as const }));
  const o = r.oauth;
  const oauth = o && https(o.authorizeUrl) && https(o.tokenUrl) ? {
    authorizeUrl: String(o.authorizeUrl), tokenUrl: String(o.tokenUrl),
    identity: o.identity && https(o.identity.url) ? { url: String(o.identity.url), method: o.identity.method === "POST" ? "POST" as const : "GET" as const, pick: String(o.identity.pick || "id") } : undefined,
    scopes: (o.scopes || []).map(String).filter((x) => x && !/\s/.test(x)).slice(0, 20), clientAuth: o.clientAuth === "basic" ? "basic" as const : o.clientAuth === "body" ? "body" as const : undefined,
  } : undefined;
  const k = r.apiKey;
  const apiKey = k && k.header && https(k.testUrl) ? { header: String(k.header), prefix: k.prefix ? String(k.prefix) : undefined, testUrl: String(k.testUrl), pick: k.pick ? String(k.pick) : undefined } : undefined;
  if (!steps.length && !oauth && !apiKey) return undefined;
  return { website: r.website ? String(r.website).replace(/^https?:\/\//, "").split("/")[0] : undefined, docs, steps, oauth, apiKey, goLive: r.goLive ? String(r.goLive).slice(0, 300) : undefined };
}

const CRED_TYPES = new Set(["oauth2", "oauth1", "client_credentials", "api_key", "jwt", "service_account", "basic", "bearer"]);

/**
 * Lean by default: start from what the model already knows and only search or fetch to confirm, with
 * small page extracts. Every fetched page stays in context and is re-read on each step, so page size and
 * count, not the number of calls, drive the cost. PROVISION_RESEARCH=full restores the wide budget.
 */
export const researchBudget = () => process.env.PROVISION_RESEARCH === "full"
  ? { searches: 6, fetches: 8, pageTokens: 30000, lean: false }
  : { searches: 3, fetches: 3, pageTokens: 6000, lean: true };

const LEAN = `Work fast and cheap. Start from what you already know about this vendor. Use web_search or web_fetch only to confirm what you are unsure of: exact URLs, the quotes (they must be copied word for word from a page), endpoints and scope names. At most 3 searches and 3 fetches; stop as soon as you can answer. Prefer one official page that answers several questions.

`;

export async function researchSandbox(app: { name: string; website?: string }, onTool: (name: string, input: Record<string, unknown>) => void = () => undefined): Promise<Found> {
  const b = researchBudget();
  const text = await runClaude({
    model: RESOLVE_MODEL, system: b.lean ? LEAN + SYSTEM : SYSTEM, maxTokens: 6000, tools: webTools(b.searches, b.fetches, b.pageTokens),
    messages: [{ role: "user", content: `Vendor: ${app.name}${app.website ? ` (${app.website})` : ""}` }],
  }, { onToolUse: onTool });
  return jsonFromModel<Found>(text);
}

/** The network side of the check; tests swap it for fixed pages. */
export interface SandboxIo { research: typeof researchSandbox; pageText: (url: string) => Promise<string>; probe: typeof probeSignup }
export const liveSandboxIo: SandboxIo = { research: researchSandbox, pageText, probe: probeSignup };

const RANK: Record<SandboxCheck["verdict"], number> = { gated: 0, unknown: 1, likely_self_serve: 2, self_serve: 3 };
/** Pure: the overall verdict is the weakest part's. */
export const weakest = (parts: SetupPart[]): SandboxCheck["verdict"] => parts.reduce<SandboxCheck["verdict"]>((w, p) => (RANK[p.verdict] < RANK[w] ? p.verdict : w), "self_serve");

const validQuotes = (q?: RawQuote[]) => (q || []).filter((x) => x && x.quote && x.url && (x.says === "yes" || x.says === "no"));

const PART_LABEL: Record<SetupPart["role"], string> = { developer_account: "Developer side", sandbox: "Sandbox", oauth_app: "OAuth app" };

async function judgePart(role: SetupPart["role"], raw: RawPart | undefined, io: SandboxIo, withProbe: boolean, progress: Progress = noProgress): Promise<SetupPart> {
  const read = async (u: string) => {
    const t = await io.pageText(u).catch(() => "");
    progress({ id: `page:${role}:${u}`, label: `GET ${u}`, state: t ? "done" : "fail", detail: t ? `page read (${t.length.toLocaleString()} characters)` : "couldn't read the page" });
    return t;
  };
  const quotes = await checkQuotes(validQuotes(raw?.quotes), read);
  for (const q of quotes) progress({ id: `quote:${role}:${q.quote.slice(0, 40)}`, label: `${PART_LABEL[role]}: quote ${q.found ? "found" : "NOT found"} on the page`, state: q.found ? "done" : "fail", detail: `"${q.quote.slice(0, 140)}" (${q.says === "yes" ? "says self-serve" : "says gated"})` });
  const url = raw?.signupUrl && publicUrl(raw.signupUrl) ? raw.signupUrl : undefined;
  if (withProbe && url) progress({ id: `probe:${role}`, label: `Probe ${PART_LABEL[role].toLowerCase()} sign-up page`, state: "start", detail: url });
  const probe = withProbe && url ? await io.probe(url) : undefined;
  if (probe) progress({ id: `probe:${role}`, label: `Probe ${PART_LABEL[role].toLowerCase()} sign-up page`, state: probe.looks === "unreachable" ? "fail" : "done", detail: `${url}: ${probe.looks.replace("_", " ")}${probe.signals.length ? ` (${probe.signals.join(", ")})` : ""}` });
  const { verdict, why } = combine(quotes, probe);
  const dropped = quotes.filter((q) => !q.found).length;
  return {
    role, name: String(raw?.name || role.replace("_", " ")), url, verdict,
    reason: `${why}${raw?.reason ? ` ${raw.reason}` : ""}${dropped ? ` (${dropped} quote${dropped > 1 ? "s" : ""} not found on the cited page, ignored.)` : ""}`,
    humanPath: verdict === "gated" || verdict === "unknown" ? raw?.humanPath || undefined : undefined,
    expires: raw?.expires || undefined, quotes, probe,
  };
}

/** Full check for a vendor without a hand-written playbook: developer side, sandbox and OAuth availability. */
export async function checkSandbox(app: { name: string; slug: string; website?: string }, io: SandboxIo = liveSandboxIo, progress: Progress = noProgress): Promise<SandboxCheck> {
  progress({ id: "sandbox:research", label: "Claude researches the developer side, sandbox and OAuth availability", state: "start", detail: "web search and fetch on the vendor's own pages" });
  let calls = 0;
  const found = await io.research(app, (name, input) => {
    calls++;
    const what = String(input.query || input.url || "");
    progress({ id: `sandbox:tool:${calls}`, label: name === "web_search" ? `web_search "${what}"` : name === "web_fetch" ? `web_fetch ${what}` : name, state: "info" });
  });
  progress({ id: "sandbox:research", label: "Claude researches the developer side, sandbox and OAuth availability", state: "done", detail: `${calls} web call${calls === 1 ? "" : "s"}; now checking its quotes against the pages` });
  const relation: SandboxCheck["relation"] = found.relation === "same" || found.relation === "separate" ? found.relation : "unknown";
  const dev = await judgePart("developer_account", found.developerAccount, io, true, progress);
  let box: SetupPart;
  if (relation === "same") {
    // One account is both: it stands or falls with the developer side.
    box = { ...dev, role: "sandbox", name: found.sandbox?.name || dev.name, expires: found.sandbox?.expires || undefined, reason: `Same account as the developer side. ${dev.reason}` };
  } else {
    box = await judgePart("sandbox", found.sandbox, io, true, progress);
  }
  const o = found.oauthApp;
  const oauthPart = await judgePart("oauth_app", { name: "OAuth app", reason: o?.reason, humanPath: o?.humanPath, quotes: o?.quotes }, io, false, progress);
  const available = o?.available === "self_serve" || o?.available === "partner_only" || o?.available === "none" ? o.available : "unknown";
  const credential = { oauth: available, apiKey: Boolean(o?.apiKeySelfServe) } as NonNullable<SandboxCheck["credential"]>;
  if (oauthPart.verdict === "gated" && credential.apiKey) {
    oauthPart.reason += " An API key is self-serve, but this agent creates OAuth apps.";
  }
  // Credential types the vendor offers, each with its quote checked against the page.
  const offered: NonNullable<SandboxCheck["offered"]> = [];
  for (const c of (found.credentials || []).slice(0, 8)) {
    if (!c?.type || !CRED_TYPES.has(c.type)) continue;
    const [q] = c.quote ? await checkQuotes(validQuotes([c.quote]), io.pageText) : [];
    offered.push({ type: c.type as NonNullable<SandboxCheck["offered"]>[number]["type"], where: c.where ? String(c.where).slice(0, 160) : undefined,
      selfServe: c.selfServe === "yes" || c.selfServe === "no" ? c.selfServe : "unclear", quote: q ? { quote: q.quote, url: q.url, found: q.found } : undefined });
    if (q) progress({ id: `cred:${c.type}`, label: `Credential ${c.type}: quote ${q.found ? "found" : "NOT found"} on the page`, state: q.found ? "done" : "fail", detail: `"${q.quote.slice(0, 120)}"` });
  }
  // A documented non-console way to create the OAuth app counts only with a quote found on the page.
  let creation: SandboxCheck["creation"];
  const ac = found.appCreation;
  if (ac?.kind && ["management_api", "cli", "manifest"].includes(ac.kind) && ac.detail) {
    const [q] = ac.quote ? await checkQuotes(validQuotes([ac.quote]), io.pageText) : [];
    if (q?.found) creation = { kind: ac.kind as NonNullable<SandboxCheck["creation"]>["kind"], detail: String(ac.detail).slice(0, 200), quote: { quote: q.quote, url: q.url, found: true } };
    progress({ id: "creation", label: `App creation without the console (${ac.kind.replace("_", " ")}): quote ${q?.found ? "found" : "NOT found"}`, state: q?.found ? "done" : "fail", detail: String(ac.detail).slice(0, 140) });
  }
  const parts = [dev, box, oauthPart];
  // OAuth being partner-only only blocks the run when there is no self-serve API key either:
  // with a key, the agent provisions the key instead.
  const keyInstead = credential.apiKey || offered.some((o) => (o.type === "api_key" || o.type === "bearer") && o.selfServe !== "no");
  const verdict = weakest(keyInstead ? [dev, box] : parts);
  const worst = parts.filter((p) => p.verdict === verdict);
  const label = (p: SetupPart) => (p.role === "developer_account" ? "Developer side" : p.role === "sandbox" ? "Sandbox" : "OAuth app");
  const reason = verdict === "self_serve" || verdict === "likely_self_serve"
    ? `Developer side: ${dev.name}. Sandbox: ${box.name}${relation === "same" ? " (same account)" : relation === "separate" ? " (a separate account)" : ""}${box.expires ? `, expires: ${box.expires}` : ""}.`
    : worst.map((p) => `${label(p)} (${p.name}): ${p.reason}`).join(" ");
  return {
    verdict, reason, relation, parts, credential, offered, creation, summary: found.summary ? String(found.summary).slice(0, 300) : undefined, resources: cleanBrief(found.resources),
    humanPath: worst.map((p) => p.humanPath).filter(Boolean).join(" ") || undefined,
    signupUrl: dev.url, quotes: parts.flatMap((p) => p.quotes), probe: dev.probe,
    source: "research", checkedOn: today(),
  };
}

/** Hand-written playbooks were checked by a person (Linear by a real run). */
export function fromPlaybook(p: Playbook): SandboxCheck {
  return { verdict: "self_serve", reason: `${p.sandbox.kind}: ${p.sandbox.note}`, relation: p.sandbox.relation, quotes: [], source: "playbook", checkedOn: today() };
}

// ---------- Cache ----------

let db: SupabaseClient | null | undefined;
function supabase(): SupabaseClient | null {
  if (db !== undefined) return db;
  const url = cleanSupabaseUrl(process.env.SUPABASE_URL);
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  db = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return db;
}
const mem = new Map<string, { at: number; data: SandboxCheck }>();

export async function cachedSandbox(slug: string): Promise<SandboxCheck | null> {
  const s = supabase();
  let hit: { at: number; data: SandboxCheck } | undefined = mem.get(slug);
  if (!hit && s) {
    const { data } = await s.from("provision_sandbox").select("data, checked_at").eq("slug", slug).maybeSingle();
    if (data) hit = { at: Date.parse((data as { checked_at: string }).checked_at), data: (data as { data: SandboxCheck }).data };
  }
  if (!hit) return null;
  // A verdict proven by a run doesn't expire; researched ones are re-checked after two weeks.
  if (hit.data.source !== "run" && Date.now() - hit.at > TTL_MS) return null;
  return hit.data;
}

export async function saveSandbox(slug: string, check: SandboxCheck): Promise<void> {
  mem.set(slug, { at: Date.now(), data: check });
  const s = supabase();
  if (s) await s.from("provision_sandbox").upsert({ slug, data: check, checked_at: new Date().toISOString() });
}

export function _resetSandboxCache() { mem.clear(); db = undefined; }

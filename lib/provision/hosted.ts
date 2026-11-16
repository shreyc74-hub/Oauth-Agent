// The hosted browser agent route: Browser Use, called through Composio's tool API.
//
// Our app stays the orchestrator. It writes the task from the research, starts a Browser Use run,
// and between runs does what a hosted agent can't: reads email codes and links from our own inbox,
// hands real walls to a person, stores secrets in the vault and verifies them. Browser Use only
// drives the browser. One Browser Use session keeps the same browser across every run of a job, so
// "stop for the email code, then continue" resumes on the same page.
//
// Live-tested by hand on 2026-11-15 (Zoom, Linear and the Anthropic Console: account, app or key
// created with no person). This module's own calls to Composio's REST API are not live-tested yet.
import type { Mode } from "./types";

export type HostedStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";

export interface HostedAgent {
  start(input: { task: string; sessionId?: string; secrets?: { alias: string; value: string; domains: string[] }[] }): Promise<{ runId: string; sessionId: string }>;
  get(runId: string): Promise<{ status: HostedStatus; result: string | null; error: string | null }>;
  /** The live view of the hosted browser, for a person to take over at a wall. Best effort. */
  liveUrl(runId: string): Promise<string | undefined>;
}

export const hostedMode = (): string => (process.env.PROVISION_BROWSER_AGENT || "browser_use").trim().toLowerCase();
/** Browser Use through Composio is used for full automation when a Composio key is set, unless turned off. */
export const hostedConfigured = (): boolean => Boolean(process.env.COMPOSIO_API_KEY) && hostedMode() !== "stagehand";

class ConfigError extends Error { name = "ConfigError"; }

/**
 * One Composio tool call. Composio holds the Browser Use connection, so no Browser Use key lives here.
 * A consumer key (ck_…) goes through Composio's MCP endpoint, the same route as Composio's own MCP
 * clients, which also reaches Composio's free shared ("instant") Browser Use account. A project API key
 * goes through the REST API.
 */
export async function composioExecute(slug: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key) throw new ConfigError("COMPOSIO_API_KEY is not set, so the Browser Use route can't run");
  if (key.startsWith("ck_") || process.env.COMPOSIO_TRANSPORT === "mcp") return composioMcp(slug, args, key);
  const base = (process.env.COMPOSIO_BASE_URL || "https://backend.composio.dev").replace(/\/$/, "");
  const body: Record<string, unknown> = { arguments: args, user_id: process.env.COMPOSIO_USER_ID || "default" };
  if (process.env.COMPOSIO_CONNECTED_ACCOUNT_ID) body.connected_account_id = process.env.COMPOSIO_CONNECTED_ACCOUNT_ID;
  if (process.env.COMPOSIO_TOOLKIT_VERSION) body.version = process.env.COMPOSIO_TOOLKIT_VERSION;
  else body.dangerously_skip_version_check = true;
  const res = await fetch(`${base}/api/v3/tools/execute/${encodeURIComponent(slug)}`, {
    method: "POST", headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  const err = String((j.error as { message?: string })?.message || j.error || "").slice(0, 300);
  if (res.status === 401 || res.status === 403) throw new ConfigError(`Composio rejected the API key (${res.status}). Check COMPOSIO_API_KEY${err ? `: ${err}` : ""}`);
  if (/out of credits|no active connection|not connected|connected account/i.test(err)) throw new ConfigError(`Composio can't run ${slug}: ${err}`);
  if (!res.ok || j.successful === false) throw new Error(`Composio ${slug} failed (${res.status}): ${err || text.slice(0, 200)}`);
  return (j.data || {}) as Record<string, unknown>;
}

/** Composio's MCP endpoint: tools/call on its multi-execute tool, answered as JSON or a server-sent event. */
async function composioMcp(slug: string, args: Record<string, unknown>, key: string): Promise<Record<string, unknown>> {
  const url = process.env.COMPOSIO_MCP_URL || "https://connect.composio.dev/mcp";
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-consumer-api-key": key, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: slug, arguments: args }], sync_response_to_workbench: false, thought: "provisioning agent" } } }),
    signal: AbortSignal.timeout(90_000),
  });
  if (res.status === 401 || res.status === 403) throw new ConfigError(`Composio rejected the API key (${res.status}). Check COMPOSIO_API_KEY`);
  return readMcpResult(slug, res.status, await res.text());
}

/** Pure: the tool's own result out of an MCP reply (plain JSON or SSE "data:" lines). */
export function readMcpResult(slug: string, status: number, body: string): Record<string, unknown> {
  const data = body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  let rpc: { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } } = {};
  try { rpc = JSON.parse(data.length ? data[data.length - 1] : body); } catch { throw new Error(`Composio ${slug}: unreadable reply (${status}): ${body.slice(0, 160)}`); }
  if (rpc.error) throw new Error(`Composio ${slug} failed: ${String(rpc.error.message || "").slice(0, 200)}`);
  const text = rpc.result?.content?.[0]?.text || "";
  let outer: { successful?: boolean; error?: string | null; data?: { results?: { response?: { successful?: boolean; data?: Record<string, unknown>; data_preview?: Record<string, unknown>; error?: string | null }; error?: string | null }[] } } = {};
  try { outer = JSON.parse(text); } catch { throw new Error(`Composio ${slug} failed: ${text.slice(0, 200)}`); }
  const r = outer.data?.results?.[0];
  const err = String(r?.error || r?.response?.error || (outer.successful === false ? outer.error : "") || "").slice(0, 300);
  if (/out of credits|no active connection|not connected|connect their own account|unavailable on instant/i.test(err)) throw new ConfigError(`Composio can't run ${slug}: ${err}`);
  if (err || !r?.response?.successful) throw new Error(`Composio ${slug} failed: ${err || "no result"}`);
  // Large replies come back shortened as data_preview; callers ask for small pages so this rarely matters.
  return r.response.data || r.response.data_preview || {};
}

const STATUSES: HostedStatus[] = ["queued", "running", "completed", "failed", "cancelled"];
const toStatus = (s: unknown): HostedStatus => (STATUSES.includes(String(s) as HostedStatus) ? (String(s) as HostedStatus) : /^(created|dispatch|start|pending)/.test(String(s)) ? "running" : "unknown");

export function browserUseViaComposio(exec = composioExecute): HostedAgent {
  return {
    async start({ task, sessionId, secrets }) {
      const args: Record<string, unknown> = { task, model: process.env.BROWSER_USE_MODEL || "gpt-5.6-luna", max_cost_usd: Number(process.env.BROWSER_USE_MAX_COST_USD || 5) };
      if (sessionId) args.session_id = sessionId;
      if (secrets?.length) args.secret_bindings = secrets.map((s) => ({ alias: s.alias, source: { type: "inline", value: s.value }, allowedDomains: s.domains.slice(0, 10) }));
      const d = await exec("BROWSER_USE_START_RUN", args);
      const runId = String(d.id || ""), sid = String(d.session_id || sessionId || "");
      if (!runId) throw new Error("Browser Use did not return a run id");
      return { runId, sessionId: sid };
    },
    async get(runId) {
      const d = await exec("BROWSER_USE_GET_RUN", { run_id: runId });
      const r = (d.run || d) as Record<string, unknown>;
      return { status: toStatus(r.status), result: r.result == null ? null : String(r.result), error: r.error == null ? null : String(r.error) };
    },
    async liveUrl(runId) {
      try {
        // The browser is attached within the first few events; a small page keeps the reply whole.
        const d = await exec("BROWSER_USE_LIST_RUN_EVENTS", { run_id: runId, include_output: false, limit: 8 });
        for (const e of (d.items || []) as { type?: string; data?: { live_view_url?: string } }[]) {
          const u = e.data?.live_view_url;
          if (u && /^https:\/\//.test(u)) return u;
        }
      } catch { /* best effort */ }
      return undefined;
    },
  };
}

// ---------- Tasks: written by our app, carried out by the hosted agent ----------

export interface TaskInput {
  app: string;
  credential: "oauth" | "api_key";
  email: string;
  /** The vendor already has an account for this mailbox: sign in, don't sign up. */
  accountExists: boolean;
  /** A password is available to the agent as the secret named here (never written into the task). */
  passwordAlias?: string;
  startUrl?: string;
  /** Steps and pages from the research. Hints only: the screen wins. */
  hints: string[];
  docs: string[];
  values: { first_name: string; last_name: string; company: string; app_name: string; workspace_name: string; redirect_uri: string; dev_url: string };
  scopes: string[];
  /** Fetch a token for API or DCR calls instead of creating the app (our code creates it with the token). */
  token?: { what: string; where?: string };
}

/**
 * Captchas and bot checks on test accounts. Browser Use's cloud browsers solve captchas server-side on
 * their own; the agent can't stop that. Decision (2026-11-15): allowed for test accounts, so the agent
 * waits for the solver instead of stopping. PROVISION_CAPTCHA=handover makes every captcha a wall again
 * (the platform may still solve some before the agent sees them).
 */
export const captchaAllowed = () => (process.env.PROVISION_CAPTCHA || "allow_test").trim().toLowerCase() !== "handover";

function wallRule(): string {
  return captchaAllowed()
    ? `Captchas and bot checks: this is a test account and this browser solves them on its own; when one appears, wait up to 30 seconds for it to clear, then continue (submit again once if a form was rejected). Stop with status "wall" only when a step is MANDATORY and needs a phone number or payment details, or when a captcha or bot check still blocks you after waiting twice; say exactly which screen in "wall". Never invent a phone number, never enter payment details.`
    : `Stop with status "wall" only when a step is MANDATORY and needs a phone number, payment details, a captcha or a bot check that does not pass on its own within a few seconds; say exactly which screen in "wall". Never invent a phone number, never enter payment details, never try to solve or bypass a captcha.`;
}

export const RESULT_SHAPE = `{"status":"done"|"waiting_for_email"|"needs_totp"|"wall"|"failed","expects":"code"|"link"|null,"wall":string|null,"client_id":string|null,"client_secret":string|null,"api_key":string|null,"token":string|null,"refresh_token":string|null,"token_scheme":string|null,"totp_secret":string|null,"app_url":string|null,"notes":[string]}`;

/** Two-step verification: email when offered, else an authenticator app set up with a manual key we keep. */
export const MFA_RULE = `Two-step verification: if you must choose a verification method, choose email when it is offered. Otherwise choose an authenticator app ("Google Authenticator" or "other authenticator app"; not a push app such as Okta Verify, not SMS or a phone call). On the QR-code screen click "Can't scan?", "Enter key manually" or similar to show the text setup key, and STOP with status "needs_totp" with that key in "totp_secret" (keep the browser open; the next message gives you the codes). If you are later asked for an authenticator code, STOP with status "needs_totp" and totp_secret null. A code by text message or a mandatory push app is a wall.`;

/** Pure: the task for the first run of a job. Rules learned from the live tests are built in. */
export function agentTask(t: TaskInput): string {
  if (t.token) return tokenTask(t, t.token);
  const what = t.credential === "api_key" ? "an API key" : "an OAuth app (client ID and client secret)";
  const account = t.accountExists
    ? `An account for ${t.email} already exists: sign in (do not sign up).${t.passwordAlias ? ` Its password is the secret ${t.passwordAlias}.` : " If a password is asked for, use the email code or sign-in link option instead."}`
    : `Sign up for a free account with the email ${t.email}${t.passwordAlias ? ` and the password from the secret ${t.passwordAlias}` : " and a strong password you generate"}. Name: ${t.values.first_name} ${t.values.last_name}. Company or organization: ${t.values.company}. If asked for an age or birth date, give an adult one. If a workspace or organization must be created, name it ${t.values.workspace_name}.`;
  const app = t.credential === "api_key"
    ? `Create an API key named ${t.values.app_name}. Use the default workspace or project and the least privilege that still lets it read data.`
    : `Create an OAuth app named ${t.values.app_name} for a third-party integration (a user-authorized OAuth / "general" / "public" app, not a private or internal token). Redirect / callback URL: ${t.values.redirect_uri} (also add it to any allow list). Developer or company URL if asked: ${t.values.dev_url}. Scopes or permissions: ${t.scopes.length ? t.scopes.join(", ") : "the smallest read-only set offered"}. Save it.`;
  return [
    `Goal: get ${what} for ${t.app}, for testing an integration.`,
    `1. ${account}${t.startUrl ? ` Start at ${t.startUrl}.` : ""} Never use Google, Microsoft or other single sign-on.`,
    `2. ${app}`,
    `3. Open the page that shows the ${t.credential === "api_key" ? "API key" : "client ID and client secret"} (click reveal, show or copy if the secret is hidden; if it can only be regenerated, regenerate it once).`,
    t.hints.length ? `Hints from ${t.app}'s docs (may be out of date; trust the screen over these):\n${t.hints.slice(0, 10).map((h) => `- ${h}`).join("\n")}` : "",
    t.docs.length ? `Official pages: ${t.docs.slice(0, 5).join(" , ")}` : "",
    `Email: if ${t.app} sends a code or a sign-in link by email, STOP and answer with status "waiting_for_email" and expects "code" or "link". Keep the browser open; the next message gives you the code or link. A code from an authenticator app or a text message is NOT an email.`,
    MFA_RULE,
    `Rules: optional prompts with a Skip, Later or close button may be skipped (for example "add your phone number"). You may accept terms of service for this test account. ${wallRule()}`,
    `Secrets: put the ${t.credential === "api_key" ? "API key" : "client secret"} ONLY in its field of the final answer and never repeat it anywhere else (not in notes, not in your messages).`,
    `Final answer: JSON only, exactly this shape: ${RESULT_SHAPE}`,
  ].filter(Boolean).join("\n\n");
}

/**
 * Pure: the browser part of an API or DCR route. The agent only gets the token the API needs (Slack's app
 * configuration token, a DCR initial access token); our code then creates the app with it, and later runs
 * reuse the stored token with no browser.
 */
export function tokenTask(t: TaskInput, token: { what: string; where?: string }): string {
  const account = t.accountExists
    ? `An account for ${t.email} already exists: sign in (do not sign up).${t.passwordAlias ? ` Its password is the secret ${t.passwordAlias}.` : " If a password is asked for, use the email code or sign-in link option instead."}`
    : `Sign up for a free account with the email ${t.email}${t.passwordAlias ? ` and the password from the secret ${t.passwordAlias}` : " and a strong password you generate"}. Name: ${t.values.first_name} ${t.values.last_name}. Company or organization: ${t.values.company}. If asked for an age or birth date, give an adult one. If a workspace or organization must be created, name it ${t.values.workspace_name}.`;
  return [
    `Goal: get a token that ${t.app}'s API accepts, so our code can create an app through the API. Do NOT create an app yourself.`,
    `1. ${account}${t.startUrl ? ` Start at ${t.startUrl}.` : ""} Never use Google, Microsoft or other single sign-on.`,
    `2. Generate ${token.what}${token.where ? `. Where: ${token.where}` : ""}. If several workspaces or organizations are offered, use the one you created.`,
    `3. Return the token in "token". If a refresh token is shown with it, return it in "refresh_token". If the API expects a word before the token other than "Bearer" (for example "SSWS"), put that word in "token_scheme". Then answer with status "done".`,
    t.hints.length ? `Hints from ${t.app}'s docs (may be out of date; trust the screen over these):\n${t.hints.slice(0, 10).map((h) => `- ${h}`).join("\n")}` : "",
    t.docs.length ? `Official pages: ${t.docs.slice(0, 5).join(" , ")}` : "",
    `Email: if ${t.app} sends a code or a sign-in link by email, STOP and answer with status "waiting_for_email" and expects "code" or "link". Keep the browser open; the next message gives you the code or link. A code from an authenticator app or a text message is NOT an email.`,
    MFA_RULE,
    `Rules: optional prompts with a Skip, Later or close button may be skipped (for example "add your phone number"). You may accept terms of service for this test account. ${wallRule()}`,
    `Secrets: put the token and refresh token ONLY in their fields of the final answer and never repeat them anywhere else (not in notes, not in your messages).`,
    `Final answer: JSON only, exactly this shape: ${RESULT_SHAPE}`,
  ].filter(Boolean).join("\n\n");
}

/** Pure: the task for the next run in the same session, after our app handled what the agent stopped for. */
export function continueTask(base: string, why: { code?: string; link?: string; personHandled?: string; totp?: { from: string; to: string; code: string }[] }): string {
  const first = why.totp?.length ? `Authenticator codes, one per 30-second window (UTC): ${why.totp.map((c) => `${c.from}-${c.to} ${c.code}`).join("; ")}. Check the current UTC time (for example with \`date -u\`), enter the code for the current window on the screen that is open, and confirm. If it is rejected, wait for the next window and use the next code. Then continue.`
    : why.code ? `The code from the email is ${why.code}. Enter it on the screen that is open (it may be split over several boxes), then continue.`
    : why.link ? `Open this one-time link from the email in the same browser, then continue: ${why.link}`
    : `A person dealt with the screen you stopped at (${why.personHandled || "a wall"}). Continue from the page that is open now.`;
  return `${first}\n\nThe original task, for reference (skip what is already done):\n\n${base}`;
}

/** Pure: consent for verification, in the browser that is already signed in. */
export function consentTask(app: string, url: string, redirectUri: string, account?: { email: string; exists: boolean; passwordAlias?: string; first_name: string; last_name: string; company: string }): string {
  const signIn = !account
    ? `If asked, sign in with the same account (use the email code or link option if needed).`
    : account.exists
      ? `Sign in with ${account.email}${account.passwordAlias ? ` and the password from the secret ${account.passwordAlias}` : " using the email code or link option"}.`
      : `There is no ${app} account yet: on the sign-in page choose sign up, and create a free account with ${account.email}${account.passwordAlias ? ` and the password from the secret ${account.passwordAlias}` : " and a strong password you generate"} (name ${account.first_name} ${account.last_name}, company ${account.company}; skip optional prompts and onboarding). Never use Google or other single sign-on. Then come back to the authorization URL above if the sign-up does not return to it.`;
  return [
    `Open this ${app} authorization URL: ${url}`,
    `${signIn} If an email code or link is needed, STOP with status "waiting_for_email". ${MFA_RULE} If a workspace or organization must be chosen, choose the one you created. Approve / allow / authorize access for the app. ${wallRule()}`,
    `Stop as soon as the browser reaches ${redirectUri} (that page may say "Authorization received"). Do not copy the code from the address bar into your answer.`,
    `Final answer: JSON only, exactly this shape: ${RESULT_SHAPE}`,
  ].join("\n\n");
}

export interface AgentResult {
  status: "done" | "waiting_for_email" | "needs_totp" | "wall" | "failed";
  /** Authenticator setup key (base32 or an otpauth:// URI), when the agent set up two-step verification. */
  totpSecret?: string;
  /** A token for API or DCR calls (token tasks), its refresh token, and the word before it if not "Bearer". */
  token?: string;
  refreshToken?: string;
  tokenScheme?: string;
  expects?: "code" | "link";
  wall?: string;
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
  appUrl?: string;
  notes: string[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() && !/^(null|none|n\/a)$/i.test(v.trim()) ? v.trim() : undefined);

/** Pure: reads the agent's final answer. Anything unreadable is a failure, never a guess. */
export function parseAgentResult(text: string | null | undefined): AgentResult {
  const raw = String(text || "");
  const blocks = [...raw.matchAll(/\{[\s\S]*\}/g)].map((m) => m[0]);
  let j: Record<string, unknown> | null = null;
  for (const b of blocks.reverse()) { try { j = JSON.parse(b); break; } catch { /* try a shorter one */ } }
  if (!j) {
    const start = raw.lastIndexOf("{"), end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) { try { j = JSON.parse(raw.slice(start, end + 1)); } catch { /* none */ } }
  }
  if (!j) return { status: "failed", notes: [`The agent's answer wasn't JSON: ${raw.slice(0, 200)}`] };
  const notes = (Array.isArray(j.notes) ? j.notes : Array.isArray(j.stuck) ? j.stuck : []).map(String).slice(0, 8);
  const clientId = str(j.client_id), clientSecret = str(j.client_secret), apiKey = str(j.api_key);
  let status = String(j.status || "") as AgentResult["status"];
  if (!["done", "waiting_for_email", "needs_totp", "wall", "failed"].includes(status)) {
    status = j.waiting_for_email === true || j.on_code_screen === true ? "waiting_for_email" : clientId || apiKey || j.app_created === true || j.key_created === true ? "done" : str(j.wall) ? "wall" : "failed";
  }
  const expects = j.expects === "link" ? "link" : j.expects === "code" ? "code" : undefined;
  const token = str(j.token), refreshToken = str(j.refresh_token), tokenScheme = str(j.token_scheme);
  if (status === "failed" && token) status = "done";
  return { status, expects, wall: str(j.wall), clientId, clientSecret, apiKey, totpSecret: str(j.totp_secret), appUrl: str(j.app_url) || str(j.credentials_url), notes,
    ...(token ? { token } : {}), ...(refreshToken ? { refreshToken } : {}), ...(tokenScheme && /^[A-Za-z-]{2,20}$/.test(tokenScheme) ? { tokenScheme } : {}) };
}

/** The vendor hosts a credential may be typed on: the base domains of the plan's URLs. */
export function vendorDomains(urls: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    try { const h = new URL(String(u)).hostname; out.add(h); out.add(h.split(".").slice(-2).join(".")); } catch { /* not a URL */ }
  }
  return [...out].filter((h) => h.includes(".")).slice(0, 10);
}

/** Only full automation uses the hosted agent: human-in-the-loop keeps the person in our own live browser. */
export const usesHosted = (mode: Mode, configured = hostedConfigured()) => mode === "auto" && configured;

/** Scripted stand-in for tests and demo mode: each start returns the next scripted answer. */
export function mockHosted(script: string[]): HostedAgent & { tasks: string[] } {
  const tasks: string[] = [];
  let i = 0;
  return {
    tasks,
    async start({ task }) { tasks.push(task); i++; return { runId: `bu-run-${i}`, sessionId: "bu-session-1" }; },
    async get(runId) { const n = Number(runId.split("-").pop()); return { status: "completed", result: script[n - 1] ?? script[script.length - 1], error: null }; },
    async liveUrl() { return "https://live.browser-use.example/session"; },
  };
}

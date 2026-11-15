// The hosted browser agent route (Browser Use via Composio): our app writes the task, Browser Use
// drives the browser, our app handles email codes, walls, the vault and verification between runs.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRun, advance, respond, defaultDeps, withHostedSteps } from "../lib/provision/engine";
import { _resetRuns, attachCode } from "../lib/provision/runs";
import { _resetVault, getSecret } from "../lib/provision/vault";
import { _resetSandboxCache } from "../lib/provision/sandbox";
import { agentTask, continueTask, parseAgentResult, vendorDomains, browserUseViaComposio, type HostedAgent } from "../lib/provision/hosted";
import { findCode } from "../lib/provision/inbox";
import { validatePlaybook, PLAYBOOKS } from "../lib/provision/planner";
import type { Run } from "../lib/provision/types";

const BASE = "https://example.test";
beforeEach(() => { process.env.PROVISION_MOCK = "1"; delete process.env.SUPABASE_URL; delete process.env.GOOGLE_SHEET_ID; delete process.env.PROVISION_INBOX_ID; _resetRuns(); _resetVault(); _resetSandboxCache(); });

const SECRET = "lin_oauth_secret_DO_NOT_LOG_9f8e7d";
const done = (extra: Record<string, unknown> = {}) => JSON.stringify({ status: "done", expects: null, wall: null, client_id: "cid_123", client_secret: SECRET, api_key: null, app_url: "https://linear.app/x/settings/api/applications/1", notes: [], ...extra });

/** A scripted Browser Use: answers in order; the consent run "reaches" the callback like a real browser would. */
function scripted(answers: string[]): HostedAgent & { tasks: string[]; secrets: number } {
  const tasks: string[] = [];
  let n = 0, secrets = 0;
  const results = new Map<string, string>();
  return {
    tasks, get secrets() { return secrets; },
    async start({ task, secrets: s }) {
      tasks.push(task); n++; if (s?.length) secrets++;
      const id = `run-${n}`;
      const auth = task.match(/authorization URL: (\S+)/);
      if (auth) {
        await attachCode(new URL(auth[1]).searchParams.get("state")!, "auth-code-xyz");
        results.set(id, JSON.stringify({ status: "done", notes: [] }));
      } else results.set(id, answers.shift() ?? JSON.stringify({ status: "failed", notes: ["script ran out"] }));
      return { runId: id, sessionId: "session-1" };
    },
    async get(runId) { return { status: "completed", result: results.get(runId) ?? null, error: null }; },
    async liveUrl() { return "https://live.browser-use.example/s1"; },
  };
}

async function drive(id: string, deps: ReturnType<typeof defaultDeps>, stopOnPause = false): Promise<Run> {
  for (let i = 0; i < 40; i++) {
    const r = await advance(id, deps, 30_000);
    if (["verified", "needs_review", "failed", "cancelled"].includes(r.status)) return r;
    if (r.status === "waiting_human" || r.status === "waiting_approval") { if (stopOnPause) return r; assert.fail(`asked a person: ${r.pending?.reason}`); }
  }
  throw new Error("did not finish");
}

test("app name in: research, then Browser Use signs up; our app passes the email code and verifies", async () => {
  const agent = scripted([JSON.stringify({ status: "waiting_for_email", expects: "code", notes: [] }), done()]);
  const deps = { ...defaultDeps(), hosted: agent };
  const run = await createRun({ app: "Linear", baseUrl: BASE, autoStart: true }, deps);
  assert.deepEqual(run.steps.map((s) => s.kind), ["identity", "agent", "verify", "golive"]);
  assert.equal(run.assessment?.route.method, "Hosted browser agent");
  const end = await drive(run.id, deps);
  assert.equal(end.status, "verified", end.events.map((e) => e.text).join("\n"));
  assert.equal(end.public.clientId, "cid_123");
  assert.equal(await getSecret(end.vault.client_secret), SECRET);
  // Run 1: the task from the research. Run 2: the emailed code, same session. Run 3: OAuth consent.
  assert.equal(agent.tasks.length, 3);
  assert.match(agent.tasks[0], /Sign up for a free account with the email/);
  assert.match(agent.tasks[0], /redirect \/ callback URL: https:\/\/example\.test\/api\/oauth\/callback/i);
  assert.match(agent.tasks[1], /The code from the email is 482913/);
  assert.match(agent.tasks[2], /authorization URL/);
  // Secrets never reach our log, and the password never goes into a task's text.
  assert.ok(!end.events.some((e) => e.text.includes(SECRET)));
  const pw = await getSecret(end.vault.password);
  assert.ok(pw && !agent.tasks.some((t) => t.includes(pw)));
  assert.ok(agent.secrets >= 1, "the password goes as a bound secret");
  assert.ok(end.events.some((e) => /passed to the hosted agent/.test(e.text)));
  assert.equal(end.browser?.liveUrl, "https://live.browser-use.example/s1");
});

test("a mandatory wall goes to a person, then the agent carries on in the same browser", async () => {
  const agent = scripted([JSON.stringify({ status: "wall", wall: "phone verification is required to continue", notes: [] }), done()]);
  const deps = { ...defaultDeps(), hosted: agent };
  const run = await createRun({ app: "Linear", baseUrl: BASE, autoStart: true }, deps);
  const paused = await drive(run.id, deps, true);
  assert.equal(paused.status, "waiting_human");
  assert.match(paused.pending!.reason, /phone verification is required/);
  await respond(run.id, "continue");
  const end = await drive(run.id, deps);
  assert.equal(end.status, "verified");
  assert.match(agent.tasks[1], /A person dealt with the screen you stopped at \(phone verification is required to continue\)/);
});

test("created but the secret didn't come back: a person pastes it straight into the vault", async () => {
  const agent = scripted([done({ client_secret: null })]);
  const deps = { ...defaultDeps(), hosted: agent };
  const run = await createRun({ app: "Linear", baseUrl: BASE, autoStart: true }, deps);
  const paused = await drive(run.id, deps, true);
  assert.equal(paused.pending?.field?.into, "client_secret");
  await respond(run.id, "continue", "pasted_secret_123");
  const end = await drive(run.id, deps);
  assert.equal(end.status, "verified");
  assert.ok(!end.events.some((e) => e.text.includes("pasted_secret_123")));
});

test("human in the loop keeps our own live browser; only full automation uses the hosted agent", async () => {
  const deps = { ...defaultDeps(), hosted: scripted([]) };
  const run = await createRun({ app: "Linear", baseUrl: BASE, mode: "human" }, deps);
  assert.ok(!run.steps.some((s) => s.kind === "agent"));
  assert.ok(run.playbook.steps.human.some((s) => s.kind === "browser"));
});

test("hosted steps pass the plan checks; API-key plans too", () => {
  const p = withHostedSteps(PLAYBOOKS.linear);
  assert.deepEqual(validatePlaybook(p), []);
  const key = withHostedSteps({ ...PLAYBOOKS.linear, credential: "api_key", apiKey: { header: "Authorization", testUrl: "https://api.linear.app/graphql" } });
  assert.equal(key.steps.auto.find((s) => s.kind === "agent")?.title, "Sign up and create the API key (hosted browser agent)");
});

test("parseAgentResult reads the agent's JSON and never guesses", () => {
  assert.equal(parseAgentResult(done()).status, "done");
  assert.equal(parseAgentResult(done()).clientSecret, SECRET);
  assert.deepEqual(parseAgentResult('Here you go: {"status":"waiting_for_email","expects":"link"}'), { status: "waiting_for_email", expects: "link", wall: undefined, clientId: undefined, clientSecret: undefined, apiKey: undefined, appUrl: undefined, notes: [] });
  assert.equal(parseAgentResult('{"status":"wall","wall":"captcha"}').wall, "captcha");
  assert.equal(parseAgentResult("I could not do it").status, "failed");
  assert.equal(parseAgentResult(null).status, "failed");
  // The shapes used in the manual tests still read correctly.
  assert.equal(parseAgentResult('{"app_created":true,"client_id":"ydD","secret_visible":true,"credentials_url":"https://x"}').status, "done");
  assert.equal(parseAgentResult('{"on_code_screen":true,"code_boxes":6,"stuck":[]}').status, "waiting_for_email");
  assert.equal(parseAgentResult('{"client_secret":"null","status":"done"}').clientSecret, undefined);
});

test("the task carries the rules learned live and keeps secrets out", () => {
  const t = agentTask({ app: "Zoom", credential: "oauth", email: "a@agentmail.to", accountExists: false, passwordAlias: "account_password", startUrl: "https://zoom.us/signup", hints: ["Build App > General App"], docs: ["https://developers.zoom.us"], scopes: ["user:read:user"],
    values: { first_name: "Toolkit", last_name: "Agent", company: "Toolkit Test", app_name: "Zoom Toolkit Test", workspace_name: "ws", redirect_uri: "https://x.test/api/oauth/callback", dev_url: "https://x.test" } });
  assert.match(t, /optional prompts with a Skip/);
  assert.match(t, /add your phone number/);
  assert.match(t, /never try to solve or bypass a captcha/);
  assert.match(t, /secret account_password/);
  assert.match(t, /STOP and answer with status "waiting_for_email"/);
  assert.match(t, /user:read:user/);
  assert.match(continueTask(t, { link: "https://zoom.us/magic#abc" }), /^Open this one-time link/);
  const signin = agentTask({ app: "Zoom", credential: "api_key", email: "a@agentmail.to", accountExists: true, hints: [], docs: [], scopes: [], values: { first_name: "", last_name: "", company: "", app_name: "k", workspace_name: "", redirect_uri: "", dev_url: "" } });
  assert.match(signin, /already exists: sign in \(do not sign up\)/);
  assert.match(signin, /an API key/);
});

test("vendor domains for bound secrets are the vendor's own hosts", () => {
  assert.deepEqual(vendorDomains(["https://zoom.us/signup", "https://marketplace.zoom.us/x", "not a url"]), ["zoom.us", "marketplace.zoom.us"]);
});

test("codes in HTML-only mails are found, and CSS colours are not taken for codes", () => {
  const html = `<html><head><style>.a{color:#333333} .b{background:#ffffff}</style></head><body><p>Hi Toolkit Agent, We detected an unusual sign-in. Enter the code below to sign in to Zoom.</p><p>914131</p><p>The code will expire in 10 minutes.</p></body></html>`;
  assert.equal(findCode({ subject: "Code for signing in to Zoom", text: "", html }), "914131");
  assert.equal(findCode({ subject: "Login for Linear", text: "If you can't click on the link, you can also copy the verification code into your browser: 33KAW63S3M", html: "" }), "33KAW63S3M");
});

test("Composio calls: the right tool slugs and arguments, and the run id comes back", async () => {
  const calls: { slug: string; args: Record<string, unknown> }[] = [];
  const agent = browserUseViaComposio(async (slug, args) => {
    calls.push({ slug, args });
    if (slug === "BROWSER_USE_START_RUN") return { id: "r1.x", session_id: "s1.y", status: "queued" };
    if (slug === "BROWSER_USE_GET_RUN") return { run: { status: "completed", result: '{"status":"done"}', error: null } };
    return { items: [{ type: "browser.attached", data: { live_view_url: "https://live.browser-use.com?wss=x" } }] };
  });
  const s = await agent.start({ task: "t", sessionId: "s0", secrets: [{ alias: "account_password", value: "pw", domains: ["zoom.us"] }] });
  assert.deepEqual(s, { runId: "r1.x", sessionId: "s1.y" });
  assert.equal(calls[0].args.session_id, "s0");
  assert.equal(calls[0].args.max_cost_usd, 5);
  assert.deepEqual(calls[0].args.secret_bindings, [{ alias: "account_password", source: { type: "inline", value: "pw" }, allowedDomains: ["zoom.us"] }]);
  assert.equal((await agent.get("r1.x")).status, "completed");
  assert.equal(await agent.liveUrl("r1.x"), "https://live.browser-use.com?wss=x");
});

test("Composio MCP replies: SSE or JSON, shortened previews, and account problems stop the run", async () => {
  const { readMcpResult } = await import("../lib/provision/hosted");
  const wrap = (results: unknown) => `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results } }) }] } })}\n\n`;
  assert.deepEqual(readMcpResult("X", 200, wrap([{ response: { successful: true, data: { id: "r1" } } }])), { id: "r1" });
  assert.deepEqual(readMcpResult("X", 200, wrap([{ response: { successful: true, data_preview: { items: [1] } } }])), { items: [1] });
  assert.throws(() => readMcpResult("X", 200, wrap([{ error: "The user's Composio wallet is out of credits, so Instant calls are paused." }])), (e: Error) => e.name === "ConfigError");
  assert.throws(() => readMcpResult("X", 200, wrap([{ response: { successful: false, error: "bad run id" } }])), /bad run id/);
  assert.throws(() => readMcpResult("X", 200, "not json"), /unreadable reply/);
});

// A vendor with open Dynamic Client Registration and no hand-written playbook: research brief only.
const tdoIo = {
  research: async () => ({
    summary: "Free account for anyone.", relation: "same",
    developerAccount: { name: "Tdo account", selfServe: "yes", quotes: [] }, sandbox: { name: "Tdo account", selfServe: "yes", quotes: [] },
    oauthApp: { available: "self_serve", apiKeySelfServe: false, quotes: [] }, credentials: [{ type: "oauth2", selfServe: "yes" }],
    resources: { website: "tdo.example", docs: [{ label: "OAuth", url: "https://tdo.example/docs/oauth" }], steps: [{ title: "Sign up", detail: "Free plan", owner: "agent" }],
      oauth: { authorizeUrl: "https://tdo.example/oauth/authorize", tokenUrl: "https://tdo.example/oauth/token", identity: { url: "https://api.tdo.example/me", pick: "id" }, scopes: ["data:read"] } },
  }),
  pageText: async () => "", probe: async (u: string) => ({ url: u, signals: [], looks: "signup_form" as const }),
};
const tdoMeta = async (u: string) => (u === "https://tdo.example/.well-known/oauth-authorization-server"
  ? { issuer: "https://tdo.example", authorization_endpoint: "https://tdo.example/oauth/authorize", token_endpoint: "https://tdo.example/oauth/token", registration_endpoint: "https://tdo.example/oauth/register" } : null);

test("DCR vendor: no planning call; registered by API, then the hosted browser signs up and approves consent", async () => {
  const agent = scripted([]);
  const deps = { ...defaultDeps(), hosted: agent, sandboxIo: tdoIo as never, dcrFetch: tdoMeta };
  const run = await createRun({ app: "Tdo", baseUrl: BASE, autoStart: true }, deps);
  assert.equal(run.strategy, "dcr");
  assert.ok(run.playbook.notes?.some((n) => /no model call/.test(n)));
  assert.deepEqual(run.steps.map((s) => s.id).filter((id) => id !== "sandbox-check"), ["dcr-register", "identity", "verify"]);
  const end = await drive(run.id, deps);
  assert.equal(end.status, "verified", end.events.map((e) => e.text).join("\n"));
  assert.ok(end.vault.client_secret);
  assert.equal(agent.tasks.length, 1);
  assert.match(agent.tasks[0], /There is no Tdo account yet: on the sign-in page choose sign up/);
  assert.match(agent.tasks[0], /secret account_password/);
});

test("human in the loop on a brief-built plan: its steps are planned only when that mode is picked", async () => {
  const { startRun } = await import("../lib/provision/engine");
  const deps = { ...defaultDeps(), hosted: scripted([]), sandboxIo: tdoIo as never, dcrFetch: tdoMeta };
  const run = await createRun({ app: "Tdo", baseUrl: BASE }, deps);
  assert.equal(run.status, "ready");
  assert.equal(run.playbook.humanPlanPending, true);
  const started = await startRun(run.id, "human", deps);
  assert.equal(started.playbook.humanPlanPending, false);
  assert.ok(!started.steps.some((s) => s.id === "plan-later"));
  assert.ok(started.steps.some((s) => s.kind === "verify"));
});
